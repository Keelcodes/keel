import { encodeAbiParameters, getAddress, isAddress, keccak256 } from 'viem';
import { EnvelopeError, PolicyError } from './errors.js';
import type { Address, Hex } from './types.js';

// ============================================================================
// ERC-8312 — Bounded Agent Actions (off-chain mirror).
//
// ERC-8312 defines a narrow on-chain *envelope*: a principal, an immutable
// capability commitment (`capabilityRoot`), a mutable aggregate-state
// commitment (`cursorRoot`), an expiry and a lifecycle status. The standard is
// deliberately explicit that the interface does **accounting, not enforcement**
// ("counting ≠ enforcing"): non-bypassability is a property of the *substrate*
// that owns the assets or gates the account's only execution path.
//
// This module is the off-chain half of Keel's substrate: it normalises and
// commits a capability, commits cursor state, applies the budget invariant
// `spent <= cap`, models the aggregate (delegated) profile's conservation rule,
// and drives the status state machine including contest/resolve. The on-chain
// registry recomputes the same commitments from the same canonical encodings,
// so the two layers cannot disagree about what a capability means.
//
// ERC-8312 leaves `capabilityRoot` opaque on purpose, so everything *inside*
// the capability below — the trust tier, the release gate, the approval set —
// is Keel's own profile, not a claim of standard conformance. What is standard
// is the envelope shape, the cursor, the budget profile (`spent <= cap`), the
// aggregate profile's conservation/attenuation rules, and the status machine.
// Aligned with the draft of 2026-05-09 (requires ERC-165); see
// docs/BOUNDED_ACTIONS.md for the exact revision this mirrors.
// ============================================================================

/** Schema version mixed into `capabilityRoot`, so a future profile change can never collide with an older one. */
export const CAPABILITY_VERSION = 1;

/**
 * Lifecycle status of an envelope, matching the standard's `Status` enum
 * (including `None`, the "unknown id" result of `getStatus`).
 */
export enum EnvelopeStatus {
  None = 0,
  Active = 1,
  Completed = 2,
  Contested = 3,
  Revoked = 4,
  Expired = 5,
}

/**
 * A committed label a consumer can require a minimum of (e.g. a target
 * contract that only accepts envelopes of tier >= 2). The standard treats
 * `capabilityRoot` as opaque; Keel fixes four ordered tiers so the label is
 * meaningful across the policy layer, the substrate and the manifest layer.
 */
export type TrustTier = 0 | 1 | 2 | 3;

/** An M-of-N approval set; `threshold` of `approvers` must sign before a release gate opens. */
export interface ApprovalInput {
  /** Number of approvals required; `0` means no approval gate. */
  threshold?: number;
  /** Distinct approver addresses. */
  approvers?: readonly Address[];
}

/** The bounded authority an envelope commits to, as authored. */
export interface CapabilityInput {
  /** Asset the budget is denominated in; the zero address means native value. */
  asset: Address;
  /** Budget ceiling for the whole envelope; `0` means no spend authority. */
  cap?: bigint;
  /** Ordered trust label consumers may require a minimum of; defaults to 0. */
  trustTier?: TrustTier;
  /** Unix seconds before which no draw may be released; `0` means immediately. */
  notBefore?: bigint;
  /** M-of-N gate that must be satisfied before any draw is released. */
  approvals?: ApprovalInput;
  /** Whether the envelope may delegate an attenuated child. */
  delegate?: boolean;
}

/** A fully-populated, hash-stable capability. */
export interface Capability {
  readonly version: number;
  readonly asset: Address;
  readonly cap: bigint;
  readonly trustTier: TrustTier;
  readonly notBefore: bigint;
  readonly approvals: { readonly threshold: number; readonly approvers: readonly Address[] };
  readonly delegate: boolean;
}

/** Running aggregate state committed by `cursorRoot`. */
export interface Cursor {
  /** Total amount drawn against the capability so far. */
  readonly spent: bigint;
  /** Number of draws, used for idempotency and telemetry. */
  readonly draws: number;
  /** Unix seconds of the most recent advance; `0` until the first draw. */
  readonly lastAdvance: bigint;
}

/** An on-chain envelope, as read from a registry. */
export interface Envelope {
  readonly id: Hex;
  readonly principal: Address;
  readonly capabilityRoot: Hex;
  readonly cursorRoot: Hex;
  readonly createdAt: bigint;
  readonly expiresAt: bigint;
  readonly status: EnvelopeStatus;
}

/** Cross-chain/same-chain reference to an envelope; the pair (registry, id) suffices on one chain. */
export interface EnvelopeRef {
  readonly chainId: bigint;
  readonly registry: Address;
  readonly id: Hex;
}

/** Why a draw was refused. */
export type DrawDenyReason =
  | 'envelope-not-active'
  | 'not-yet-released'
  | 'cap-exceeded'
  | 'approval-required'
  | 'trust-tier-too-low';

/** The context a draw is evaluated in. */
export interface DrawContext {
  /** Current unix time in seconds. */
  readonly now: bigint;
  /** Effective status of the envelope at `now`. */
  readonly status: EnvelopeStatus;
  /** Collected approvals (distinct approver addresses). */
  readonly approvals?: readonly Address[];
  /** Minimum trust tier the caller requires; defaults to 0. */
  readonly minTier?: TrustTier;
}

/** Result of a draw evaluation; `reason` is set only when `allowed` is false. */
export interface DrawDecision {
  readonly allowed: boolean;
  readonly reason?: DrawDenyReason;
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address;

function normalizeAddress(value: string, field: string): Address {
  if (!isAddress(value)) throw new PolicyError(`${field}: invalid address "${value}"`);
  return getAddress(value).toLowerCase() as Address;
}

function normalizeNonNegative(value: bigint, field: string): bigint {
  if (value < 0n) throw new PolicyError(`${field}: must be >= 0, got ${value}`);
  return value;
}

function normalizeTier(value: number | undefined, field: string): TrustTier {
  const tier = value ?? 0;
  if (!Number.isInteger(tier) || tier < 0 || tier > 3) {
    throw new PolicyError(`${field}: must be an integer 0..3, got ${tier}`);
  }
  return tier as TrustTier;
}

/**
 * Validates an authored capability and returns its normalised form. Addresses
 * are lower-cased and every optional field is filled with its default, so
 * semantically identical capabilities always commit to the same root.
 */
export function normalizeCapability(input: CapabilityInput): Capability {
  const asset = normalizeAddress(input.asset, 'asset');
  const cap = normalizeNonNegative(input.cap ?? 0n, 'cap');
  const trustTier = normalizeTier(input.trustTier, 'trustTier');
  const notBefore = normalizeNonNegative(input.notBefore ?? 0n, 'notBefore');

  const threshold = input.approvals?.threshold ?? 0;
  if (!Number.isInteger(threshold) || threshold < 0) {
    throw new PolicyError(`approvals.threshold: must be a non-negative integer, got ${threshold}`);
  }
  const approvers = (input.approvals?.approvers ?? []).map((value, i) =>
    normalizeAddress(value, `approvals.approvers[${i}]`),
  );
  if (new Set(approvers).size !== approvers.length) {
    throw new PolicyError('approvals.approvers: duplicate approver');
  }
  if (threshold > 0) {
    if (threshold > approvers.length) {
      throw new PolicyError(
        `approvals.threshold (${threshold}) exceeds approver count (${approvers.length})`,
      );
    }
  } else if (approvers.length > 0) {
    throw new PolicyError('approvals.approvers: configured with a zero threshold (dead config)');
  }

  return Object.freeze({
    version: CAPABILITY_VERSION,
    asset,
    cap,
    trustTier,
    notBefore,
    approvals: Object.freeze({ threshold, approvers: Object.freeze(approvers) }),
    delegate: input.delegate ?? false,
  });
}

// Canonical ABI shapes. The on-chain substrate re-encodes the same tuples, so
// the commitments below are byte-for-byte reproducible in Solidity.
const CAPABILITY_PARAMETERS = [
  { name: 'version', type: 'uint256' },
  { name: 'asset', type: 'address' },
  { name: 'cap', type: 'uint256' },
  { name: 'trustTier', type: 'uint8' },
  { name: 'notBefore', type: 'uint256' },
  { name: 'delegate', type: 'bool' },
  { name: 'threshold', type: 'uint256' },
  { name: 'approvers', type: 'address[]' },
] as const;

const CURSOR_PARAMETERS = [
  { name: 'spent', type: 'uint256' },
  { name: 'draws', type: 'uint256' },
  { name: 'lastAdvance', type: 'uint256' },
] as const;

/** Canonical ABI encoding of a normalised capability. */
export function encodeCapability(capability: Capability): Hex {
  return encodeAbiParameters(CAPABILITY_PARAMETERS, [
    BigInt(capability.version),
    capability.asset,
    capability.cap,
    BigInt(capability.trustTier),
    capability.notBefore,
    capability.delegate,
    BigInt(capability.approvals.threshold),
    [...capability.approvals.approvers],
  ] as never);
}

/** `capabilityRoot = keccak256(encodeCapability(capability))`. */
export function capabilityCommitment(capability: Capability): Hex {
  return keccak256(encodeCapability(capability));
}

/** Canonical ABI encoding of a cursor. */
export function encodeCursor(cursor: Cursor): Hex {
  return encodeAbiParameters(CURSOR_PARAMETERS, [
    cursor.spent,
    BigInt(cursor.draws),
    cursor.lastAdvance,
  ] as never);
}

/** `cursorRoot = keccak256(encodeCursor(cursor))`. */
export function cursorCommitment(cursor: Cursor): Hex {
  return keccak256(encodeCursor(cursor));
}

/** The cursor of an envelope that has never been drawn against. */
export const ZERO_CURSOR: Cursor = Object.freeze({ spent: 0n, draws: 0, lastAdvance: 0n });

/**
 * Deterministic envelope id, per the standard's recommended derivation
 * `keccak256(abi.encode(registry, principal, capabilityRoot, salt))`. A
 * registry may precompute it before registering so a reference can be embedded
 * upstream.
 */
export function envelopeId(params: {
  registry: Address;
  principal: Address;
  capabilityRoot: Hex;
  salt: Hex;
}): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { name: 'registry', type: 'address' },
        { name: 'principal', type: 'address' },
        { name: 'capabilityRoot', type: 'bytes32' },
        { name: 'salt', type: 'bytes32' },
      ],
      [
        normalizeAddress(params.registry, 'registry'),
        normalizeAddress(params.principal, 'principal'),
        params.capabilityRoot,
        params.salt,
      ] as never,
    ),
  );
}

/** Remaining headroom under a capability's cap. Never negative. */
export function remaining(capability: Capability, cursor: Cursor): bigint {
  return cursor.spent >= capability.cap ? 0n : capability.cap - cursor.spent;
}

/**
 * The budget invariant, `spent + amount <= cap`. Exposed separately so a
 * caller can check a prospective draw without constructing a full context.
 */
export function withinCap(capability: Capability, cursor: Cursor, amount: bigint): boolean {
  if (amount < 0n) return false;
  return cursor.spent + amount <= capability.cap;
}

/** Whether the collected approvals satisfy the capability's M-of-N gate. */
export function approvalsSatisfied(capability: Capability, approvals: readonly Address[]): boolean {
  const { threshold, approvers } = capability.approvals;
  if (threshold === 0) return true;
  const collected = new Set(approvals.map((value) => value.toLowerCase()));
  let seen = 0;
  for (const approver of approvers) if (collected.has(approver)) seen += 1;
  return seen >= threshold;
}

/**
 * Evaluates a prospective draw. Mirrors the on-chain substrate's gates in the
 * same order — status, release time, trust tier, approvals, then the budget
 * invariant — so an off-chain denial is never more permissive than the chain.
 */
export function canDraw(
  capability: Capability,
  cursor: Cursor,
  amount: bigint,
  context: DrawContext,
): DrawDecision {
  if (context.status !== EnvelopeStatus.Active) return { allowed: false, reason: 'envelope-not-active' };
  if (capability.notBefore > 0n && context.now < capability.notBefore) {
    return { allowed: false, reason: 'not-yet-released' };
  }
  if ((context.minTier ?? 0) > capability.trustTier) {
    return { allowed: false, reason: 'trust-tier-too-low' };
  }
  if (!approvalsSatisfied(capability, context.approvals ?? [])) {
    return { allowed: false, reason: 'approval-required' };
  }
  if (!withinCap(capability, cursor, amount)) return { allowed: false, reason: 'cap-exceeded' };
  return { allowed: true };
}

/**
 * Advances the cursor by one accepted draw. The caller must have obtained an
 * allowed {@link canDraw} first; this function does not re-check the cap.
 */
export function advanceCursor(cursor: Cursor, amount: bigint, now: bigint): Cursor {
  if (amount < 0n) throw new EnvelopeError(`amount: must be >= 0, got ${amount}`);
  return Object.freeze({
    spent: cursor.spent + amount,
    draws: cursor.draws + 1,
    lastAdvance: now,
  });
}

/** Derived status: an envelope past its expiry reads as `Expired` while it is not terminal. */
export function effectiveStatus(envelope: Envelope, now: bigint): EnvelopeStatus {
  if (envelope.status === EnvelopeStatus.Active && envelope.expiresAt !== 0n && now > envelope.expiresAt) {
    return EnvelopeStatus.Expired;
  }
  return envelope.status;
}

// ============================================================================
// Aggregate (delegated) profile.
//
// A root envelope can allocate sub-budgets to child envelopes. Two rules from
// the standard's aggregate profile are load-bearing and encoded here:
//   * conservation — the leaf allocations may not sum to more than the root
//     cap, so a tree can never conjure headroom it was not granted; and
//   * attenuation — a child's capability must be no wider than its parent's,
//     and an attenuated node cannot itself delegate.
// ============================================================================

/** Throws unless `allocations` sum to at most `rootCap` (conservation). */
export function assertConservation(rootCap: bigint, allocations: readonly bigint[]): void {
  let sum = 0n;
  for (const allocation of allocations) {
    if (allocation < 0n) throw new PolicyError(`allocation: must be >= 0, got ${allocation}`);
    sum += allocation;
  }
  if (sum > rootCap) {
    throw new PolicyError(`aggregate profile: allocations sum to ${sum} > root cap ${rootCap}`);
  }
}

/**
 * Derives an attenuated child capability from a parent.
 *
 * Narrowing only: the child's cap and trust tier may not exceed the parent's,
 * its release time may not be earlier, its approval gate may not be weaker
 * (threshold no lower, approvers a subset of the parent's) and its asset must
 * match. A parent that is not allowed to delegate (or is itself attenuated) may
 * not spawn a child at all. The child is always barred from delegating further,
 * which is what makes attenuation non-transitive widening impossible.
 */
export function attenuate(
  parent: Capability,
  child: CapabilityInput,
  options: { parentAttenuated?: boolean } = {},
): Capability {
  if (!parent.delegate || options.parentAttenuated) {
    throw new EnvelopeError('capability: this envelope may not delegate');
  }

  const next = normalizeCapability(child);
  if (next.asset !== parent.asset) throw new EnvelopeError('attenuation: asset must match the parent');
  if (next.cap > parent.cap) throw new EnvelopeError('attenuation: cap may not exceed the parent');
  if (next.trustTier > parent.trustTier) {
    throw new EnvelopeError('attenuation: trust tier may not exceed the parent');
  }
  if (next.notBefore < parent.notBefore) {
    throw new EnvelopeError('attenuation: release time may not be earlier than the parent');
  }
  if (next.approvals.threshold < parent.approvals.threshold) {
    throw new EnvelopeError('attenuation: approval gate may not be weaker than the parent');
  }
  // The gate is identity-based, so a non-weaker threshold is not enough: every
  // child approver must already be one of the parent's, or the delegate could
  // swap in an approver set of its own choosing.
  const parentApprovers = new Set(parent.approvals.approvers);
  for (const approver of next.approvals.approvers) {
    if (!parentApprovers.has(approver)) {
      throw new EnvelopeError('attenuation: approvers must be a subset of the parent');
    }
  }

  return normalizeCapability({ ...next, delegate: false });
}

// ============================================================================
// Status state machine.
//
// Active -> {Completed, Contested, Revoked, Expired}
// Contested -> {Active (dismissed), Revoked (upheld)}
// Completed / Revoked / Expired are terminal; None is the "unknown id" sink.
// ============================================================================

const TRANSITIONS: Readonly<Record<EnvelopeStatus, readonly EnvelopeStatus[]>> = Object.freeze({
  [EnvelopeStatus.None]: [],
  [EnvelopeStatus.Active]: [
    EnvelopeStatus.Completed,
    EnvelopeStatus.Contested,
    EnvelopeStatus.Revoked,
    EnvelopeStatus.Expired,
  ],
  [EnvelopeStatus.Contested]: [EnvelopeStatus.Active, EnvelopeStatus.Revoked],
  [EnvelopeStatus.Completed]: [],
  [EnvelopeStatus.Revoked]: [],
  [EnvelopeStatus.Expired]: [],
});

/** Whether `to` is a legal successor of `from`. */
export function canSetStatus(from: EnvelopeStatus, to: EnvelopeStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Applies a status transition, throwing {@link EnvelopeError} when it is illegal. */
export function applyStatus(envelope: Envelope, to: EnvelopeStatus): Envelope {
  if (!canSetStatus(envelope.status, to)) {
    throw new EnvelopeError(`status: illegal transition ${EnvelopeStatus[envelope.status]} -> ${EnvelopeStatus[to]}`);
  }
  return Object.freeze({ ...envelope, status: to });
}

/** Whether a status is terminal (no successor). */
export function isTerminal(status: EnvelopeStatus): boolean {
  return TRANSITIONS[status].length === 0 && status !== EnvelopeStatus.None;
}

/**
 * The contest window a challenge opens. Any party the substrate permits may
 * contest an Active envelope; once contested, resolution must land within the
 * window or any caller may resolve to the documented default (`Active`), which
 * stops an accused party from running out the clock to foreclose a verdict.
 */
export interface ContestWindow {
  /** Unix seconds the contest was opened. */
  readonly contestedAt: bigint;
  /** Unix seconds after which a default resolution is permitted. */
  readonly resolutionDeadline: bigint;
}

/** Opens a contest window of `windowSeconds` from `now`. */
export function openContest(now: bigint, windowSeconds: bigint): ContestWindow {
  if (windowSeconds <= 0n) throw new EnvelopeError('contest window must be > 0');
  return Object.freeze({ contestedAt: now, resolutionDeadline: now + windowSeconds });
}

/** Whether the window has elapsed at `now`, letting any caller resolve to the default. */
export function contestExpired(window: ContestWindow, now: bigint): boolean {
  return now > window.resolutionDeadline;
}

/** The documented default resolution: a still-open contest lapses back to Active. */
export function defaultResolution(): EnvelopeStatus {
  return EnvelopeStatus.Active;
}

export { ZERO_ADDRESS as ZERO_ASSET };
