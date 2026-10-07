import { encodeAbiParameters, keccak256 } from 'viem';
import type { Hex, Policy } from './types.js';

// ============================================================================
// Commitment hash.
//
// The commitment is `keccak256(abi.encode(version, validAfter, validUntil, rules))`
// over the **normalised** policy. The on-chain carrier (the ERC-7579 hook module)
// recomputes the same value from the calldata it decodes and stores it, so an
// agent's session key commits to a policy it cannot widen later: every signature
// covers the commitment, and the account's stored hash must match.
//
// Decoding calldata into memory arrays and re-encoding (Solidity `abi.encode`)
// yields the canonical encoding, byte-for-byte identical to the client encoding
// below — the same property the existing infraX module relies on.
// ============================================================================

const RULE_COMPONENTS = [
  { name: 'target', type: 'address' },
  { name: 'selectors', type: 'bytes4[]' },
  { name: 'maxPerTx', type: 'uint256' },
  { name: 'maxDaily', type: 'uint256' },
  { name: 'maxCalls', type: 'uint256' },
  {
    name: 'tokenLimits',
    type: 'tuple[]',
    components: [
      { name: 'token', type: 'address' },
      { name: 'maxPerTx', type: 'uint256' },
      { name: 'maxDaily', type: 'uint256' },
    ],
  },
] as const;

/** ABI shape of a normalised policy; shared with the on-chain carrier. */
export const POLICY_ABI_PARAMETERS = [
  { name: 'version', type: 'uint256' },
  { name: 'validAfter', type: 'uint256' },
  { name: 'validUntil', type: 'uint256' },
  { name: 'rules', type: 'tuple[]', components: RULE_COMPONENTS },
] as const;

/**
 * Canonical ABI encoding of a normalised policy. Prefer
 * {@link policyCommitment} unless you need the raw payload (e.g. to recompute
 * the hash on-chain or in a test).
 */
export function encodePolicy(policy: Policy): Hex {
  return encodeAbiParameters(POLICY_ABI_PARAMETERS, [
    BigInt(policy.version),
    policy.validAfter,
    policy.validUntil,
    policy.rules.map((rule) => ({
      target: rule.target,
      selectors: [...rule.selectors],
      maxPerTx: rule.maxPerTx,
      maxDaily: rule.maxDaily,
      maxCalls: BigInt(rule.maxCalls),
      tokenLimits: rule.tokenLimits.map((limit) => ({
        token: limit.token,
        maxPerTx: limit.maxPerTx,
        maxDaily: limit.maxDaily,
      })),
    })),
  ] as never);
}

/** The policy commitment hash: `keccak256(encodePolicy(policy))`. */
export function policyCommitment(policy: Policy): Hex {
  return keccak256(encodePolicy(policy));
}

/** ABI shape of the hook install payload, i.e. `(bytes32 sessionId, bytes policyData)`. */
export const INSTALL_ABI_PARAMETERS = [
  { name: 'sessionId', type: 'bytes32' },
  { name: 'policyData', type: 'bytes' },
] as const;

/**
 * The ERC-7579 hook install payload for one session:
 * `abi.encode(bytes32 sessionId, bytes policyData)`, where `policyData` is
 * {@link encodePolicy}. The hook stores `keccak256(policyData)` as the session's
 * commitment, so it equals {@link policyCommitment} — the layers cannot disagree.
 */
export function encodeInstallData(sessionId: Hex, policy: Policy): Hex {
  return encodeAbiParameters(INSTALL_ABI_PARAMETERS, [sessionId, encodePolicy(policy)] as never);
}
