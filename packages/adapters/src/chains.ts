import type { AccountKind } from './types.js';

/** Well-known chain ids referenced by the default adapter chain sets. */
export const CHAIN_ID = {
  ethereum: 1,
  sepolia: 11155111,
  bsc: 56,
  bscTestnet: 97,
  base: 8453,
  baseSepolia: 84532,
  arbitrum: 42161,
  optimism: 10,
  polygon: 137,
} as const;

/**
 * Default chain sets. BSC leads the Kernel set because BSC is Keel's primary
 * launch chain; the others are kept for the standard account/ecosystem spread.
 */
export const KERNEL_CHAIN_IDS: readonly number[] = [
  CHAIN_ID.bsc,
  CHAIN_ID.bscTestnet,
  CHAIN_ID.base,
  CHAIN_ID.baseSepolia,
  CHAIN_ID.ethereum,
  CHAIN_ID.sepolia,
];

export const NEXUS_CHAIN_IDS: readonly number[] = [
  CHAIN_ID.base,
  CHAIN_ID.baseSepolia,
  CHAIN_ID.arbitrum,
  CHAIN_ID.optimism,
  CHAIN_ID.ethereum,
  CHAIN_ID.polygon,
];

export const SAFE7579_CHAIN_IDS: readonly number[] = [
  CHAIN_ID.ethereum,
  CHAIN_ID.sepolia,
  CHAIN_ID.base,
  CHAIN_ID.baseSepolia,
  CHAIN_ID.bsc,
  CHAIN_ID.bscTestnet,
];

/** A chain Keel ships defaults for, plus the account kinds supported there. */
export interface ChainInfo {
  readonly chainId: number;
  readonly name: string;
  readonly testnet: boolean;
  /** Account implementations known to support this chain. */
  readonly accountKinds: readonly AccountKind[];
}

/** Keel's default chain: BSC mainnet — the primary launch chain, and the one the
 *  fleet is actually deployed on. Testnets stay in the chain sets below but are
 *  no longer the default. */
export const DEFAULT_CHAIN_ID: number = CHAIN_ID.bsc;

/** Chain metadata; `accountKinds` is derived from the per-account chain sets. */
const CHAIN_METADATA: readonly Omit<ChainInfo, 'accountKinds'>[] = [
  { chainId: CHAIN_ID.ethereum, name: 'Ethereum', testnet: false },
  { chainId: CHAIN_ID.sepolia, name: 'Sepolia', testnet: true },
  { chainId: CHAIN_ID.bsc, name: 'BNB Smart Chain', testnet: false },
  { chainId: CHAIN_ID.bscTestnet, name: 'BNB Smart Chain Testnet', testnet: true },
  { chainId: CHAIN_ID.base, name: 'Base', testnet: false },
  { chainId: CHAIN_ID.baseSepolia, name: 'Base Sepolia', testnet: true },
  { chainId: CHAIN_ID.arbitrum, name: 'Arbitrum One', testnet: false },
  { chainId: CHAIN_ID.optimism, name: 'OP Mainnet', testnet: false },
  { chainId: CHAIN_ID.polygon, name: 'Polygon', testnet: false },
];

/** Which account kinds a chain supports, in canonical order. */
function accountKindsFor(chainId: number): readonly AccountKind[] {
  const kinds: AccountKind[] = [];
  if (KERNEL_CHAIN_IDS.includes(chainId)) kinds.push('kernel');
  if (NEXUS_CHAIN_IDS.includes(chainId)) kinds.push('nexus');
  if (SAFE7579_CHAIN_IDS.includes(chainId)) kinds.push('safe7579');
  return kinds;
}

/** Every chain Keel ships defaults for, with the account kinds supported there. */
export const CHAINS: readonly ChainInfo[] = CHAIN_METADATA.map((meta) => ({
  ...meta,
  accountKinds: accountKindsFor(meta.chainId),
}));

const CHAIN_BY_ID = new Map(CHAINS.map((chain) => [chain.chainId, chain]));

/** Whether Keel ships defaults for `chainId`. */
export function isChainSupported(chainId: number): boolean {
  return CHAIN_BY_ID.has(chainId);
}

/** Chain metadata for `chainId`; throws rather than returning a partial default. */
export function getChain(chainId: number): ChainInfo {
  const chain = CHAIN_BY_ID.get(chainId);
  if (!chain) {
    throw new Error(`unsupported chain id ${chainId} (known: ${CHAINS.map((c) => c.chainId).join(', ')})`);
  }
  return chain;
}

/** Account kinds supported on `chainId`; throws for an unsupported chain. */
export function accountsFor(chainId: number): readonly AccountKind[] {
  return getChain(chainId).accountKinds;
}
