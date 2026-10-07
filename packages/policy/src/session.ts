import { bytesToHex, getAddress, isAddress } from 'viem';
import { policyCommitment } from './commitment.js';
import { SessionError } from './errors.js';
import { normalizePolicy } from './normalize.js';
import type { Address, Hex, Policy, PolicyInput } from './types.js';

// ============================================================================
// Multi-session lifecycle: issue / revoke / rotate.
//
// A *session* is one named authorization grant on an account: a policy, its
// commitment, and lifecycle metadata. An account may hold many concurrent
// sessions — the model that fixes "one account, one session" (the consumer
// plan, §7.3). Each session is an immutable record: a transition writes a *new*
// record (revoke stamps `revokedAt`; rotate links `rotatedFrom` / `rotatedTo`),
// so history is append-only and never rewritten.
//
// The record carries **no key material**. A session references a policy, not a
// private key; key custody is the caller's concern (KMS or the client). Keel
// never persists a signing key — the fix for the "plaintext session key in the
// database" hardfinding called out in §6.3.
//
// The store is an interface, async so a Postgres-backed implementation is a
// drop-in; {@link InMemorySessionStore} is the minimal reference. It has no
// tenancy dimension: a self-hoster deploys one Keel stack per product, so a
// `product` key would be a SaaS assumption (see §6.3).
// ============================================================================

/** Lifecycle state of a session at a given time, derived from its record. */
export type SessionStatus = 'pending' | 'active' | 'expired' | 'revoked';

/** One authorization grant on an account. */
export interface Session {
  /** Unique bytes32 identifier (random unless supplied at issue time). */
  readonly id: Hex;
  /** Smart account the grant applies to (lower-cased). */
  readonly account: Address;
  /** The normalised policy this session grants. */
  readonly policy: Policy;
  /** `keccak256(encodePolicy(policy))` — the value the on-chain carrier stores. */
  readonly commitment: Hex;
  /** Unix seconds the session record was created. */
  readonly createdAt: bigint;
  /** Unix seconds the session was revoked; absent while it has not been. */
  readonly revokedAt?: bigint;
  /** Id of the session this one replaced, when created by a rotation. */
  readonly rotatedFrom?: Hex;
  /** Id of the session that replaced this one, when revoked by a rotation. */
  readonly rotatedTo?: Hex;
}

/** A session together with its status at a given time. */
export interface SessionView extends Session {
  readonly status: SessionStatus;
}

/**
 * Persistence port for sessions. Async by design so a database-backed store can
 * implement it directly; {@link InMemorySessionStore} is the reference.
 */
export interface SessionStore {
  /** Inserts or replaces the record for `session.id`. */
  save(session: Session): Promise<void>;
  /** The record for `id`, or `undefined` when unknown. */
  get(id: Hex): Promise<Session | undefined>;
  /** Every session of `account`, in store order. */
  listByAccount(account: Address): Promise<readonly Session[]>;
}

/** Minimal in-memory {@link SessionStore}; not durable, intended for tests and single-process use. */
export class InMemorySessionStore implements SessionStore {
  readonly #sessions = new Map<Hex, Session>();

  async save(session: Session): Promise<void> {
    this.#sessions.set(session.id, session);
  }

  async get(id: Hex): Promise<Session | undefined> {
    return this.#sessions.get(id);
  }

  async listByAccount(account: Address): Promise<readonly Session[]> {
    const wanted = account.toLowerCase();
    return [...this.#sessions.values()].filter((session) => session.account === wanted);
  }
}

export interface IssueSessionInput {
  readonly account: Address;
  readonly policy: PolicyInput;
  /** Current unix time in seconds. */
  readonly now: bigint;
  /** Explicit bytes32 id; a random one is generated when omitted. */
  readonly id?: Hex;
}

export interface RotateSessionInput {
  /** Policy for the successor session; usually the same as the previous one. */
  readonly policy: PolicyInput;
  /** Current unix time in seconds. */
  readonly now: bigint;
  /** Explicit bytes32 id for the successor; a random one is generated when omitted. */
  readonly id?: Hex;
}

/** The pair of records a rotation produces. */
export interface Rotation {
  /** The predecessor, now revoked and linked forward. */
  readonly previous: Session;
  /** The successor, linked back to the predecessor. */
  readonly next: Session;
}

const SESSION_ID_PATTERN = /^0x[0-9a-fA-F]{64}$/;

// Minimal web-crypto surface, declared locally so the package needs neither the
// DOM lib nor @types/node. `crypto` is a global on Node >= 20 and in browsers.
declare const crypto: { getRandomValues<T extends ArrayBufferView>(array: T): T };

/** A fresh random bytes32 session id. */
export function createSessionId(): Hex {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

function normalizeSessionId(value: string): Hex {
  if (!SESSION_ID_PATTERN.test(value)) {
    throw new SessionError(`id: must be 32 bytes (0x + 64 hex), got "${value}"`);
  }
  return value.toLowerCase() as Hex;
}

function normalizeAccount(value: string): Address {
  if (!isAddress(value)) throw new SessionError(`account: invalid address "${value}"`);
  return getAddress(value).toLowerCase() as Address;
}

/**
 * Creates an active session for `input.account`.
 *
 * The policy is normalised (so the stored commitment is canonical) and the id
 * must be unused. Throws {@link SessionError} on a duplicate id or a bad
 * account, and {@link PolicyError} on a malformed policy.
 */
export async function issueSession(store: SessionStore, input: IssueSessionInput): Promise<Session> {
  const id = input.id === undefined ? createSessionId() : normalizeSessionId(input.id);
  if (await store.get(id)) throw new SessionError(`session ${id} already exists`);

  const account = normalizeAccount(input.account);
  const policy = normalizePolicy(input.policy);
  const session: Session = Object.freeze({
    id,
    account,
    policy,
    commitment: policyCommitment(policy),
    createdAt: input.now,
  });

  await store.save(session);
  return session;
}

/**
 * Revokes a session. The record is kept (append-only) with `revokedAt` set, so
 * a revocation is auditable and idempotent failures are explicit. Revoking an
 * already-revoked or unknown session throws {@link SessionError}.
 */
export async function revokeSession(store: SessionStore, id: Hex, now: bigint): Promise<Session> {
  const session = await store.get(id);
  if (!session) throw new SessionError(`session ${id} not found`);
  if (session.revokedAt !== undefined) throw new SessionError(`session ${id} is already revoked`);

  const revoked: Session = Object.freeze({ ...session, revokedAt: now });
  await store.save(revoked);
  return revoked;
}

/**
 * Rotates a session: issues a successor and revokes the predecessor in one
 * step, cross-linking the two. This is the off-chain half of the migration
 * "uninstall old module + invalidate nonce + install new" (the consumer repo's
 * plan, §7.5); the successor inherits the predecessor's account.
 */
export async function rotateSession(
  store: SessionStore,
  id: Hex,
  input: RotateSessionInput,
): Promise<Rotation> {
  const previous = await store.get(id);
  if (!previous) throw new SessionError(`session ${id} not found`);
  if (previous.revokedAt !== undefined) throw new SessionError(`session ${id} is already revoked`);

  const nextId = input.id === undefined ? createSessionId() : normalizeSessionId(input.id);
  if (nextId === id) throw new SessionError('a rotated session must have a new id');
  if (await store.get(nextId)) throw new SessionError(`session ${nextId} already exists`);

  const policy = normalizePolicy(input.policy);
  const next: Session = Object.freeze({
    id: nextId,
    account: previous.account,
    policy,
    commitment: policyCommitment(policy),
    createdAt: input.now,
    rotatedFrom: id,
  });
  const revoked: Session = Object.freeze({ ...previous, revokedAt: input.now, rotatedTo: nextId });

  // Persist the successor first: a crash between the two writes then leaves a
  // usable successor without a back-link, rather than a revoked original with
  // no replacement.
  await store.save(next);
  await store.save(revoked);
  return { previous: revoked, next };
}

/** Derives a session's status from its record at time `now`. */
export function sessionStatus(session: Session, now: bigint): SessionStatus {
  if (session.revokedAt !== undefined) return 'revoked';
  if (now < session.policy.validAfter) return 'pending';
  if (session.policy.validUntil !== 0n && now > session.policy.validUntil) return 'expired';
  return 'active';
}

/** Whether the session is usable at time `now` (its status is `active`). */
export function isSessionActive(session: Session, now: bigint): boolean {
  return sessionStatus(session, now) === 'active';
}

/** Lists an account's sessions with their status at `now`, in store order. */
export async function listSessions(
  store: SessionStore,
  account: Address,
  now: bigint,
): Promise<readonly SessionView[]> {
  const sessions = await store.listByAccount(normalizeAccount(account));
  return sessions.map((session) => Object.freeze({ ...session, status: sessionStatus(session, now) }));
}
