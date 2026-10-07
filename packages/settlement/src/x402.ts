import { SettlementError, assertCaip2, type Caip2, type PaymentIntent } from './types.js';
import { decodeJsonPayload, encodeJsonPayload } from './wire.js';

/**
 * x402 v2 (https://docs.x402.org) — the HTTP 402 payment flow.
 *
 * Keel models the part of x402 the *core* spec fixes: the three headers, the
 * `PaymentRequired` requirements object, requirement selection, and the
 * anti-tamper check against a {@link PaymentIntent}. The scheme-specific
 * `PaymentPayload` a client puts in `PAYMENT-SIGNATURE` (EIP-3009 authorization,
 * permit, …) is opaque here and produced by the caller's scheme module — this
 * package does not invent it.
 */

export const X402_VERSION = 2;

/** HTTP header names used by x402 v2 (HTTP header lookup is case-insensitive). */
export const X402_HEADERS = {
  /** Server → client: base64 `PaymentRequired`. */
  required: 'PAYMENT-REQUIRED',
  /** Client → server: base64 `PaymentPayload` (scheme-specific). */
  signature: 'PAYMENT-SIGNATURE',
  /** Server → client: base64 `SettlementResponse`. */
  response: 'PAYMENT-RESPONSE',
} as const;

export interface X402Resource {
  url: string;
  description?: string;
  mimeType?: string;
}

export interface X402Requirements {
  /** e.g. `exact`. */
  scheme: string;
  network: Caip2;
  /** Atomic units, as a decimal string. */
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra?: Record<string, unknown>;
}

export interface X402PaymentRequired {
  x402Version: number;
  error?: string;
  resource: X402Resource;
  accepts: X402Requirements[];
  extensions?: Record<string, unknown>;
}

export interface X402SettlementResponse {
  success: boolean;
  transaction?: string;
  network?: string;
  payer?: string;
  errorReason?: string;
  extensions?: Record<string, unknown>;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new SettlementError('missing-field', `${field} must be a non-empty string`);
  }
  return value;
}

function assertRequirement(value: unknown, index: number): X402Requirements {
  if (typeof value !== 'object' || value === null) {
    throw new SettlementError('malformed-payload', `accepts[${index}] is not an object`);
  }
  const raw = value as Record<string, unknown>;
  const maxTimeoutSeconds = raw['maxTimeoutSeconds'];
  if (typeof maxTimeoutSeconds !== 'number' || !Number.isFinite(maxTimeoutSeconds)) {
    throw new SettlementError('missing-field', `accepts[${index}].maxTimeoutSeconds must be a number`);
  }
  const amount = requireString(raw['amount'], `accepts[${index}].amount`);
  if (!/^\d+$/.test(amount)) {
    throw new SettlementError('malformed-payload', `accepts[${index}].amount must be atomic units, got ${amount}`);
  }
  const requirement: X402Requirements = {
    scheme: requireString(raw['scheme'], `accepts[${index}].scheme`),
    network: assertCaip2(raw['network'], `accepts[${index}].network`),
    amount,
    asset: requireString(raw['asset'], `accepts[${index}].asset`),
    payTo: requireString(raw['payTo'], `accepts[${index}].payTo`),
    maxTimeoutSeconds,
  };
  const extra = raw['extra'];
  if (extra !== undefined) {
    if (typeof extra !== 'object' || extra === null) {
      throw new SettlementError('malformed-payload', `accepts[${index}].extra must be an object`);
    }
    requirement.extra = extra as Record<string, unknown>;
  }
  return requirement;
}

/** Parses a `PAYMENT-REQUIRED` header value. */
export function parsePaymentRequired(headerValue: string): X402PaymentRequired {
  const raw = decodeJsonPayload<Record<string, unknown>>(headerValue);

  if (raw['x402Version'] !== X402_VERSION) {
    throw new SettlementError(
      'unsupported-version',
      `expected x402Version ${X402_VERSION}, got ${JSON.stringify(raw['x402Version'])}`,
    );
  }

  const resource = raw['resource'];
  if (typeof resource !== 'object' || resource === null) {
    throw new SettlementError('missing-field', 'resource is required');
  }
  const resourceUrl = requireString((resource as Record<string, unknown>)['url'], 'resource.url');

  const accepts = raw['accepts'];
  if (!Array.isArray(accepts) || accepts.length === 0) {
    throw new SettlementError('missing-field', 'accepts must be a non-empty array');
  }

  const parsed: X402PaymentRequired = {
    x402Version: X402_VERSION,
    resource: { url: resourceUrl },
    accepts: accepts.map((entry, index) => assertRequirement(entry, index)),
  };

  const rawResource = resource as Record<string, unknown>;
  if (typeof rawResource['description'] === 'string') parsed.resource.description = rawResource['description'];
  if (typeof rawResource['mimeType'] === 'string') parsed.resource.mimeType = rawResource['mimeType'];
  if (typeof raw['error'] === 'string') parsed.error = raw['error'];
  if (typeof raw['extensions'] === 'object' && raw['extensions'] !== null) {
    parsed.extensions = raw['extensions'] as Record<string, unknown>;
  }
  return parsed;
}

/** Serialises a `PaymentRequired` object for the `PAYMENT-REQUIRED` header. */
export function formatPaymentRequired(value: X402PaymentRequired): string {
  return encodeJsonPayload(value);
}

/** Parses a `PAYMENT-RESPONSE` header value. */
export function parseSettlementResponse(headerValue: string): X402SettlementResponse {
  const raw = decodeJsonPayload<Record<string, unknown>>(headerValue);
  if (typeof raw['success'] !== 'boolean') {
    throw new SettlementError('missing-field', 'SettlementResponse.success must be a boolean');
  }
  const response: X402SettlementResponse = { success: raw['success'] };
  for (const field of ['transaction', 'network', 'payer', 'errorReason'] as const) {
    const fieldValue = raw[field];
    if (fieldValue !== undefined) {
      if (typeof fieldValue !== 'string') {
        throw new SettlementError('malformed-payload', `SettlementResponse.${field} must be a string`);
      }
      response[field] = fieldValue;
    }
  }
  if (typeof raw['extensions'] === 'object' && raw['extensions'] !== null) {
    response.extensions = raw['extensions'] as Record<string, unknown>;
  }
  return response;
}

/** Serialises a settlement response for the `PAYMENT-RESPONSE` header. */
export function formatSettlementResponse(value: X402SettlementResponse): string {
  return encodeJsonPayload(value);
}

/** Wraps a scheme-specific payment payload for the `PAYMENT-SIGNATURE` header. */
export function encodePaymentSignature(payload: unknown): string {
  return encodeJsonPayload(payload);
}

/** Unwraps a `PAYMENT-SIGNATURE` header value into the scheme payload. */
export function parsePaymentSignature(headerValue: string): unknown {
  return decodeJsonPayload<unknown>(headerValue);
}

export interface RequirementFilter {
  scheme?: string;
  network?: string;
  asset?: string;
  payTo?: string;
  /** Reject anything more expensive than this (atomic units). */
  maxAmount?: bigint;
}

function matches(requirement: X402Requirements, filter: RequirementFilter): boolean {
  if (filter.scheme !== undefined && requirement.scheme !== filter.scheme) return false;
  if (filter.network !== undefined && requirement.network !== filter.network) return false;
  if (
    filter.asset !== undefined &&
    requirement.asset.toLowerCase() !== filter.asset.toLowerCase()
  ) {
    return false;
  }
  if (filter.payTo !== undefined && requirement.payTo.toLowerCase() !== filter.payTo.toLowerCase()) {
    return false;
  }
  if (filter.maxAmount !== undefined && BigInt(requirement.amount) > filter.maxAmount) return false;
  return true;
}

/**
 * Picks the cheapest requirement the client can satisfy. Throws rather than
 * returning a "best effort" pick: silently paying a requirement you did not
 * choose is how an agent overpays.
 */
export function selectRequirement(
  accepts: readonly X402Requirements[],
  filter: RequirementFilter = {},
): X402Requirements {
  const eligible = accepts.filter((requirement) => matches(requirement, filter));
  if (eligible.length === 0) {
    throw new SettlementError(
      'no-acceptable-requirement',
      `no offered requirement satisfies ${JSON.stringify(filter, (_key, value) =>
        typeof value === 'bigint' ? value.toString() : value)}`,
    );
  }
  return eligible.reduce((cheapest, candidate) =>
    BigInt(candidate.amount) < BigInt(cheapest.amount) ? candidate : cheapest,
  );
}

/**
 * The anti-tamper gate: a server may return whatever `payTo`/`amount` it likes,
 * so what it asks for is only safe to act on once it matches the intent.
 */
export function verifyRequirement(requirement: X402Requirements, intent: PaymentIntent): void {
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
  if (BigInt(requirement.amount) !== intent.amount) {
    mismatches.push(`amount ${requirement.amount} != ${intent.amount.toString()}`);
  }
  if (mismatches.length > 0) {
    throw new SettlementError(
      'requirement-mismatch',
      `offered requirement does not match intent ${intent.id}: ${mismatches.join('; ')}`,
    );
  }
}

export interface IntentFromRequirementArgs {
  id: string;
  payer: string;
  reference?: string;
  /** Anchors `expiresAt` from `maxTimeoutSeconds`. */
  now?: Date;
}

/** Builds the client-side intent from the requirement the client agreed to. */
export function intentFromRequirement(
  requirement: X402Requirements,
  args: IntentFromRequirementArgs,
): PaymentIntent {
  const intent: PaymentIntent = {
    id: args.id,
    protocol: 'x402',
    network: requirement.network,
    asset: requirement.asset,
    amount: BigInt(requirement.amount),
    payer: args.payer,
    payee: requirement.payTo,
  };
  if (args.reference !== undefined) intent.reference = args.reference;
  if (args.now !== undefined) {
    intent.expiresAt = new Date(args.now.getTime() + requirement.maxTimeoutSeconds * 1000).toISOString();
  }
  return intent;
}
