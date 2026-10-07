import { describe, expect, it } from 'vitest';
import { Ledger, type PaymentIntent, type SettlementReceipt } from './index.js';

const AT = '2026-10-03T00:00:00.000Z';

function intent(id: string, amount = 1_000n): PaymentIntent {
  return {
    id,
    protocol: 'x402',
    network: 'eip155:84532',
    asset: '0xusdc',
    amount,
    payer: '0xpayer',
    payee: '0xpayee',
  };
}

function receipt(id: string, intentId: string): SettlementReceipt {
  return {
    id,
    protocol: 'x402',
    network: 'eip155:84532',
    asset: '0xusdc',
    amount: 1_000n,
    payer: '0xpayer',
    payee: '0xpayee',
    settledAt: AT,
    intentId,
  };
}

describe('Ledger status', () => {
  it('derives status from the latest lifecycle event', () => {
    const ledger = new Ledger();
    ledger.append({ kind: 'intent', at: AT, intent: intent('i1') });
    expect(ledger.statusOf('i1')).toBe('pending');

    ledger.append({ kind: 'receipt', at: AT, receipt: receipt('r1', 'i1') });
    expect(ledger.statusOf('i1')).toBe('settled');

    ledger.append({ kind: 'failure', at: AT, intentId: 'i1', reason: 'reversed' });
    expect(ledger.statusOf('i1')).toBe('failed');
  });

  it('refuses to invent a status for an unknown intent', () => {
    expect(() => new Ledger().statusOf('nope')).toThrow(/no intent nope/);
  });
});

describe('Ledger receipts', () => {
  it('rejects a replayed receipt id instead of double counting', () => {
    const ledger = new Ledger();
    ledger.append({ kind: 'receipt', at: AT, receipt: receipt('r1', 'i1') });

    expect(() => ledger.append({ kind: 'receipt', at: AT, receipt: receipt('r1', 'i1') })).toThrow(
      /already recorded/,
    );
    expect(ledger.receipts()).toHaveLength(1);
    expect(ledger.events).toHaveLength(1);
  });

  it('filters receipts by intent and returns an ordered trail', () => {
    const ledger = new Ledger();
    ledger.append({ kind: 'intent', at: AT, intent: intent('i1') });
    ledger.append({ kind: 'intent', at: AT, intent: intent('i2') });
    ledger.append({ kind: 'receipt', at: AT, receipt: receipt('r1', 'i1') });

    expect(ledger.receiptsOf('i1').map((entry) => entry.id)).toEqual(['r1']);
    expect(ledger.receiptsOf('i2')).toEqual([]);
    expect(ledger.trail('i1').map((event) => event.kind)).toEqual(['intent', 'receipt']);
  });
});

describe('Ledger balances', () => {
  it('sums signed entries per account, network and asset', () => {
    const ledger = new Ledger();
    ledger.append({ kind: 'entry', at: AT, entry: { account: '0xa', network: 'eip155:84532', asset: '0xUSDC', amount: 5_000n } });
    ledger.append({ kind: 'entry', at: AT, entry: { account: '0xa', network: 'eip155:84532', asset: '0xusdc', amount: -1_500n } });
    ledger.append({ kind: 'entry', at: AT, entry: { account: '0xb', network: 'eip155:84532', asset: '0xusdc', amount: 9_999n } });

    expect(ledger.balanceOf('0xa', { network: 'eip155:84532', asset: '0xusdc' })).toBe(3_500n);
    expect(ledger.balanceOf('0xb', { network: 'eip155:84532', asset: '0xusdc' })).toBe(9_999n);
    expect(ledger.balanceOf('0xa', { network: 'eip155:8453', asset: '0xusdc' })).toBe(0n);
  });
});

describe('Ledger reconcile', () => {
  it('is ok when every intent settled exactly once', () => {
    const ledger = new Ledger();
    ledger.append({ kind: 'intent', at: AT, intent: intent('i1') });
    ledger.append({ kind: 'receipt', at: AT, receipt: receipt('r1', 'i1') });

    expect(ledger.reconcile()).toEqual({ unsettled: [], orphans: [], doubleSettled: [], ok: true });
  });

  it('flags money that never arrived', () => {
    const ledger = new Ledger();
    ledger.append({ kind: 'intent', at: AT, intent: intent('i1') });
    ledger.append({ kind: 'intent', at: AT, intent: intent('i2') });
    ledger.append({ kind: 'receipt', at: AT, receipt: receipt('r1', 'i1') });

    const report = ledger.reconcile();
    expect(report.unsettled).toEqual(['i2']);
    expect(report.ok).toBe(false);
  });

  it('flags receipts for intents the ledger never saw', () => {
    const ledger = new Ledger();
    ledger.append({ kind: 'receipt', at: AT, receipt: receipt('r1', 'ghost') });

    expect(ledger.reconcile().orphans).toEqual(['r1']);
  });

  it('flags an intent paid twice', () => {
    const ledger = new Ledger();
    ledger.append({ kind: 'intent', at: AT, intent: intent('i1') });
    ledger.append({ kind: 'receipt', at: AT, receipt: receipt('r1', 'i1') });
    ledger.append({ kind: 'receipt', at: AT, receipt: receipt('r2', 'i1') });

    const report = ledger.reconcile();
    expect(report.doubleSettled).toEqual(['i1']);
    expect(report.unsettled).toEqual([]);
    expect(report.ok).toBe(false);
  });
});
