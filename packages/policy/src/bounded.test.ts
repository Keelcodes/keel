import { describe, expect, it } from 'vitest';
import {
  CAPABILITY_VERSION,
  EnvelopeError,
  EnvelopeStatus,
  ZERO_CURSOR,
  advanceCursor,
  applyStatus,
  approvalsSatisfied,
  assertConservation,
  attenuate,
  canDraw,
  canSetStatus,
  capabilityCommitment,
  contestExpired,
  cursorCommitment,
  defaultResolution,
  effectiveStatus,
  envelopeId,
  isTerminal,
  normalizeCapability,
  openContest,
  remaining,
  withinCap,
} from './index.js';
import { PolicyError } from './errors.js';
import type { Address, Envelope, Hex } from './types.js';

const TOKEN = '0x1111111111111111111111111111111111111111' as Address;
const ALICE = '0x2222222222222222222222222222222222222222' as Address;
const BOB = '0x3333333333333333333333333333333333333333' as Address;
const CAROL = '0x4444444444444444444444444444444444444444' as Address;
const DAVE = '0x6666666666666666666666666666666666666666' as Address;
const REGISTRY = '0x5555555555555555555555555555555555555555' as Address;
const SALT = `0x${'00'.repeat(32)}` as Hex;
const CAPABILITY_ROOT = `0x${'ab'.repeat(32)}` as Hex;

function envelope(overrides: Partial<Envelope> = {}): Envelope {
  return {
    id: `0x${'01'.repeat(32)}` as Hex,
    principal: ALICE,
    capabilityRoot: CAPABILITY_ROOT,
    cursorRoot: cursorCommitment(ZERO_CURSOR),
    createdAt: 1_000n,
    expiresAt: 0n,
    status: EnvelopeStatus.Active,
    ...overrides,
  };
}

describe('normalizeCapability', () => {
  it('fills every optional field with its default', () => {
    const capability = normalizeCapability({ asset: TOKEN });
    expect(capability).toEqual({
      version: CAPABILITY_VERSION,
      asset: TOKEN,
      cap: 0n,
      trustTier: 0,
      notBefore: 0n,
      approvals: { threshold: 0, approvers: [] },
      delegate: false,
    });
  });

  it('lower-cases addresses and normalises the approval set', () => {
    const capability = normalizeCapability({
      asset: TOKEN.toUpperCase().replace('0X', '0x') as Address,
      cap: 100n,
      trustTier: 2,
      approvals: { threshold: 2, approvers: [ALICE, BOB] },
    });
    expect(capability.asset).toBe(TOKEN);
    expect(capability.approvals.approvers).toEqual([ALICE, BOB]);
  });

  it('rejects malformed input loudly', () => {
    expect(() => normalizeCapability({ asset: '0xnot-an-address' as Address })).toThrow(PolicyError);
    expect(() => normalizeCapability({ asset: TOKEN, cap: -1n })).toThrow(PolicyError);
    expect(() => normalizeCapability({ asset: TOKEN, trustTier: 4 as never })).toThrow(PolicyError);
    expect(() =>
      normalizeCapability({ asset: TOKEN, approvals: { threshold: 2, approvers: [ALICE] } }),
    ).toThrow(PolicyError);
    expect(() => normalizeCapability({ asset: TOKEN, approvals: { approvers: [ALICE] } })).toThrow(
      PolicyError,
    );
    expect(() =>
      normalizeCapability({ asset: TOKEN, approvals: { threshold: 2, approvers: [ALICE, ALICE] } }),
    ).toThrow(PolicyError);
  });
});

describe('commitments', () => {
  it('is deterministic regardless of how defaults are spelled', () => {
    const sparse = normalizeCapability({ asset: TOKEN });
    const spelled = normalizeCapability({ asset: TOKEN, cap: 0n, trustTier: 0, notBefore: 0n });
    expect(capabilityCommitment(sparse)).toBe(capabilityCommitment(spelled));
  });

  it('changes when the capability meaning changes', () => {
    const base = normalizeCapability({ asset: TOKEN, cap: 100n });
    const higher = normalizeCapability({ asset: TOKEN, cap: 101n });
    expect(capabilityCommitment(base)).not.toBe(capabilityCommitment(higher));
  });

  it('commits the cursor and treats the zero cursor as canonical', () => {
    expect(cursorCommitment(ZERO_CURSOR)).toBe(cursorCommitment({ spent: 0n, draws: 0, lastAdvance: 0n }));
    expect(cursorCommitment(advanceCursor(ZERO_CURSOR, 1n, 5n))).not.toBe(cursorCommitment(ZERO_CURSOR));
  });

  it('derives a deterministic envelope id, ignoring address case', () => {
    const id = envelopeId({ registry: REGISTRY, principal: ALICE, capabilityRoot: CAPABILITY_ROOT, salt: SALT });
    const same = envelopeId({
      registry: REGISTRY.toUpperCase().replace('0X', '0x') as Address,
      principal: ALICE,
      capabilityRoot: CAPABILITY_ROOT,
      salt: SALT,
    });
    expect(id).toBe(same);
  });
});

describe('budget profile', () => {
  const capability = normalizeCapability({ asset: TOKEN, cap: 100n });

  it('keeps spent <= cap and reports remaining headroom', () => {
    expect(withinCap(capability, ZERO_CURSOR, 100n)).toBe(true);
    expect(withinCap(capability, ZERO_CURSOR, 101n)).toBe(false);
    expect(remaining(capability, ZERO_CURSOR)).toBe(100n);
    expect(remaining(capability, { spent: 60n, draws: 1, lastAdvance: 1n })).toBe(40n);
    expect(remaining(capability, { spent: 500n, draws: 1, lastAdvance: 1n })).toBe(0n);
  });

  it('advances the cursor immutably', () => {
    const next = advanceCursor(ZERO_CURSOR, 40n, 7n);
    expect(next).toEqual({ spent: 40n, draws: 1, lastAdvance: 7n });
    expect(ZERO_CURSOR).toEqual({ spent: 0n, draws: 0, lastAdvance: 0n });
    expect(() => advanceCursor(ZERO_CURSOR, -1n, 0n)).toThrow(EnvelopeError);
  });
});

describe('canDraw', () => {
  const capability = normalizeCapability({ asset: TOKEN, cap: 100n, trustTier: 2 });
  const active = { now: 10n, status: EnvelopeStatus.Active };

  it('allows a draw within the cap', () => {
    expect(canDraw(capability, ZERO_CURSOR, 100n, active)).toEqual({ allowed: true });
  });

  it('gates in order: status, release time, tier, approvals, cap', () => {
    expect(canDraw(capability, ZERO_CURSOR, 1n, { now: 10n, status: EnvelopeStatus.Contested })).toEqual({
      allowed: false,
      reason: 'envelope-not-active',
    });

    const gated = normalizeCapability({ asset: TOKEN, cap: 100n, notBefore: 50n });
    expect(canDraw(gated, ZERO_CURSOR, 1n, active).reason).toBe('not-yet-released');
    expect(canDraw(gated, ZERO_CURSOR, 1n, { now: 50n, status: EnvelopeStatus.Active })).toEqual({
      allowed: true,
    });

    expect(canDraw(capability, ZERO_CURSOR, 1n, { ...active, minTier: 3 }).reason).toBe('trust-tier-too-low');

    const multi = normalizeCapability({
      asset: TOKEN,
      cap: 100n,
      approvals: { threshold: 2, approvers: [ALICE, BOB, CAROL] },
    });
    expect(canDraw(multi, ZERO_CURSOR, 1n, active).reason).toBe('approval-required');
    expect(canDraw(multi, ZERO_CURSOR, 1n, { ...active, approvals: [ALICE] }).reason).toBe('approval-required');
    expect(canDraw(multi, ZERO_CURSOR, 1n, { ...active, approvals: [ALICE, BOB] })).toEqual({
      allowed: true,
    });

    expect(canDraw(capability, { spent: 100n, draws: 1, lastAdvance: 1n }, 0n, active)).toEqual({
      allowed: true,
    });
    expect(canDraw(capability, { spent: 100n, draws: 1, lastAdvance: 1n }, 1n, active).reason).toBe(
      'cap-exceeded',
    );
  });

  it('counts an M-of-N approval set correctly', () => {
    const multi = normalizeCapability({
      asset: TOKEN,
      cap: 100n,
      approvals: { threshold: 2, approvers: [ALICE, BOB, CAROL] },
    });
    expect(approvalsSatisfied(multi, [])).toBe(false);
    expect(approvalsSatisfied(multi, [BOB, ALICE])).toBe(true);
    expect(approvalsSatisfied(multi, [BOB, BOB, ALICE])).toBe(true);
    expect(approvalsSatisfied(normalizeCapability({ asset: TOKEN }), [])).toBe(true);
  });
});

describe('expiry', () => {
  it('reads an expired envelope as Expired without mutating it', () => {
    const live = envelope({ expiresAt: 100n });
    expect(effectiveStatus(live, 50n)).toBe(EnvelopeStatus.Active);
    expect(effectiveStatus(live, 101n)).toBe(EnvelopeStatus.Expired);
    expect(envelope({ expiresAt: 0n }).status).toBe(EnvelopeStatus.Active);
    expect(effectiveStatus(envelope({ expiresAt: 0n }), 10n ** 18n)).toBe(EnvelopeStatus.Active);
  });
});

describe('aggregate profile', () => {
  it('enforces conservation of the root cap', () => {
    expect(() => assertConservation(100n, [40n, 60n])).not.toThrow();
    expect(() => assertConservation(100n, [40n, 61n])).toThrow(PolicyError);
    expect(() => assertConservation(100n, [-1n])).toThrow(PolicyError);
  });

  it('narrows on attenuation and forbids widening', () => {
    const parent = normalizeCapability({ asset: TOKEN, cap: 100n, trustTier: 2, delegate: true });
    const child = attenuate(parent, { asset: TOKEN, cap: 40n, trustTier: 1 });
    expect(child.cap).toBe(40n);
    expect(child.delegate).toBe(false);

    expect(() => attenuate(parent, { asset: TOKEN, cap: 101n })).toThrow(EnvelopeError);
    expect(() => attenuate(parent, { asset: TOKEN, trustTier: 3 })).toThrow(EnvelopeError);
    expect(() => attenuate(parent, { asset: ALICE, cap: 1n })).toThrow(EnvelopeError);
  });

  it('forbids delegation from a non-delegable or already-attenuated node', () => {
    const noDelegate = normalizeCapability({ asset: TOKEN, cap: 100n });
    expect(() => attenuate(noDelegate, { asset: TOKEN, cap: 1n })).toThrow(EnvelopeError);

    const parent = normalizeCapability({ asset: TOKEN, cap: 100n, delegate: true });
    const child = attenuate(parent, { asset: TOKEN, cap: 10n });
    expect(() => attenuate(child, { asset: TOKEN, cap: 5n })).toThrow(EnvelopeError);
    expect(() => attenuate(parent, { asset: TOKEN, cap: 5n }, { parentAttenuated: true })).toThrow(
      EnvelopeError,
    );
  });

  it('does not allow a weaker release gate than the parent', () => {
    const parent = normalizeCapability({
      asset: TOKEN,
      cap: 100n,
      delegate: true,
      approvals: { threshold: 2, approvers: [ALICE, BOB] },
    });
    expect(() => attenuate(parent, { asset: TOKEN, cap: 50n })).toThrow(EnvelopeError);
    expect(() =>
      attenuate(parent, { asset: TOKEN, cap: 50n, approvals: { threshold: 2, approvers: [ALICE, BOB] } }),
    ).not.toThrow();
  });

  it("forbids a child from swapping in its own approver set", () => {
    const parent = normalizeCapability({
      asset: TOKEN,
      cap: 100n,
      delegate: true,
      approvals: { threshold: 2, approvers: [ALICE, BOB, CAROL] },
    });
    // A subset of the parent's approvers is narrower and allowed…
    expect(() =>
      attenuate(parent, { asset: TOKEN, cap: 50n, approvals: { threshold: 2, approvers: [ALICE, BOB] } }),
    ).not.toThrow();
    // …but an outsider is a widened, identity-swapped gate and is refused.
    expect(() =>
      attenuate(parent, { asset: TOKEN, cap: 50n, approvals: { threshold: 2, approvers: [ALICE, DAVE] } }),
    ).toThrow(EnvelopeError);
  });
});

describe('status machine', () => {
  it('permits the documented transitions only', () => {
    expect(canSetStatus(EnvelopeStatus.Active, EnvelopeStatus.Contested)).toBe(true);
    expect(canSetStatus(EnvelopeStatus.Active, EnvelopeStatus.Completed)).toBe(true);
    expect(canSetStatus(EnvelopeStatus.Contested, EnvelopeStatus.Active)).toBe(true);
    expect(canSetStatus(EnvelopeStatus.Contested, EnvelopeStatus.Revoked)).toBe(true);
    expect(canSetStatus(EnvelopeStatus.Revoked, EnvelopeStatus.Active)).toBe(false);
    expect(canSetStatus(EnvelopeStatus.Completed, EnvelopeStatus.Active)).toBe(false);
    expect(canSetStatus(EnvelopeStatus.None, EnvelopeStatus.Active)).toBe(false);
  });

  it('applies transitions immutably and rejects illegal ones', () => {
    const active = envelope();
    const contested = applyStatus(active, EnvelopeStatus.Contested);
    expect(contested.status).toBe(EnvelopeStatus.Contested);
    expect(active.status).toBe(EnvelopeStatus.Active);
    expect(() => applyStatus(contested, EnvelopeStatus.Completed)).toThrow(EnvelopeError);
    expect(applyStatus(contested, EnvelopeStatus.Revoked).status).toBe(EnvelopeStatus.Revoked);
  });

  it('marks only Completed / Revoked / Expired terminal', () => {
    expect(isTerminal(EnvelopeStatus.Completed)).toBe(true);
    expect(isTerminal(EnvelopeStatus.Revoked)).toBe(true);
    expect(isTerminal(EnvelopeStatus.Expired)).toBe(true);
    expect(isTerminal(EnvelopeStatus.Active)).toBe(false);
    expect(isTerminal(EnvelopeStatus.Contested)).toBe(false);
    expect(isTerminal(EnvelopeStatus.None)).toBe(false);
  });
});

describe('contest lifecycle', () => {
  it('opens a window and lapses to the documented default', () => {
    const window = openContest(1_000n, 3_600n);
    expect(window.resolutionDeadline).toBe(4_600n);
    expect(contestExpired(window, 4_600n)).toBe(false);
    expect(contestExpired(window, 4_601n)).toBe(true);
    expect(defaultResolution()).toBe(EnvelopeStatus.Active);
    expect(() => openContest(100n, 0n)).toThrow(EnvelopeError);
  });
});
