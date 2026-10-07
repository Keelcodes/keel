import { describe, expect, it } from 'vitest';
import {
  chainName,
  DEFAULT_CHAIN_ID,
  ENTRY_POINT_V07,
  explorerAddressUrl,
  findChain,
  KEEL_POLICY_HOOK,
  shortAddress,
  SUPPORTED_CHAINS,
} from './chains.js';

describe('SUPPORTED_CHAINS', () => {
  it('covers Ethereum, Base and BSC', () => {
    expect(SUPPORTED_CHAINS.map((c) => c.id)).toEqual([1, 8453, 56]);
  });

  it('defaults to BSC, the primary launch chain', () => {
    expect(DEFAULT_CHAIN_ID).toBe(56);
    expect(findChain(DEFAULT_CHAIN_ID)).toBeDefined();
  });

  it('gives every chain a unique short label and an https explorer', () => {
    const shorts = SUPPORTED_CHAINS.map((c) => c.short);
    expect(new Set(shorts).size).toBe(shorts.length);
    for (const chain of SUPPORTED_CHAINS) {
      expect(chain.explorer.startsWith('https://')).toBe(true);
    }
  });

  it('records a deploy block for every chain so the console can label a deployment', () => {
    for (const chain of SUPPORTED_CHAINS) {
      expect(chain.deployBlock).toBeGreaterThan(0);
    }
  });
});

describe('deployed addresses', () => {
  it('uses the CREATE2 KeelPolicyHook address', () => {
    expect(KEEL_POLICY_HOOK).toBe('0x466b5DC3796D44b0B63FdF2d3bC7a8Ea371a891F');
  });

  it('uses the ERC-4337 v0.7 EntryPoint address', () => {
    expect(ENTRY_POINT_V07).toBe('0x0000000071727De22E5E9d8BAf0edAc6f37da032');
  });
});

describe('chainName', () => {
  it('names a known chain', () => {
    expect(chainName(8453)).toBe('Base');
  });

  it('falls back to the raw id', () => {
    expect(chainName(999999)).toBe('chain 999999');
  });
});

describe('shortAddress', () => {
  const address = '0x1234567890abcdef1234567890abcdef12345678';

  it('elides the middle', () => {
    expect(shortAddress(address)).toBe('0x1234…5678');
  });

  it('honours the size argument', () => {
    expect(shortAddress(address, 6)).toBe('0x123456…345678');
  });

  it('leaves an already-short value alone', () => {
    expect(shortAddress('0xabc')).toBe('0xabc');
  });
});

describe('explorerAddressUrl', () => {
  it('links a known chain', () => {
    expect(explorerAddressUrl(56, '0xabc')).toBe('https://bscscan.com/address/0xabc');
  });

  it('returns undefined for an unknown chain', () => {
    expect(explorerAddressUrl(999999, '0xabc')).toBeUndefined();
  });
});
