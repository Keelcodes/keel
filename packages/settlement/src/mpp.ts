import { SettlementError, assertCaip2, type PaymentIntent } from './types.js';
import { authScheme, decodeJsonPayload, encodeJsonPayload, formatAuthHeader, parseAuthHeader } from './wire.js';

/**
 * MPP — the Machine Payments Protocol, i.e. the `Payment` HTTP authentication
 * scheme of IETF `draft-httpauth-payment-00` (Tempo Labs / Stripe).
 *
 * The core spec is payment-method agnostic: a challenge names a registered
 * payment method and carries a method-specific `request` blob. Keel therefore
 * models the *core* surface exactly — challenge, credential, status semantics —
 * and keeps `request` opaque, decoded by whichever method spec the caller
 * implements. Nothing method-specific is guessed at here.
 */

export const MPP_SCHEME = 'Payment';

/** Server → client, carries the receipt once payment is verified. */
export const MPP_RECEIPT_HEADER = 'Payment-Receipt';

/** Status codes from the draft's response table (draft §4.2). */
export const MPP_STATUS = {
  granted: 200,
  /** Payment barrier: fresh challenge, or a problem describing why it failed. */
  paymentRequired: 402,
  /** Payment was valid, but policy denies access — a fresh challenge would not help. */
  policyDenied: 403,
} as const;

/** Problem `code` values the draft defines for 402 responses. */
export type MppProblemCode = 'malformed-credential' | 'invalid-challenge' | 'verification-failed';

const REQUIRED_PARAMS = ['id', 'method', 'intent', 'request'] as const;

export interface MppChallenge {
  /** Challenge id; single-use, so a replay is rejected as `invalid-challenge`. */
  id: string;
  /** Registered payment method identifier. */
  method: string;
  /** Registered payment intent identifier, e.g. a one-time charge. */
  intent: string;
  /** base64url JSON, method-specific. Opaque to the core protocol. */
  request: string;
  /** Any further challenge parameters, preserved verbatim. */
  params?: Record<string, string>;
}

export type MppResponseKind = 'challenge' | 'granted' | 'policy-denied' | 'other';

/**
 * Classifies a response to a payment attempt.
 *
 * The distinction that matters: 403 means the payment *was* accepted but policy
 * denied access, so re-paying is pointless — only 402 is a retry signal.
 */
export function classifyMppResponse(status: number): MppResponseKind {
  if (status === MPP_STATUS.granted) return 'granted';
  if (status === MPP_STATUS.paymentRequired) return 'challenge';
  if (status === MPP_STATUS.policyDenied) return 'policy-denied';
  return 'other';
}

/** Parses a `WWW-Authenticate: Payment …` challenge. */
export function parseWwwAuthenticate(headerValue: string): MppChallenge {
  const scheme = authScheme(headerValue);
  if (scheme.toLowerCase() !== MPP_SCHEME.toLowerCase()) {
    throw new SettlementError(
      'malformed-payload',
      `expected the ${MPP_SCHEME} auth scheme, got ${JSON.stringify(scheme)}`,
    );
  }

  const { params } = parseAuthHeader(headerValue);

  const challenge: MppChallenge = {
    id: params['id'] ?? '',
    method: params['method'] ?? '',
    intent: params['intent'] ?? '',
    request: params['request'] ?? '',
  };
  for (const field of REQUIRED_PARAMS) {
    if (challenge[field] === '') {
      throw new SettlementError('missing-field', `Payment challenge is missing ${field}`);
    }
  }

  const extra = Object.entries(params).filter(
    ([name]) => !(REQUIRED_PARAMS as readonly string[]).includes(name),
  );
  if (extra.length > 0) {
    challenge.params = Object.fromEntries(extra);
  }
  return challenge;
}

/** Serialises a `WWW-Authenticate: Payment …` challenge. */
export function formatWwwAuthenticate(challenge: MppChallenge): string {
  return formatAuthHeader({
    scheme: MPP_SCHEME,
    params: {
      id: challenge.id,
      method: challenge.method,
      intent: challenge.intent,
      request: challenge.request,
      ...(challenge.params ?? {}),
    },
  });
}

/** Encodes a method-specific request blob for the `request` challenge param. */
export function encodeMppRequest(value: unknown): string {
  return encodeJsonPayload(value, { urlSafe: true });
}

/** Decodes the method-specific `request` blob using the caller's method spec. */
export function decodeMppRequest<T>(challenge: MppChallenge): T {
  return decodeJsonPayload<T>(challenge.request);
}

export interface MppIntentArgs {
  payer: string;
  payee: string;
  network: string;
  asset: string;
  amount: bigint;
  reference?: string;
  expiresAt?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Builds the client-side intent for a challenge. The value terms come from the
 * caller's method-specific decode of `request`; the challenge only supplies the
 * identity.
 */
export function mppIntent(challenge: MppChallenge, args: MppIntentArgs): PaymentIntent {
  const intent: PaymentIntent = {
    id: challenge.id,
    protocol: 'mpp',
    network: assertCaip2(args.network, 'network'),
    asset: args.asset,
    amount: args.amount,
    payer: args.payer,
    payee: args.payee,
  };
  if (args.reference !== undefined) intent.reference = args.reference;
  if (args.expiresAt !== undefined) intent.expiresAt = args.expiresAt;
  if (args.metadata !== undefined) intent.metadata = args.metadata;
  return intent;
}

/** Renders the `Authorization: Payment <token>` credential header. */
export function formatCredential(token: string): string {
  if (token.trim() === '') {
    throw new SettlementError('missing-field', 'payment credential token is empty');
  }
  return `${MPP_SCHEME} ${token}`;
}

export interface MppCredential {
  scheme: string;
  /** Method-specific proof, opaque to the core protocol. */
  token: string;
}

/** Parses an `Authorization: Payment <token>` credential header. */
export function parseCredential(headerValue: string): MppCredential {
  const trimmed = headerValue.trim();
  const separator = trimmed.indexOf(' ');
  const scheme = separator === -1 ? trimmed : trimmed.slice(0, separator);
  const token = separator === -1 ? '' : trimmed.slice(separator + 1).trim();

  if (scheme.toLowerCase() !== MPP_SCHEME.toLowerCase()) {
    throw new SettlementError(
      'malformed-payload',
      `expected the ${MPP_SCHEME} auth scheme, got ${JSON.stringify(scheme)}`,
    );
  }
  if (token === '') {
    throw new SettlementError('missing-field', 'payment credential token is empty');
  }
  return { scheme, token };
}
