import { describe, expect, it } from 'vitest';
import {
  RAIL_KIND_ORDER,
  SettlementError,
  formatUnits,
  parseUnits,
  resolveRailAsset,
  selectRail,
  type PaymentRail,
  type PaymentIntent,
  type RailAsset,
} from './index.js';

const PAYER = '0x1111111111111111111111111111111111111111';

const BASE = 'eip155:8453';
const BSC = 'eip155:56';
const FIAT_USD = 'iso4217:USD';

const USDC: RailAsset = {
  address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  symbol: 'USDC',
  decimals: 6,
};
const USDT: RailAsset = {
  address: '0x55d398326f99059fF775485246999027B3197955',
  symbol: 'USDT',
  decimals: 18,
};
const USD: RailAsset = { address: 'usd', symbol: 'USD', decimals: 2 };

const X402_RAIL: PaymentRail = {
  kind: 'x402',
  id: 'x402-base',
  networks: [BASE],
  assets: [USDC],
  payTo: '0x2222222222222222222222222222222222222222',
  cost: 0n,
};
const MPP_RAIL: PaymentRail = {
  kind: 'mpp',
  id: 'mpp-base',
  networks: [BASE],
  assets: [USDC],
  payTo: '0x3333333333333333333333333333333333333333',
  cost: 1_000n,
  priority: 1,
};
const CHAIN_RAIL: PaymentRail = {
  kind: 'chain',
  id: 'chain-bsc',
  networks: [BSC],
  assets: [USDT],
  payTo: '0x4444444444444444444444444444444444444444',
};
const FIAT_RAIL: PaymentRail = {
  kind: 'fiat',
  id: 'fiat-usd',
  networks: [FIAT_USD],
  assets: [USD],
  payTo: 'merchant-1',
  checkout: 'cs_test_opaque_handle',
};
const CATALOGUE: readonly PaymentRail[] = [X402_RAIL, MPP_RAIL, CHAIN_RAIL, FIAT_RAIL];

function intent(overrides: Partial<PaymentIntent> = {}): PaymentIntent {
  return {
    id: 'intent-1',
    protocol: 'x402',
    network: BASE,
    asset: 'USDC',
    amount: 1_000_000n,
    payer: PAYER,
    payee: '0x2222222222222222222222222222222222222222',
    ...overrides,
  };
}

describe('parseUnits / formatUnits', () => {
  it('parses whole and fractional amounts against decimals', () => {
    expect(parseUnits('1', 6)).toBe(1_000_000n);
    expect(parseUnits('0.01', 6)).toBe(10_000n);
    expect(parseUnits('1.5', 6)).toBe(1_500_000n);
    expect(parseUnits('1.234567', 6)).toBe(1_234_567n);
    expect(parseUnits('19.99', 2)).toBe(1_999n);
    expect(parseUnits('42', 0)).toBe(42n);
  });

  it('formats atomic units, trimming trailing zeros', () => {
    expect(formatUnits(1_000_000n, 6)).toBe('1');
    expect(formatUnits(10_000n, 6)).toBe('0.01');
    expect(formatUnits(1_234_567n, 6)).toBe('1.234567');
    expect(formatUnits(1_999n, 2)).toBe('19.99');
    expect(formatUnits(1n, 18)).toBe('0.000000000000000001');
    expect(formatUnits(42n, 0)).toBe('42');
  });

  it('round-trips every value exactly', () => {
    const values = [0n, 1n, 10_000n, 1_234_567n, 999_999_999_999n];
    for (const decimals of [0, 2, 6, 18]) {
      for (const value of values) {
        expect(parseUnits(formatUnits(value, decimals), decimals)).toBe(value);
      }
    }
  });

  it('rejects over-precise, non-numeric and negative-decimals input', () => {
    expect(() => parseUnits('1.2345678', 6)).toThrow(/more than 6 decimal places/);
    expect(() => parseUnits('abc', 6)).toThrow(/not a decimal amount/);
    expect(() => parseUnits('1e6', 6)).toThrow(/not a decimal amount/);
    expect(() => parseUnits('1', -1)).toThrow(/non-negative integer/);
    expect(() => formatUnits(1n, 1.5)).toThrow(/non-negative integer/);
  });
});

describe('rail selection', () => {
  it('picks the cheapest eligible rail', () => {
    const { rail, plan } = selectRail(CATALOGUE, intent());
    expect(rail.id).toBe('x402-base');
    expect(plan.amount).toBe(1_000_000n);
    expect(plan.amountDecimal).toBe('1');
    expect(plan.cost).toBe(0n);
    expect(plan.total).toBe(1_000_000n);
    expect(plan.asset.symbol).toBe('USDC');
  });

  it('is deterministic across repeated and reordered catalogues', () => {
    const first = selectRail(CATALOGUE, intent());
    const second = selectRail(CATALOGUE, intent());
    expect(second.rail.id).toBe(first.rail.id);

    const shuffled = [...CATALOGUE].reverse();
    expect(selectRail(shuffled, intent()).rail.id).toBe(first.rail.id);
  });

  it('breaks cost ties by priority, then kind order, then id', () => {
    const byPriority: readonly PaymentRail[] = [
      { ...MPP_RAIL, id: 'b', cost: 5n, priority: 10 },
      { ...MPP_RAIL, id: 'a', cost: 5n, priority: 1 },
    ];
    expect(selectRail(byPriority, intent()).rail.id).toBe('a');

    const byKind: readonly PaymentRail[] = [
      { ...MPP_RAIL, id: 'mpp', cost: 5n, priority: 0 },
      { ...X402_RAIL, id: 'x402', cost: 5n, priority: 0 },
    ];
    expect(selectRail(byKind, intent()).rail.id).toBe('x402');
    expect(RAIL_KIND_ORDER.indexOf('x402')).toBeLessThan(RAIL_KIND_ORDER.indexOf('mpp'));

    const byId: readonly PaymentRail[] = [
      { ...X402_RAIL, id: 'z', cost: 5n, priority: 0 },
      { ...X402_RAIL, id: 'a', cost: 5n, priority: 0 },
    ];
    expect(selectRail(byId, intent()).rail.id).toBe('a');
  });

  it('filters by allowed rail kinds', () => {
    expect(selectRail(CATALOGUE, intent(), { kinds: ['mpp'] }).rail.id).toBe('mpp-base');
    expect(() => selectRail(CATALOGUE, intent(), { kinds: ['fiat', 'chain'] })).toThrow(
      /no rail can settle/,
    );
  });

  it('filters by allowed networks', () => {
    expect(selectRail(CATALOGUE, intent(), { networks: [BASE] }).rail.id).toBe('x402-base');
    expect(() => selectRail(CATALOGUE, intent(), { networks: [BSC] })).toThrow(/no rail can settle/);
  });

  it('filters by allowed assets, case-insensitively', () => {
    expect(selectRail(CATALOGUE, intent(), { assets: ['usdc'] }).rail.id).toBe('x402-base');
    expect(() => selectRail(CATALOGUE, intent(), { assets: ['USDT'] })).toThrow(/no rail can settle/);
  });

  it('caps amount + cost', () => {
    // The cost-0 x402 rail fits exactly; the cost-1000 MPP rail does not.
    expect(selectRail(CATALOGUE, intent(), { maxAmount: 1_000_000n }).rail.id).toBe('x402-base');
    expect(() => selectRail(CATALOGUE, intent(), { maxAmount: 999_999n })).toThrow(/no rail can settle/);
  });

  it('refuses an asset the rail does not accept on the requested network', () => {
    const baseOnly: PaymentRail = {
      ...X402_RAIL,
      networks: [BASE, BSC],
      assets: [{ ...USDC, networks: [BASE] }],
    };
    expect(selectRail([baseOnly], intent()).rail.id).toBe('x402-base');
    expect(() => selectRail([baseOnly], intent({ network: BSC }))).toThrow(/no rail can settle/);
  });

  it('reports unsatisfiable constraints with SettlementError', () => {
    let caught: unknown;
    try {
      selectRail([], intent());
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SettlementError);
    expect((caught as SettlementError).code).toBe('no-acceptable-requirement');
  });
});

describe('stablecoin asset resolution', () => {
  it('matches by address or symbol, case-insensitively', () => {
    expect(resolveRailAsset(X402_RAIL, BASE, USDC.address).symbol).toBe('USDC');
    expect(resolveRailAsset(X402_RAIL, BASE, 'usdc').decimals).toBe(6);
  });

  it('rejects an asset or network the rail does not support', () => {
    expect(() => resolveRailAsset(X402_RAIL, BASE, 'USDT')).toThrow(/does not accept/);
    expect(() => resolveRailAsset(X402_RAIL, BSC, 'USDC')).toThrow(/does not accept/);
  });
});

describe('fiat rails', () => {
  const fiatIntent = intent({
    protocol: 'fiat',
    network: FIAT_USD,
    asset: 'usd',
    amount: 1_999n,
  });

  it('routes to a hosted checkout and surfaces the opaque handle untouched', () => {
    const { rail, plan } = selectRail(CATALOGUE, fiatIntent, { kinds: ['fiat'] });
    expect(rail.kind).toBe('fiat');
    expect(plan.kind).toBe('fiat');
    expect(plan.checkoutHandle).toBe('cs_test_opaque_handle');
    expect(plan.amountDecimal).toBe('19.99');
    expect(plan.network).toBe(FIAT_USD);
  });

  it('treats a fiat rail with no checkout handle as ineligible', () => {
    const noHandle: PaymentRail = { ...FIAT_RAIL, checkout: undefined };
    expect(() => selectRail([noHandle], fiatIntent)).toThrow(/no rail can settle/);
  });

  it('does not attach a checkout handle to non-fiat plans', () => {
    const { plan } = selectRail(CATALOGUE, intent());
    expect(plan.checkoutHandle).toBeUndefined();
  });
});
