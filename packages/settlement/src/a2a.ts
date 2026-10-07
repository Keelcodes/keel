import {
  SettlementError,
  assertCaip2,
  type Caip2,
  type PaymentIntent,
  type SettlementReceipt,
} from './types.js';

/**
 * x402 Payments Extension for the Agent-to-Agent (A2A) protocol, v0.1
 * (https://github.com/google-a2a/a2a-x402).
 *
 * A2A carries payment state in the `metadata` of its `Message` objects under
 * `x402.payment.*` keys and layers a six-state payment machine on top of the
 * A2A task state. Keel models the transport-neutral part the extension fixes:
 * the metadata keys, the status machine, the data structures and the error
 * codes. The scheme-specific `PaymentPayload.payload` blob stays opaque.
 *
 * The v0.1 examples spell `network` as a bare name (`"base"`); Keel requires a
 * CAIP-2 id (`eip155:8453`) everywhere it carries a chain, and validates it on
 * the way in.
 */

export const A2A_X402_EXTENSION_URI = 'https://github.com/google-a2a/a2a-x402/v0.1';

/** Clients request extension activation and servers echo it back here. */
export const A2A_EXTENSIONS_HEADER = 'X-A2A-Extensions';

/** `Message.metadata` keys defined by the extension. */
export const A2A_METADATA_KEYS = {
  status: 'x402.payment.status',
  required: 'x402.payment.required',
  payload: 'x402.payment.payload',
  receipts: 'x402.payment.receipts',
  error: 'x402.payment.error',
} as const;

export type A2APaymentStatus =
  | 'payment-required'
  | 'payment-submitted'
  | 'payment-rejected'
  | 'payment-verified'
  | 'payment-completed'
  | 'payment-failed';

/**
 * Legal status transitions. The spec's diagram omits `payment-submitted →
 * payment-failed`, but §8 requires the server to report `payment-failed` when a
 * submitted payload fails verification, so that edge is allowed too.
 */
const A2A_TRANSITIONS: Readonly<Record<A2APaymentStatus, readonly A2APaymentStatus[]>> = {
  'payment-required': ['payment-rejected', 'payment-submitted'],
  'payment-submitted': ['payment-verified', 'payment-failed'],
  'payment-verified': ['payment-completed', 'payment-failed'],
  'payment-rejected': [],
  'payment-completed': [],
  'payment-failed': [],
};

export function isTerminalA2AStatus(status: A2APaymentStatus): boolean {
  return A2A_TRANSITIONS[status].length === 0;
}

export function canTransitionA2A(from: A2APaymentStatus, to: A2APaymentStatus): boolean {
  return A2A_TRANSITIONS[from].includes(to);
}

/** Guards a status change — an out-of-order status write is a protocol bug. */
export function assertA2ATransition(from: A2APaymentStatus, to: A2APaymentStatus): void {
  if (!canTransitionA2A(from, to)) {
    throw new SettlementError('invalid-transition', `A2A payment cannot go ${from} -> ${to}`);
  }
}

/** Error codes the extension defines for `x402.payment.error`. */
export const A2A_ERROR_CODES = [
  'INSUFFICIENT_FUNDS',
  'INVALID_SIGNATURE',
  'EXPIRED_PAYMENT',
  'DUPLICATE_NONCE',
  'NETWORK_MISMATCH',
  'INVALID_AMOUNT',
  'SETTLEMENT_FAILED',
] as const;

export type A2AErrorCode = (typeof A2A_ERROR_CODES)[number];

export function isA2AErrorCode(value: string): value is A2AErrorCode {
  return (A2A_ERROR_CODES as readonly string[]).includes(value);
}

/** One accepted payment option (`PaymentRequirements`). */
export interface A2APaymentRequirements {
  scheme: string;
  network: Caip2;
  asset: string;
  payTo: string;
  /** Atomic units, as a decimal string. */
  maxAmountRequired: string;
  resource?: string;
  description?: string;
  maxTimeoutSeconds?: number;
  extra?: Record<string, unknown>;
}

/** `x402PaymentRequiredResponse`, sent by the merchant in the task metadata. */
export interface A2APaymentRequiredResponse {
  x402Version: number;
  accepts: A2APaymentRequirements[];
}

/** A signed payment authorization; `payload` is scheme-specific and opaque. */
export interface A2APaymentPayload {
  x402Version: number;
  network: string;
  scheme: string;
  payload: Record<string, unknown>;
}

/** `x402SettleResponse`, appended verbatim to `x402.payment.receipts`. */
export interface A2ASettleResponse {
  success: boolean;
  network: string;
  transaction?: string;
  payer?: string;
  errorReason?: string;
}

/** The decoded contents of a `Message.metadata` record, payment-wise. */
export interface A2APaymentMetadata {
  status: A2APaymentStatus;
  required?: A2APaymentRequiredResponse;
  payload?: A2APaymentPayload;
  receipts?: A2ASettleResponse[];
  error?: string;
}

const STATUS_VALUES = new Set<string>(Object.keys(A2A_TRANSITIONS));

function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SettlementError('malformed-payload', `${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new SettlementError('missing-field', `${field} must be a non-empty string`);
  }
  return value;
}

function requireInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new SettlementError('missing-field', `${field} must be an integer`);
  }
  return value;
}

function assertA2ARequirement(value: unknown, index: number): A2APaymentRequirements {
  const raw = requireObject(value, `accepts[${index}]`);
  const amount = requireString(raw['maxAmountRequired'], `accepts[${index}].maxAmountRequired`);
  if (!/^\d+$/.test(amount)) {
    throw new SettlementError(
      'malformed-payload',
      `accepts[${index}].maxAmountRequired must be atomic units, got ${amount}`,
    );
  }

  const requirement: A2APaymentRequirements = {
    scheme: requireString(raw['scheme'], `accepts[${index}].scheme`),
    network: assertCaip2(raw['network'], `accepts[${index}].network`),
    asset: requireString(raw['asset'], `accepts[${index}].asset`),
    payTo: requireString(raw['payTo'], `accepts[${index}].payTo`),
    maxAmountRequired: amount,
  };

  for (const field of ['resource', 'description'] as const) {
    const fieldValue = raw[field];
    if (fieldValue !== undefined) requirement[field] = requireString(fieldValue, `accepts[${index}].${field}`);
  }

  const timeout = raw['maxTimeoutSeconds'];
  if (timeout !== undefined) {
    if (typeof timeout !== 'number' || !Number.isFinite(timeout)) {
      throw new SettlementError('malformed-payload', `accepts[${index}].maxTimeoutSeconds must be a number`);
    }
    requirement.maxTimeoutSeconds = timeout;
  }

  const extra = raw['extra'];
  if (extra !== undefined) requirement.extra = requireObject(extra, `accepts[${index}].extra`);

  return requirement;
}

/** Parses an `x402PaymentRequiredResponse` (the `x402.payment.required` value). */
export function parsePaymentRequiredResponse(value: unknown): A2APaymentRequiredResponse {
  const raw = requireObject(value, 'x402PaymentRequiredResponse');
  const x402Version = requireInteger(raw['x402Version'], 'x402PaymentRequiredResponse.x402Version');
  const accepts = raw['accepts'];
  if (!Array.isArray(accepts) || accepts.length === 0) {
    throw new SettlementError('missing-field', 'x402PaymentRequiredResponse.accepts must be a non-empty array');
  }
  return { x402Version, accepts: accepts.map((entry, index) => assertA2ARequirement(entry, index)) };
}

/** Parses a `PaymentPayload` envelope; the scheme payload stays opaque. */
export function parsePaymentPayload(value: unknown): A2APaymentPayload {
  const raw = requireObject(value, 'PaymentPayload');
  return {
    x402Version: requireInteger(raw['x402Version'], 'PaymentPayload.x402Version'),
    network: requireString(raw['network'], 'PaymentPayload.network'),
    scheme: requireString(raw['scheme'], 'PaymentPayload.scheme'),
    payload: requireObject(raw['payload'], 'PaymentPayload.payload'),
  };
}

/** Parses an `x402SettleResponse` receipt. */
export function parseSettleResponse(value: unknown): A2ASettleResponse {
  const raw = requireObject(value, 'x402SettleResponse');
  if (typeof raw['success'] !== 'boolean') {
    throw new SettlementError('missing-field', 'x402SettleResponse.success must be a boolean');
  }
  const response: A2ASettleResponse = {
    success: raw['success'],
    network: requireString(raw['network'], 'x402SettleResponse.network'),
  };
  for (const field of ['transaction', 'payer', 'errorReason'] as const) {
    const fieldValue = raw[field];
    if (fieldValue !== undefined) {
      if (typeof fieldValue !== 'string') {
        throw new SettlementError('malformed-payload', `x402SettleResponse.${field} must be a string`);
      }
      response[field] = fieldValue;
    }
  }
  return response;
}

/** Reads the `x402.payment.*` keys out of a message metadata record. */
export function parsePaymentMetadata(metadata: Record<string, unknown>): A2APaymentMetadata {
  const status = metadata[A2A_METADATA_KEYS.status];
  if (status === undefined) {
    throw new SettlementError('missing-field', `${A2A_METADATA_KEYS.status} is required`);
  }
  if (typeof status !== 'string' || !STATUS_VALUES.has(status)) {
    throw new SettlementError('malformed-payload', `unknown A2A payment status ${JSON.stringify(status)}`);
  }

  const parsed: A2APaymentMetadata = { status: status as A2APaymentStatus };

  const required = metadata[A2A_METADATA_KEYS.required];
  if (required !== undefined) parsed.required = parsePaymentRequiredResponse(required);

  const payload = metadata[A2A_METADATA_KEYS.payload];
  if (payload !== undefined) parsed.payload = parsePaymentPayload(payload);

  const receipts = metadata[A2A_METADATA_KEYS.receipts];
  if (receipts !== undefined) {
    if (!Array.isArray(receipts)) {
      throw new SettlementError('malformed-payload', `${A2A_METADATA_KEYS.receipts} must be an array`);
    }
    parsed.receipts = receipts.map((entry) => parseSettleResponse(entry));
  }

  const error = metadata[A2A_METADATA_KEYS.error];
  if (error !== undefined) parsed.error = requireString(error, A2A_METADATA_KEYS.error);

  return parsed;
}

/** Serialises the payment fields back into a `Message.metadata` record. */
export function buildPaymentMetadata(entry: A2APaymentMetadata): Record<string, unknown> {
  const metadata: Record<string, unknown> = { [A2A_METADATA_KEYS.status]: entry.status };
  if (entry.required !== undefined) metadata[A2A_METADATA_KEYS.required] = entry.required;
  if (entry.payload !== undefined) metadata[A2A_METADATA_KEYS.payload] = entry.payload;
  if (entry.receipts !== undefined) metadata[A2A_METADATA_KEYS.receipts] = entry.receipts;
  if (entry.error !== undefined) metadata[A2A_METADATA_KEYS.error] = entry.error;
  return metadata;
}

export interface A2AIntentArgs {
  id: string;
  payer: string;
  reference?: string;
  /** Anchors `expiresAt` from `maxTimeoutSeconds` when both are present. */
  now?: Date;
}

/** Builds the client-side intent from the requirement the client accepted. */
export function a2aIntent(requirement: A2APaymentRequirements, args: A2AIntentArgs): PaymentIntent {
  const intent: PaymentIntent = {
    id: args.id,
    protocol: 'x402',
    network: requirement.network,
    asset: requirement.asset,
    amount: BigInt(requirement.maxAmountRequired),
    payer: args.payer,
    payee: requirement.payTo,
  };
  if (args.reference !== undefined) intent.reference = args.reference;
  if (args.now !== undefined && requirement.maxTimeoutSeconds !== undefined) {
    intent.expiresAt = new Date(args.now.getTime() + requirement.maxTimeoutSeconds * 1000).toISOString();
  }
  return intent;
}

/** The anti-tamper gate: a merchant may ask for any `payTo` it likes. */
export function verifyA2ARequirement(requirement: A2APaymentRequirements, intent: PaymentIntent): void {
  const mismatches: string[] = [];
  if (requirement.network !== intent.network) {
    mismatches.push(`network ${requirement.network} != ${intent.network}`);
  }
  if (requirement.asset.toLowerCase() !== intent.asset.toLowerCase()) {
    mismatches.push(`asset ${requirement.asset} != ${intent.asset}`);
  }
  if (requirement.payTo.toLowerCase() !== intent.payee.toLowerCase()) {
    mismatches.push(`payTo ${requirement.payTo} != ${intent.payee}`);
  }
  if (BigInt(requirement.maxAmountRequired) !== intent.amount) {
    mismatches.push(`maxAmountRequired ${requirement.maxAmountRequired} != ${intent.amount.toString()}`);
  }
  if (mismatches.length > 0) {
    throw new SettlementError(
      'requirement-mismatch',
      `offered requirement does not match intent ${intent.id}: ${mismatches.join('; ')}`,
    );
  }
}

export interface A2AReceiptArgs {
  intent: PaymentIntent;
  requirement: A2APaymentRequirements;
  response: A2ASettleResponse;
  /** ISO-8601 timestamp of settlement. */
  settledAt: string;
}

/** Turns a successful A2A settle response into a receipt, re-checking terms. */
export function receiptFromA2A(args: A2AReceiptArgs): SettlementReceipt {
  const { intent, requirement, response } = args;
  if (!response.success) {
    throw new SettlementError(
      'unsuccessful-settlement',
      `A2A settlement failed: ${response.errorReason ?? 'no reason given'}`,
    );
  }
  verifyA2ARequirement(requirement, intent);

  return {
    id: response.transaction ?? `${intent.id}@${args.settledAt}`,
    protocol: 'x402',
    network: intent.network,
    asset: intent.asset,
    amount: intent.amount,
    payer: response.payer ?? intent.payer,
    payee: intent.payee,
    transaction: response.transaction,
    settledAt: args.settledAt,
    intentId: intent.id,
    proof: { requirement, response },
  };
}
