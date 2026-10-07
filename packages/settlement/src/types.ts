/**
 * Which settlement rail a record belongs to. `x402`, `mpp` and `erc8183` are
 * wire protocols; `chain` (an on-chain stablecoin transfer) and `fiat` (a
 * hosted checkout) are rail kinds with no Keel codec of their own.
 */
export type Protocol = 'x402' | 'mpp' | 'erc8183' | 'chain' | 'fiat';

/** CAIP-2 chain identifier, e.g. `eip155:8453`. */
export type Caip2 = `${string}:${string}`;

export type SettlementErrorCode =
  | 'malformed-payload'
  | 'unsupported-version'
  | 'missing-field'
  | 'invalid-caip2'
  | 'no-acceptable-requirement'
  | 'requirement-mismatch'
  | 'unsuccessful-settlement'
  | 'duplicate-receipt'
  | 'unknown-intent'
  | 'invalid-transition'
  | 'unauthorized-actor'
  | 'precondition-failed';

export class SettlementError extends Error {
  readonly code: SettlementErrorCode;

  constructor(code: SettlementErrorCode, message: string) {
    super(message);
    this.name = 'SettlementError';
    this.code = code;
  }
}

/**
 * What the payer intends to pay, in protocol-neutral terms. This is the thing a
 * client verifies a server's payment requirements *against* — a server can hand
 * back any `payTo` it likes, so the intent is the anchor that catches it.
 */
export interface PaymentIntent {
  id: string;
  protocol: Protocol;
  network: Caip2;
  /** `native` or a token contract address. */
  asset: string;
  /** Atomic units (e.g. 10000 = 0.01 USDC at 6 decimals). */
  amount: bigint;
  payer: string;
  payee: string;
  /** Free-form resource/order reference. */
  reference?: string;
  /** ISO-8601 expiry, when the protocol carries one. */
  expiresAt?: string;
  metadata?: Record<string, unknown>;
}

export type IntentStatus = 'pending' | 'settled' | 'failed';

/**
 * Proof that a payment settled. `id` is stable and unique per settlement — the
 * on-chain transaction hash where the protocol provides one, and an
 * intent-scoped reference otherwise.
 */
export interface SettlementReceipt {
  id: string;
  protocol: Protocol;
  network: Caip2;
  asset: string;
  amount: bigint;
  payer: string;
  payee: string;
  transaction?: string;
  settledAt: string;
  intentId?: string;
  /** Protocol-specific proof, kept verbatim for audit. */
  proof?: Record<string, unknown>;
}

/** A signed value movement on the ledger: positive credits, negative debits. */
export interface LedgerEntry {
  account: string;
  network: string;
  asset: string;
  amount: bigint;
  reference?: string;
}

/**
 * The reconciliation ledger is an append-only event log; intent status and
 * balances are *derived* by folding it, never stored mutably.
 *
 * Whether a settled payment moves a balance is a billing concern and is
 * deliberately not modelled here — `entry` events are the only thing that
 * affects `balanceOf`.
 */
export type LedgerEvent =
  | { kind: 'intent'; at: string; intent: PaymentIntent }
  | { kind: 'receipt'; at: string; receipt: SettlementReceipt }
  | { kind: 'failure'; at: string; intentId: string; reason: string }
  | { kind: 'entry'; at: string; entry: LedgerEntry };

export interface Reconciliation {
  /** Intent ids with no receipt — expected money that never arrived. */
  unsettled: string[];
  /** Receipt ids with no matching intent — money from an unknown intent. */
  orphans: string[];
  /** Intent ids with more than one receipt — a possible double settlement. */
  doubleSettled: string[];
  ok: boolean;
}

const CAIP2 = /^[a-z0-9-]{3,8}:[a-zA-Z0-9-]{1,64}$/;

export function isCaip2(value: string): value is Caip2 {
  return CAIP2.test(value);
}

export function assertCaip2(value: unknown, field: string): Caip2 {
  if (typeof value !== 'string' || !isCaip2(value)) {
    throw new SettlementError('invalid-caip2', `${field} is not a CAIP-2 chain id: ${JSON.stringify(value)}`);
  }
  return value;
}
