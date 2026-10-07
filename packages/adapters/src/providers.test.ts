import { describe, expect, it } from 'vitest';
import { BUNDLER_RPC, createBundlerAdapter } from './bundler.js';
import { CHAIN_ID } from './chains.js';
import { pimlicoUrl } from './endpoints.js';
import { PAYMASTER_RPC, createPaymasterAdapter } from './paymaster.js';

describe('bundler adapter endpoints', () => {
  it('derives per-chain URLs from a Pimlico API key', () => {
    const bundler = createBundlerAdapter('pimlico', { apiKey: 'k-123' });
    expect(bundler.endpoint({ chainId: CHAIN_ID.bsc }).url).toBe(pimlicoUrl(CHAIN_ID.bsc, 'k-123'));
    expect(bundler.endpoint({ chainId: CHAIN_ID.bsc }).url).toContain(`/v2/${CHAIN_ID.bsc}/rpc?apikey=k-123`);
  });

  it('prefers a per-chain override over the single default url', () => {
    const bundler = createBundlerAdapter('alchemy', {
      url: 'https://default.example/rpc',
      urls: { [CHAIN_ID.base]: 'https://base.example/rpc' },
    });
    expect(bundler.endpoint({ chainId: CHAIN_ID.base }).url).toBe('https://base.example/rpc');
    expect(bundler.endpoint({ chainId: CHAIN_ID.ethereum }).url).toBe('https://default.example/rpc');
  });

  it('derives chainIds from the urls map', () => {
    const bundler = createBundlerAdapter('skandha', {
      urls: { [CHAIN_ID.bsc]: 'http://localhost:3000/rpc' },
    });
    expect(bundler.chainIds).toEqual([CHAIN_ID.bsc]);
  });

  it('carries headers and timeout onto the resolved endpoint', () => {
    const bundler = createBundlerAdapter('rundler', {
      url: 'http://bundler.internal:4337',
      headers: { authorization: 'Bearer token' },
      timeoutMs: 5000,
    });
    expect(bundler.endpoint({ chainId: CHAIN_ID.ethereum })).toEqual({
      url: 'http://bundler.internal:4337',
      headers: { authorization: 'Bearer token' },
      timeoutMs: 5000,
    });
  });

  it('throws for a chain with no configured endpoint', () => {
    const bundler = createBundlerAdapter('skandha', {
      urls: { [CHAIN_ID.baseSepolia]: 'http://localhost:3000/rpc' },
    });
    expect(() => bundler.endpoint({ chainId: CHAIN_ID.bsc })).toThrow(/no endpoint configured for chain 56/);
  });

  it('does not invent an endpoint for non-Pimlico providers', () => {
    const bundler = createBundlerAdapter('cdp', { apiKey: 'should-not-be-used-as-url' });
    expect(() => bundler.endpoint({ chainId: CHAIN_ID.base })).toThrow(/no endpoint configured/);
  });
});

describe('paymaster adapter endpoints', () => {
  it('resolves a per-chain paymaster URL', () => {
    const paymaster = createPaymasterAdapter('alchemy', {
      urls: { [CHAIN_ID.base]: 'https://api.g.alchemy.com/v2/key/paymaster' },
    });
    expect(paymaster.kind).toBe('alchemy');
    expect(paymaster.endpoint({ chainId: CHAIN_ID.base }).url).toBe('https://api.g.alchemy.com/v2/key/paymaster');
  });

  it('uses the Pimlico URL builder when given an API key', () => {
    const paymaster = createPaymasterAdapter('pimlico', { apiKey: 'k' });
    expect(paymaster.endpoint({ chainId: CHAIN_ID.baseSepolia }).url).toBe(
      pimlicoUrl(CHAIN_ID.baseSepolia, 'k'),
    );
  });

  it('throws for a chain with no configured endpoint', () => {
    const paymaster = createPaymasterAdapter('megafuel', {
      urls: { [CHAIN_ID.base]: 'https://paymaster.example/rpc' },
    });
    expect(() => paymaster.endpoint({ chainId: CHAIN_ID.bsc })).toThrow(/no endpoint configured/);
  });
});

describe('rpc method constants', () => {
  it('exposes standard ERC-4337 bundler methods', () => {
    expect(BUNDLER_RPC.sendUserOperation).toBe('eth_sendUserOperation');
    expect(BUNDLER_RPC.getUserOperationReceipt).toBe('eth_getUserOperationReceipt');
  });

  it('exposes standard ERC-7677 paymaster methods', () => {
    expect(PAYMASTER_RPC.getPaymasterStubData).toBe('pm_getPaymasterStubData');
    expect(PAYMASTER_RPC.getPaymasterData).toBe('pm_getPaymasterData');
  });
});
