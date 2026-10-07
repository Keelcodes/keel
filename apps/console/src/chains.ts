/**
 * Chains the console targets, and the small pure helpers the panels use.
 *
 * Keel's funding and deployment priorities drive the default set: BSC and Base
 * first, Ethereum alongside them — the same three the plan names. The hook and
 * EntryPoint are deployed at the same deterministic addresses on all three, so
 * they are constants rather than per-chain fields. Everything here is pure so it
 * can be unit-tested without a browser or a chain.
 */

import type { Address } from 'viem';

export interface SupportedChain {
  id: number;
  name: string;
  /** Short label for the chain chip. */
  short: string;
  explorer: string;
  /** Block the hook was deployed at — the earliest block that can hold a session. */
  deployBlock: number;
}

export const SUPPORTED_CHAINS: readonly SupportedChain[] = [
  { id: 1, name: 'Ethereum', short: 'ETH', explorer: 'https://etherscan.io', deployBlock: 26_131_539 },
  { id: 8453, name: 'Base', short: 'BASE', explorer: 'https://basescan.org', deployBlock: 52_239_325 },
  { id: 56, name: 'BNB Smart Chain', short: 'BSC', explorer: 'https://bscscan.com', deployBlock: 126_011_779 },
];

/** The chain the console opens on: BSC, Keel's primary launch chain. Must stay in
 *  step with the first entry of `chains` in `wagmi.ts` — wagmi treats that one as
 *  the default the wallet is asked to switch to. */
export const DEFAULT_CHAIN_ID = 56;

/** `KeelPolicyHook`, deployed with CREATE2 at the same address on all three chains. */
export const KEEL_POLICY_HOOK: Address = '0x466b5DC3796D44b0B63FdF2d3bC7a8Ea371a891F';

/** ERC-4337 EntryPoint v0.7, same address on all three chains. */
export const ENTRY_POINT_V07: Address = '0x0000000071727De22E5E9d8BAf0edAc6f37da032';

export function findChain(id: number): SupportedChain | undefined {
  return SUPPORTED_CHAINS.find((chain) => chain.id === id);
}

export function chainName(id: number): string {
  return findChain(id)?.name ?? `chain ${id}`;
}

/** `0x1234…abcd` — keeps a full address readable in a table cell. */
export function shortAddress(address: string, size = 4): string {
  if (address.length <= size * 2 + 2) return address;
  return `${address.slice(0, size + 2)}…${address.slice(-size)}`;
}

/** Block-explorer URL for an address, or `undefined` for an unknown chain. */
export function explorerAddressUrl(chainId: number, address: string): string | undefined {
  const chain = findChain(chainId);
  return chain === undefined ? undefined : `${chain.explorer}/address/${address}`;
}
