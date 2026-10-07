import type { PublicClient } from 'viem';
import { erc8004IdentityAbi, erc8004ReputationAbi } from './abi.js';
import type { Address, AgentRegistryReader, Check, CheckTarget, Hex, Suite } from './types.js';

/**
 * ERC-8004 conformance (Trustless Agents).
 *
 * The identity registry is an ERC-721 whose `tokenId` is the `agentId`, with
 * agent-specific extensions (`getAgentWallet`, `agentURI`). The suite checks the
 * registry is a real ERC-721 and that the agent under test is registered with a
 * resolvable owner, URI and wallet; optionally that a reputation registry is
 * bound to the same identity registry.
 */

/** `bytes4(keccak256("onERC721Received(address,address,uint256,bytes)"))`-style id for ERC-721. */
export const ERC721_INTERFACE_ID: Hex = '0x80ac58cd';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

function agentReader(target: CheckTarget): AgentRegistryReader {
  const reader = target.agentRegistry;
  if (reader === undefined) {
    throw new Error('the ERC-8004 suite needs an `agentRegistry` reader on the target');
  }
  return reader;
}

export const ERC8004_CHECKS: readonly Check[] = [
  {
    id: 'erc8004.identity.deployed',
    title: 'Identity registry is deployed',
    spec: 'ERC-8004 §Identity Registry',
    severity: 'critical',
    async run(target) {
      const reader = agentReader(target);
      if (!(await reader.hasCode(reader.identityRegistry))) {
        throw new Error(`no bytecode at identity registry ${reader.identityRegistry}`);
      }
      return `identity registry ${reader.identityRegistry} has bytecode`;
    },
  },
  {
    id: 'erc8004.identity.erc721',
    title: 'Identity registry implements ERC-721',
    spec: 'ERC-8004 §Identity Registry',
    severity: 'high',
    async run(target) {
      const reader = agentReader(target);
      if (!(await reader.supportsInterface(ERC721_INTERFACE_ID))) {
        throw new Error('supportsInterface(ERC-721) returned false');
      }
      return 'registry reports ERC-721 support';
    },
  },
  {
    id: 'erc8004.identity.agentRegistered',
    title: 'Agent has a non-zero owner',
    spec: 'ERC-8004 §register',
    severity: 'critical',
    async run(target) {
      const reader = agentReader(target);
      const owner = await reader.ownerOf();
      if (owner.toLowerCase() === ZERO_ADDRESS) {
        throw new Error(`agent ${reader.agentId} is not registered (ownerOf == address(0))`);
      }
      return `agent ${reader.agentId} owned by ${owner}`;
    },
  },
  {
    id: 'erc8004.identity.agentURI',
    title: 'Agent exposes a resolvable URI',
    spec: 'ERC-8004 §setAgentURI',
    severity: 'medium',
    async run(target) {
      const reader = agentReader(target);
      const uri = await reader.tokenURI();
      if (typeof uri !== 'string' || uri.length === 0) {
        throw new Error(`tokenURI(${reader.agentId}) is empty`);
      }
      return `agentURI set (${uri.length} chars)`;
    },
  },
  {
    id: 'erc8004.identity.agentWallet',
    title: 'Agent has a bound wallet',
    spec: 'ERC-8004 §getAgentWallet',
    severity: 'high',
    async run(target) {
      const reader = agentReader(target);
      const wallet = await reader.agentWallet();
      if (wallet.toLowerCase() === ZERO_ADDRESS) {
        throw new Error(`getAgentWallet(${reader.agentId}) is address(0)`);
      }
      return `agent wallet ${wallet}`;
    },
  },
  {
    id: 'erc8004.reputation.bound',
    title: 'Reputation registry is bound to the identity registry',
    spec: 'ERC-8004 §Reputation Registry',
    severity: 'high',
    async run(target) {
      const reader = agentReader(target);
      if (reader.reputationRegistry === undefined) {
        throw new Error('no reputation registry configured on the reader');
      }
      const bound = await reader.reputationIdentityRegistry();
      if (bound.toLowerCase() !== reader.identityRegistry.toLowerCase()) {
        throw new Error(
          `reputation registry points at ${bound}, expected identity registry ${reader.identityRegistry}`,
        );
      }
      return 'reputation registry bound to the identity registry';
    },
  },
];

/** ERC-8004 agent registry suite. */
export const ERC8004_SUITE: Suite = {
  name: 'ERC-8004',
  spec: 'ERC-8004 (Trustless Agents)',
  checks: ERC8004_CHECKS,
};

export interface ViemAgentRegistryOptions {
  identityRegistry: Address;
  agentId: bigint;
  reputationRegistry?: Address;
}

/** Points the ERC-8004 suite at live registries via a viem client. */
export function createViemAgentRegistryReader(
  client: PublicClient,
  options: ViemAgentRegistryOptions,
): AgentRegistryReader {
  const { identityRegistry, agentId, reputationRegistry } = options;

  return {
    identityRegistry,
    agentId,
    ...(reputationRegistry !== undefined ? { reputationRegistry } : {}),

    async hasCode(address) {
      const code = await client.getCode({ address });
      return Boolean(code && code !== '0x');
    },

    ownerOf: () =>
      client.readContract({
        address: identityRegistry,
        abi: erc8004IdentityAbi,
        functionName: 'ownerOf',
        args: [agentId],
      }),

    tokenURI: () =>
      client.readContract({
        address: identityRegistry,
        abi: erc8004IdentityAbi,
        functionName: 'tokenURI',
        args: [agentId],
      }),

    agentWallet: () =>
      client.readContract({
        address: identityRegistry,
        abi: erc8004IdentityAbi,
        functionName: 'getAgentWallet',
        args: [agentId],
      }),

    supportsInterface: (interfaceId) =>
      client.readContract({
        address: identityRegistry,
        abi: erc8004IdentityAbi,
        functionName: 'supportsInterface',
        args: [interfaceId],
      }),

    reputationIdentityRegistry: () => {
      if (reputationRegistry === undefined) {
        return Promise.reject(new Error('no reputation registry configured'));
      }
      return client.readContract({
        address: reputationRegistry,
        abi: erc8004ReputationAbi,
        functionName: 'getIdentityRegistry',
      });
    },
  };
}
