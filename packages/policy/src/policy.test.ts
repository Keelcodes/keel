import { decodeAbiParameters, getAddress, keccak256 } from 'viem';
import { describe, expect, it } from 'vitest';
import { POLICY_ABI_PARAMETERS, encodeInstallData, encodePolicy, policyCommitment } from './commitment.js';
import { ERC20_SELECTOR, readErc20Amount } from './erc20.js';
import { evaluateCall, simulateCalls, toCall } from './evaluate.js';
import { normalizePolicy } from './normalize.js';
import { POLICY_VERSION, type Address, type Call, type Hex, type PolicyState } from './types.js';

const TOKEN = '0x1111111111111111111111111111111111111111' as Address;
const OTHER_TOKEN = '0x3333333333333333333333333333333333333333' as Address;
const ROUTER = '0x2222222222222222222222222222222222222222' as Address;
const TRANSFER = '0xa9059cbb' as Hex;
const APPROVE = '0x095ea7b3' as Hex;

const word = (value: string | bigint): string =>
  (typeof value === 'bigint' ? value.toString(16) : value.replace(/^0x/, '')).padStart(64, '0');

/** Builds a standard ERC-20 call to a token with the given arguments. */
const erc20Call = (selector: Hex, args: readonly (string | bigint)[], value = 0n): Call =>
  toCall({ target: TOKEN, value, data: `${selector}${args.map(word).join('')}` as Hex });

const basePolicy = () =>
  normalizePolicy({
    validAfter: 100n,
    validUntil: 1000n,
    rules: [{ target: TOKEN, selectors: [TRANSFER], maxPerTx: 5n, maxDaily: 10n, maxCalls: 3 }],
  });

const state = (now: bigint, usage: PolicyState['usage'] = []): PolicyState => ({ now, usage });

describe('normalizePolicy', () => {
  it('fills defaults so omitted fields become zero', () => {
    const policy = normalizePolicy({ rules: [{ target: TOKEN }] });
    expect(policy.version).toBe(POLICY_VERSION);
    expect(policy.validAfter).toBe(0n);
    expect(policy.validUntil).toBe(0n);
    expect(policy.rules[0]).toEqual({
      target: TOKEN.toLowerCase(),
      selectors: [],
      maxPerTx: 0n,
      maxDaily: 0n,
      maxCalls: 0,
      tokenLimits: [],
    });
  });

  it('lower-cases addresses and selectors', () => {
    const policy = normalizePolicy({ rules: [{ target: getAddress(TOKEN), selectors: ['0xA9059CBB' as Hex] }] });
    expect(policy.rules[0]?.target).toBe(TOKEN.toLowerCase());
    expect(policy.rules[0]?.selectors[0]).toBe(TRANSFER);
  });

  it.each([
    ['no rules', { rules: [] }],
    ['bad address', { rules: [{ target: '0x1234' as Address }] }],
    ['short selector', { rules: [{ target: TOKEN, selectors: ['0xa905' as Hex] }] }],
    ['negative cap', { rules: [{ target: TOKEN, maxPerTx: -1n }] }],
    ['non-integer count', { rules: [{ target: TOKEN, maxCalls: 1.5 }] }],
    ['inverted window', { validAfter: 100n, validUntil: 100n, rules: [{ target: TOKEN }] }],
    [
      'token limit off-target',
      { rules: [{ target: TOKEN, tokenLimits: [{ token: OTHER_TOKEN, maxPerTx: 1n }] }] },
    ],
    ['duplicate token limit', { rules: [{ target: TOKEN, tokenLimits: [{ token: TOKEN }, { token: TOKEN }] }] }],
    ['negative token cap', { rules: [{ target: TOKEN, tokenLimits: [{ token: TOKEN, maxPerTx: -1n }] }] }],
  ])('rejects %s', (_label, input) => {
    expect(() => normalizePolicy(input as never)).toThrow();
  });
});

describe('policyCommitment', () => {
  it('is stable whether a zero cap is spelled out or omitted', () => {
    const withZero = normalizePolicy({ rules: [{ target: TOKEN, maxPerTx: 0n, maxCalls: 0 }] });
    const omitted = normalizePolicy({ rules: [{ target: TOKEN }] });
    expect(policyCommitment(withZero)).toBe(policyCommitment(omitted));
  });

  it('is stable across address casing', () => {
    const lower = normalizePolicy({ rules: [{ target: TOKEN }] });
    const checksummed = normalizePolicy({ rules: [{ target: getAddress(TOKEN) }] });
    expect(policyCommitment(lower)).toBe(policyCommitment(checksummed));
  });

  it('changes when a limit changes', () => {
    const a = normalizePolicy({ rules: [{ target: TOKEN, maxPerTx: 5n }] });
    const b = normalizePolicy({ rules: [{ target: TOKEN, maxPerTx: 6n }] });
    expect(policyCommitment(a)).not.toBe(policyCommitment(b));
  });

  it('changes when a token limit changes', () => {
    const a = normalizePolicy({ rules: [{ target: TOKEN, tokenLimits: [{ token: TOKEN, maxPerTx: 5n }] }] });
    const b = normalizePolicy({ rules: [{ target: TOKEN, tokenLimits: [{ token: TOKEN, maxPerTx: 6n }] }] });
    expect(policyCommitment(a)).not.toBe(policyCommitment(b));
  });

  // Pinned cross-layer vector: `test/KeelPolicyHook.t.sol` encodes the same
  // policy in Solidity and asserts the same commitment, so the on-chain
  // `keccak256(initData)` provably equals this off-chain `policyCommitment`.
  it('matches the KeelPolicyHook on-chain vector', () => {
    const policy = normalizePolicy({
      validAfter: 0n,
      validUntil: 1_800_000_000n,
      rules: [
        {
          target: TOKEN,
          selectors: [TRANSFER, APPROVE],
          maxPerTx: 1_000_000n,
          maxDaily: 5_000_000n,
          maxCalls: 50,
          tokenLimits: [{ token: TOKEN, maxPerTx: 1_000_000n, maxDaily: 5_000_000n }],
        },
        { target: ROUTER },
      ],
    });

    expect(policyCommitment(policy)).toBe('0xbd6fc210c0c6de10268533612c917efc893ab57755dfc70be2e92b06c8d5d35c');
  });

  it('is keccak256 of the canonical ABI encoding and round-trips', () => {
    const policy = basePolicy();
    const encoded = encodePolicy(policy);
    expect(policyCommitment(policy)).toBe(keccak256(encoded));

    const [version, validAfter, validUntil, rules] = decodeAbiParameters(POLICY_ABI_PARAMETERS, encoded) as [
      bigint,
      bigint,
      bigint,
      readonly { target: string; selectors: readonly string[]; maxPerTx: bigint; maxDaily: bigint; maxCalls: bigint }[],
    ];
    expect(version).toBe(BigInt(POLICY_VERSION));
    expect(validAfter).toBe(100n);
    expect(validUntil).toBe(1000n);
    expect(rules[0]?.target.toLowerCase()).toBe(TOKEN.toLowerCase());
    expect(rules[0]?.selectors).toEqual([TRANSFER]);
    expect(rules[0]?.maxPerTx).toBe(5n);
    expect(rules[0]?.maxDaily).toBe(10n);
    expect(rules[0]?.maxCalls).toBe(3n);
  });
});

describe('encodeInstallData', () => {
  const SESSION_ID = `0x${'ab'.repeat(32)}` as Hex;

  it('prefixes the session id and embeds the exact policy payload', () => {
    const policy = basePolicy();
    const payload = encodeInstallData(SESSION_ID, policy);

    // First ABI word is the session id; the policy payload is embedded verbatim,
    // which is what the hook hashes into the session commitment.
    expect(payload.slice(0, 66)).toBe(SESSION_ID);
    expect(payload).toContain(encodePolicy(policy).slice(2));
  });
});

describe('evaluateCall', () => {
  const policy = basePolicy();
  const call = (value: bigint, data: Hex = TRANSFER) => toCall({ target: TOKEN, value, data });

  it('allows a call inside every limit', () => {
    expect(evaluateCall(policy, state(500n), call(5n))).toEqual({ allowed: true, ruleIndex: 0 });
  });

  it('enforces the validity window', () => {
    expect(evaluateCall(policy, state(50n), call(0n))).toMatchObject({ allowed: false, reason: 'not-yet-valid' });
    expect(evaluateCall(policy, state(2000n), call(0n))).toMatchObject({ allowed: false, reason: 'expired' });
  });

  it('requires a matching rule', () => {
    expect(evaluateCall(policy, state(500n), toCall({ target: ROUTER }))).toMatchObject({
      allowed: false,
      reason: 'no-matching-rule',
    });
    expect(evaluateCall(policy, state(500n), call(5n, APPROVE))).toMatchObject({
      allowed: false,
      reason: 'no-matching-rule',
    });
  });

  it('enforces per-tx, daily and count ceilings', () => {
    expect(evaluateCall(policy, state(500n), call(6n))).toMatchObject({
      allowed: false,
      reason: 'value-per-tx-exceeded',
    });
    expect(evaluateCall(policy, state(500n, [{ calls: 0, dailySpent: 6n }]), call(5n))).toMatchObject({
      allowed: false,
      reason: 'daily-limit-exceeded',
    });
    expect(evaluateCall(policy, state(500n, [{ calls: 3, dailySpent: 0n }]), call(0n))).toMatchObject({
      allowed: false,
      reason: 'call-count-exceeded',
    });
  });

  it('treats an empty selector list as any method', () => {
    const open = normalizePolicy({ rules: [{ target: TOKEN }] });
    expect(evaluateCall(open, state(0n), call(0n, APPROVE))).toEqual({ allowed: true, ruleIndex: 0 });
  });
});

describe('simulateCalls', () => {
  it('accumulates usage across a batch and stops at the first denial', () => {
    const policy = normalizePolicy({ rules: [{ target: TOKEN, maxDaily: 10n }] });
    const calls = [toCall({ target: TOKEN, value: 6n }), toCall({ target: TOKEN, value: 6n })];

    const result = simulateCalls(policy, state(0n), calls);
    expect(result.allowed).toBe(false);
    expect(result.decision).toMatchObject({ allowed: false, reason: 'daily-limit-exceeded' });
    expect(result.usage[0]).toEqual({ calls: 1, dailySpent: 6n });
  });

  it('does not mutate the input state', () => {
    const policy = normalizePolicy({ rules: [{ target: TOKEN }] });
    const input = state(0n, [{ calls: 0, dailySpent: 0n }]);

    simulateCalls(policy, input, [toCall({ target: TOKEN })]);
    expect(input.usage[0]).toEqual({ calls: 0, dailySpent: 0n });
  });
});

describe('readErc20Amount', () => {
  it('reads the final word as the amount for the standard methods', () => {
    expect(readErc20Amount(erc20Call(ERC20_SELECTOR.transfer, [ROUTER, 123n]))).toEqual({
      kind: 'amount',
      selector: ERC20_SELECTOR.transfer,
      value: 123n,
    });
    expect(readErc20Amount(erc20Call(ERC20_SELECTOR.transferFrom, [ROUTER, TOKEN, 7n]))).toMatchObject({
      kind: 'amount',
      value: 7n,
    });
  });

  it('flags non-ERC-20 selectors and malformed standard calls', () => {
    expect(readErc20Amount(toCall({ target: TOKEN, data: '0xdeadbeef' }))).toEqual({ kind: 'not-erc20' });
    expect(readErc20Amount(toCall({ target: TOKEN, data: ERC20_SELECTOR.transfer }))).toEqual({
      kind: 'malformed',
      selector: ERC20_SELECTOR.transfer,
    });
  });
});

describe('ERC-20 token limits', () => {
  const policy = normalizePolicy({
    rules: [{ target: TOKEN, tokenLimits: [{ token: TOKEN, maxPerTx: 5n, maxDaily: 10n }] }],
  });
  const transfer = (amount: bigint) => erc20Call(ERC20_SELECTOR.transfer, [ROUTER, amount]);
  const spent = (amount: bigint): PolicyState['usage'] => [
    { calls: 0, dailySpent: 0n, tokenSpent: { [TOKEN.toLowerCase()]: amount } },
  ];

  it('allows a transfer within both token caps', () => {
    expect(evaluateCall(policy, state(0n), transfer(5n))).toEqual({ allowed: true, ruleIndex: 0 });
  });

  it('enforces the per-tx token cap', () => {
    expect(evaluateCall(policy, state(0n), transfer(6n))).toMatchObject({
      allowed: false,
      reason: 'token-per-tx-exceeded',
    });
  });

  it('enforces the daily token cap against accrued spend', () => {
    expect(evaluateCall(policy, state(0n, spent(6n)), transfer(5n))).toMatchObject({
      allowed: false,
      reason: 'token-daily-limit-exceeded',
    });
  });

  it('blocks transferFrom while a token limit is configured', () => {
    const call = erc20Call(ERC20_SELECTOR.transferFrom, [ROUTER, TOKEN, 1n]);
    expect(evaluateCall(policy, state(0n), call)).toMatchObject({
      allowed: false,
      reason: 'token-transfer-from-blocked',
    });
  });

  it('rejects malformed standard calls but leaves other selectors to the whitelist', () => {
    expect(evaluateCall(policy, state(0n), toCall({ target: TOKEN, data: ERC20_SELECTOR.transfer }))).toMatchObject({
      allowed: false,
      reason: 'token-amount-unparsable',
    });
    expect(evaluateCall(policy, state(0n), toCall({ target: TOKEN, data: '0xdeadbeef' }))).toEqual({
      allowed: true,
      ruleIndex: 0,
    });
  });

  it('accumulates token spend across a simulated batch', () => {
    const daily = normalizePolicy({ rules: [{ target: TOKEN, tokenLimits: [{ token: TOKEN, maxDaily: 10n }] }] });
    const result = simulateCalls(daily, state(0n), [transfer(6n), transfer(6n)]);

    expect(result.allowed).toBe(false);
    expect(result.decision).toMatchObject({ allowed: false, reason: 'token-daily-limit-exceeded' });
    expect(result.usage[0]?.tokenSpent).toEqual({ [TOKEN.toLowerCase()]: 6n });
  });
});
