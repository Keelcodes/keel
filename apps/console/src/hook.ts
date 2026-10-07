/**
 * Reading installed sessions straight off `KeelPolicyHook`.
 *
 * The hook is account-agnostic and deployed at the same CREATE2 address on all
 * three chains, so the console needs no backend: it asks the hook which session
 * ids an account owns, then reads each policy back. The commitment returned by
 * `policyOf`/`policyCommitmentOf` is `keccak256(policyData)` — the same bytes
 * `@keelcodes/policy` signs off-chain, so what the table shows is what the chain
 * enforces.
 */

import type { Address, Hex } from 'viem';
import { KEEL_POLICY_HOOK } from './chains.js';

/**
 * Only the read surface the console uses. Kept minimal and structural so it does
 * not care which viem instance the caller resolved (wagmi bundles its own).
 */
export interface HookReader {
  readContract(args: {
    address: Address;
    abi: readonly unknown[];
    functionName: string;
    args?: readonly unknown[];
  }): Promise<unknown>;
}

const TOKEN_LIMIT = {
  type: 'tuple',
  components: [
    { name: 'token', type: 'address' },
    { name: 'maxPerTx', type: 'uint256' },
    { name: 'maxDaily', type: 'uint256' },
  ],
} as const;

const RULE = {
  type: 'tuple',
  components: [
    { name: 'target', type: 'address' },
    { name: 'selectors', type: 'bytes4[]' },
    { name: 'maxPerTx', type: 'uint256' },
    { name: 'maxDaily', type: 'uint256' },
    { name: 'maxCalls', type: 'uint256' },
    { name: 'tokenLimits', type: 'tuple[]', components: TOKEN_LIMIT.components },
  ],
} as const;

/** The hook's read ABI (the subset the console calls). */
export const KEEL_POLICY_HOOK_ABI = [
  {
    type: 'function',
    name: 'sessionIdsOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'bytes32[]' }],
  },
  {
    type: 'function',
    name: 'policyCommitmentOf',
    stateMutability: 'view',
    inputs: [
      { name: 'account', type: 'address' },
      { name: 'sessionId', type: 'bytes32' },
    ],
    outputs: [{ name: '', type: 'bytes32' }],
  },
  {
    type: 'function',
    name: 'policyOf',
    stateMutability: 'view',
    inputs: [
      { name: 'account', type: 'address' },
      { name: 'sessionId', type: 'bytes32' },
    ],
    outputs: [
      { name: 'version', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validUntil', type: 'uint256' },
      { name: 'rules', type: 'tuple[]', components: RULE.components },
    ],
  },
] as const;

/** Status derived at read time from the validity window — never stored. */
export type OnChainSessionStatus = 'pending' | 'active' | 'expired';

/** One installed session, flattened from the hook for the table. */
export interface OnChainSession {
  id: Hex;
  commitment: Hex;
  version: bigint;
  validAfter: bigint;
  validUntil: bigint;
  ruleCount: number;
  targets: readonly Address[];
  status: OnChainSessionStatus;
}

function statusOf(validAfter: bigint, validUntil: bigint, now: bigint): OnChainSessionStatus {
  if (validAfter !== 0n && now < validAfter) return 'pending';
  if (validUntil !== 0n && now >= validUntil) return 'expired';
  return 'active';
}

/** Reads every session installed for `account`, newest last (install order). */
export async function readSessions(
  reader: HookReader,
  account: Address,
  nowSeconds: bigint = BigInt(Math.floor(Date.now() / 1000)),
): Promise<readonly OnChainSession[]> {
  const ids = (await reader.readContract({
    address: KEEL_POLICY_HOOK,
    abi: KEEL_POLICY_HOOK_ABI,
    functionName: 'sessionIdsOf',
    args: [account],
  })) as readonly Hex[];

  return Promise.all(
    ids.map(async (id) => {
      const [commitment, policy] = await Promise.all([
        reader.readContract({
          address: KEEL_POLICY_HOOK,
          abi: KEEL_POLICY_HOOK_ABI,
          functionName: 'policyCommitmentOf',
          args: [account, id],
        }),
        reader.readContract({
          address: KEEL_POLICY_HOOK,
          abi: KEEL_POLICY_HOOK_ABI,
          functionName: 'policyOf',
          args: [account, id],
        }),
      ]);

      const [version, validAfter, validUntil, rules] = policy as readonly [
        bigint,
        bigint,
        bigint,
        readonly { target: Address }[],
      ];

      return {
        id,
        commitment: commitment as Hex,
        version,
        validAfter,
        validUntil,
        ruleCount: rules.length,
        targets: rules.map((rule) => rule.target),
        status: statusOf(validAfter, validUntil, nowSeconds),
      };
    }),
  );
}
