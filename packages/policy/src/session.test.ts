import { describe, expect, it } from 'vitest';
import { policyCommitment } from './commitment.js';
import { PolicyError, SessionError } from './errors.js';
import { normalizePolicy } from './normalize.js';
import {
  InMemorySessionStore,
  createSessionId,
  isSessionActive,
  issueSession,
  listSessions,
  revokeSession,
  rotateSession,
  sessionStatus,
} from './session.js';
import type { Address, Hex, PolicyInput } from './types.js';

const ACCOUNT = '0x1111111111111111111111111111111111111111' as Address;
const OTHER_ACCOUNT = '0x2222222222222222222222222222222222222222' as Address;
const CHECKSUMMED_ACCOUNT = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as Address;
const TOKEN = '0x3333333333333333333333333333333333333333' as Address;
const ROUTER = '0x4444444444444444444444444444444444444444' as Address;
const TRANSFER = '0xa9059cbb' as Hex;

const sessionId = (prefix: string): Hex => `0x${prefix.padEnd(64, '0')}` as Hex;

const policyInput = (over: Partial<PolicyInput> = {}): PolicyInput => ({
  validAfter: 100n,
  validUntil: 1_000n,
  rules: [{ target: TOKEN, selectors: [TRANSFER], maxPerTx: 5n }],
  ...over,
});

describe('createSessionId', () => {
  it('returns a lower-case bytes32 hex string', () => {
    expect(createSessionId()).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('does not repeat', () => {
    expect(createSessionId()).not.toBe(createSessionId());
  });
});

describe('issueSession', () => {
  it('stores the normalised policy and its commitment', async () => {
    const store = new InMemorySessionStore();
    const session = await issueSession(store, { account: ACCOUNT, policy: policyInput(), now: 1n });

    expect(session.commitment).toBe(policyCommitment(normalizePolicy(policyInput())));
    expect(session.policy.validAfter).toBe(100n);
    expect(session.policy.rules[0]?.target).toBe(TOKEN);
    expect(session.createdAt).toBe(1n);
    expect(session.revokedAt).toBeUndefined();
  });

  it('lower-cases a checksummed account', async () => {
    const store = new InMemorySessionStore();
    const session = await issueSession(store, {
      account: CHECKSUMMED_ACCOUNT,
      policy: policyInput(),
      now: 1n,
    });
    expect(session.account).toBe('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48');
  });

  it('accepts an explicit id', async () => {
    const store = new InMemorySessionStore();
    const id = sessionId('aa');
    const session = await issueSession(store, { account: ACCOUNT, policy: policyInput(), now: 1n, id });
    expect(session.id).toBe(id);
    expect(await store.get(id)).toBe(session);
  });

  it('rejects a duplicate id', async () => {
    const store = new InMemorySessionStore();
    const id = sessionId('aa');
    await issueSession(store, { account: ACCOUNT, policy: policyInput(), now: 1n, id });
    await expect(
      issueSession(store, { account: ACCOUNT, policy: policyInput(), now: 2n, id }),
    ).rejects.toThrow(SessionError);
  });

  it('rejects a malformed id', async () => {
    const store = new InMemorySessionStore();
    await expect(
      issueSession(store, { account: ACCOUNT, policy: policyInput(), now: 1n, id: '0x1234' }),
    ).rejects.toThrow(SessionError);
  });

  it('rejects an invalid account', async () => {
    const store = new InMemorySessionStore();
    await expect(
      issueSession(store, { account: '0xnot-an-address', policy: policyInput(), now: 1n }),
    ).rejects.toThrow(SessionError);
  });

  it('propagates a malformed-policy error', async () => {
    const store = new InMemorySessionStore();
    await expect(
      issueSession(store, { account: ACCOUNT, policy: { rules: [] }, now: 1n }),
    ).rejects.toThrow(PolicyError);
  });

  it('lets many sessions coexist on one account', async () => {
    const store = new InMemorySessionStore();
    const a = await issueSession(store, { account: ACCOUNT, policy: policyInput(), now: 1n });
    const b = await issueSession(store, { account: ACCOUNT, policy: policyInput(), now: 2n });

    expect(a.id).not.toBe(b.id);
    // Same policy means the same commitment, but the sessions stay distinct.
    expect(a.commitment).toBe(b.commitment);
    expect(await listSessions(store, ACCOUNT, 500n)).toHaveLength(2);
  });
});

describe('revokeSession', () => {
  it('stamps revokedAt and keeps the record', async () => {
    const store = new InMemorySessionStore();
    const session = await issueSession(store, { account: ACCOUNT, policy: policyInput(), now: 1n });

    const revoked = await revokeSession(store, session.id, 500n);
    expect(revoked.revokedAt).toBe(500n);
    expect((await store.get(session.id))?.revokedAt).toBe(500n);
    expect(sessionStatus(revoked, 500n)).toBe('revoked');
  });

  it('rejects an unknown session', async () => {
    const store = new InMemorySessionStore();
    await expect(revokeSession(store, sessionId('bb'), 500n)).rejects.toThrow(SessionError);
  });

  it('rejects a double revoke', async () => {
    const store = new InMemorySessionStore();
    const session = await issueSession(store, { account: ACCOUNT, policy: policyInput(), now: 1n });
    await revokeSession(store, session.id, 500n);
    await expect(revokeSession(store, session.id, 600n)).rejects.toThrow(SessionError);
  });
});

describe('rotateSession', () => {
  it('issues a linked successor and revokes the predecessor', async () => {
    const store = new InMemorySessionStore();
    const a = await issueSession(store, { account: ACCOUNT, policy: policyInput(), now: 1n });

    const { previous, next } = await rotateSession(store, a.id, {
      policy: policyInput({ rules: [{ target: ROUTER }] }),
      now: 2n,
    });

    expect(previous.id).toBe(a.id);
    expect(previous.revokedAt).toBe(2n);
    expect(previous.rotatedTo).toBe(next.id);
    expect(next.rotatedFrom).toBe(a.id);
    expect(next.account).toBe(a.account);
    // The successor may grant a different policy (hence a new commitment).
    expect(next.commitment).not.toBe(a.commitment);
    expect((await store.get(a.id))?.rotatedTo).toBe(next.id);
  });

  it('rejects an unknown session', async () => {
    const store = new InMemorySessionStore();
    await expect(rotateSession(store, sessionId('cc'), { policy: policyInput(), now: 1n })).rejects.toThrow(
      SessionError,
    );
  });

  it('rejects rotating a revoked session', async () => {
    const store = new InMemorySessionStore();
    const a = await issueSession(store, { account: ACCOUNT, policy: policyInput(), now: 1n });
    await revokeSession(store, a.id, 2n);
    await expect(rotateSession(store, a.id, { policy: policyInput(), now: 3n })).rejects.toThrow(SessionError);
  });

  it('rejects reusing the predecessor id', async () => {
    const store = new InMemorySessionStore();
    const a = await issueSession(store, { account: ACCOUNT, policy: policyInput(), now: 1n });
    await expect(
      rotateSession(store, a.id, { policy: policyInput(), now: 2n, id: a.id }),
    ).rejects.toThrow(SessionError);
  });

  it('rejects a successor id that already exists', async () => {
    const store = new InMemorySessionStore();
    const a = await issueSession(store, { account: ACCOUNT, policy: policyInput(), now: 1n });
    const taken = await issueSession(store, { account: ACCOUNT, policy: policyInput(), now: 1n });
    await expect(
      rotateSession(store, a.id, { policy: policyInput(), now: 2n, id: taken.id }),
    ).rejects.toThrow(SessionError);
  });
});

describe('sessionStatus', () => {
  const issued = async (over: Partial<PolicyInput> = {}) => {
    const store = new InMemorySessionStore();
    return issueSession(store, { account: ACCOUNT, policy: policyInput(over), now: 0n });
  };

  it('is pending before validAfter', async () => {
    expect(sessionStatus(await issued(), 99n)).toBe('pending');
  });

  it('is active within the window', async () => {
    expect(sessionStatus(await issued(), 500n)).toBe('active');
  });

  it('is expired after validUntil', async () => {
    expect(sessionStatus(await issued(), 1_001n)).toBe('expired');
  });

  it('never expires when validUntil is zero', async () => {
    const session = await issued({ validUntil: 0n });
    expect(isSessionActive(session, 10n ** 12n)).toBe(true);
  });

  it('reports revoked even inside the window', async () => {
    const store = new InMemorySessionStore();
    const session = await issueSession(store, { account: ACCOUNT, policy: policyInput(), now: 0n });
    expect(sessionStatus(await revokeSession(store, session.id, 500n), 500n)).toBe('revoked');
  });
});

describe('listSessions', () => {
  it('returns each account its own sessions, with status', async () => {
    const store = new InMemorySessionStore();
    await issueSession(store, { account: ACCOUNT, policy: policyInput(), now: 0n });
    await issueSession(store, {
      account: ACCOUNT,
      policy: policyInput({ validAfter: 2_000n, validUntil: 3_000n }),
      now: 0n,
    });
    await issueSession(store, { account: OTHER_ACCOUNT, policy: policyInput(), now: 0n });

    const mine = await listSessions(store, ACCOUNT, 500n);
    expect(mine).toHaveLength(2);
    expect(mine.map((session) => session.status)).toEqual(['active', 'pending']);
    expect(await listSessions(store, OTHER_ACCOUNT, 500n)).toHaveLength(1);
  });

  it('is empty for an account with no sessions', async () => {
    const store = new InMemorySessionStore();
    expect(await listSessions(store, ACCOUNT, 0n)).toEqual([]);
  });
});
