import { describe, expect, it } from 'vitest';
import {
  accountsFor,
  CHAIN_ID,
  CHAINS,
  DEFAULT_CHAIN_ID,
  getChain,
  isChainSupported,
} from './chains.js';

describe('chain registry', () => {
  it('defaults to BSC mainnet', () => {
    expect(DEFAULT_CHAIN_ID).toBe(CHAIN_ID.bsc);
    expect(getChain(DEFAULT_CHAIN_ID).name).toBe('BNB Smart Chain');
    expect(getChain(DEFAULT_CHAIN_ID).testnet).toBe(false);
  });

  it('derives account kinds from the per-account chain sets', () => {
    expect(accountsFor(CHAIN_ID.bsc)).toEqual(['kernel', 'safe7579']);
    expect(accountsFor(CHAIN_ID.base)).toEqual(['kernel', 'nexus', 'safe7579']);
    expect(accountsFor(CHAIN_ID.arbitrum)).toEqual(['nexus']);
  });

  it('lists only chains that support at least one account', () => {
    expect(CHAINS).toHaveLength(9);
    expect(CHAINS.every((chain) => chain.accountKinds.length > 0)).toBe(true);
  });

  it('reports support and throws for an unknown chain', () => {
    expect(isChainSupported(CHAIN_ID.polygon)).toBe(true);
    expect(isChainSupported(999_999)).toBe(false);
    expect(() => getChain(999_999)).toThrow(/unsupported chain id 999999/);
  });
});
