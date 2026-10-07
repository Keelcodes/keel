// ============================================================================
// Keel policy model — account-agnostic authorization for agent accounts.
//
// A policy declares what an agent may do with an account: which targets it may
// call, which methods on them, and the value / frequency ceilings. The model
// deliberately contains **no account-specific encodings**: it is the same
// `Policy` whether it is later compiled to an ERC-7579 hook module, a 7710
// enforcer, or evaluated off-chain for a pre-check. That is what "account
// agnostic" means here (see docs/internal/KEEL_PLAN.md §4.4 ②).
//
// Fields are authored optionally ({@link PolicyInput}) and normalised to a
// fully-populated {@link Policy} before hashing, so semantically identical
// policies always produce the same commitment hash.
// ============================================================================

export type Address = `0x${string}`;
export type Hex = `0x${string}`;

/**
 * Schema version, mixed into the commitment hash so a future DSL change can
 * never silently produce a hash collision with an older, semantically
 * different policy.
 */
export const POLICY_VERSION = 1;

/**
 * Per-token ERC-20 ceiling, as authored. Keyed by the token contract, which is
 * also the call target: enforcing the cap requires reading the amount out of
 * the token's own `transfer` / `approve` call data.
 */
export interface TokenLimitInput {
  /** ERC-20 contract the cap applies to. */
  token: Address;
  /** Token amount ceiling for a single call; `0`/omitted means unlimited. */
  maxPerTx?: bigint;
  /** Token amount ceiling accumulated within a day; `0`/omitted means unlimited. */
  maxDaily?: bigint;
}

/** A rule scoped to one target contract, as authored. */
export interface PolicyRuleInput {
  /** Contract the agent may call. */
  target: Address;
  /** Allowed 4-byte selectors; omitted or empty means "any method on target". */
  selectors?: readonly Hex[];
  /** Native-value ceiling for a single call; `0`/omitted means unlimited. */
  maxPerTx?: bigint;
  /** Native-value ceiling accumulated within a day; `0`/omitted means unlimited. */
  maxDaily?: bigint;
  /** Maximum number of calls; `0`/omitted means unlimited. */
  maxCalls?: number;
  /** ERC-20 ceilings, one per token contract; each token may appear once. */
  tokenLimits?: readonly TokenLimitInput[];
}

/** A policy as authored. */
export interface PolicyInput {
  /** Unix seconds before which the policy is not valid; `0`/omitted = immediately. */
  validAfter?: bigint;
  /** Unix seconds after which the policy expires; `0`/omitted = never. */
  validUntil?: bigint;
  rules: readonly PolicyRuleInput[];
}

/** A per-token ERC-20 ceiling with every field populated (post-normalisation). */
export interface TokenLimit {
  readonly token: Address;
  readonly maxPerTx: bigint;
  readonly maxDaily: bigint;
}

/** A rule with every field populated (post-normalisation). */
export interface PolicyRule {
  readonly target: Address;
  readonly selectors: readonly Hex[];
  readonly maxPerTx: bigint;
  readonly maxDaily: bigint;
  readonly maxCalls: number;
  readonly tokenLimits: readonly TokenLimit[];
}

/** A normalised, hash-stable policy. */
export interface Policy {
  readonly version: number;
  readonly validAfter: bigint;
  readonly validUntil: bigint;
  readonly rules: readonly PolicyRule[];
}

/** A call an agent wants to make. */
export interface Call {
  readonly target: Address;
  /** Native value sent with the call. */
  readonly value: bigint;
  /** Call data; `0x` for a plain value transfer. */
  readonly data: Hex;
  /** 4-byte selector (first 4 bytes of `data`), or `0x` when there is no data. */
  readonly selector: Hex;
}

/**
 * Accrued usage for one rule, kept by the caller (off-chain) or by the on-chain
 * hook's accounting. `dailySpent` / `tokenSpent` must be reset by the caller
 * when the day window rolls over.
 */
export interface RuleUsage {
  readonly calls: number;
  /** Native value spent in the current day window. */
  readonly dailySpent: bigint;
  /** Per-token amount spent in the current day window, keyed by lower-cased token address. */
  readonly tokenSpent?: Readonly<Record<string, bigint>>;
}

/** Evaluation context: the current time plus per-rule usage, aligned to `policy.rules` by index. */
export interface PolicyState {
  /** Current unix time in seconds. */
  readonly now: bigint;
  /** Usage aligned to `policy.rules`; absent entries are treated as zero. */
  readonly usage: readonly RuleUsage[];
}

/** Why a call was denied. */
export type DenyReason =
  | 'not-yet-valid'
  | 'expired'
  | 'no-matching-rule'
  | 'value-per-tx-exceeded'
  | 'daily-limit-exceeded'
  | 'call-count-exceeded'
  | 'token-per-tx-exceeded'
  | 'token-daily-limit-exceeded'
  | 'token-transfer-from-blocked'
  | 'token-amount-unparsable';

export interface Decision {
  readonly allowed: boolean;
  /** Set when `allowed` is false. */
  readonly reason?: DenyReason;
  /**
   * Index of the rule that matched, when one did. On an allowed decision this
   * is the rule whose usage the caller must advance.
   */
  readonly ruleIndex?: number;
}
