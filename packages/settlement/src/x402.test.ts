import { describe, expect, it } from 'vitest';
import {
  SettlementError,
  base64Encode,
  encodePaymentSignature,
  intentFromRequirement,
  parsePaymentRequired,
  parsePaymentSignature,
  parseSettlementResponse,
  receiptFromX402,
  selectRequirement,
  verifyRequirement,
  type PaymentIntent,
  type X402Requirements,
} from './index.js';

/** The seller example from the x402 v2 specification, verbatim. */
const SPEC_PAYLOAD = {
  x402Version: 2,
  error: 'PAYMENT-SIGNATURE header is required',
  resource: {
    url: 'https://api.example.com/premium-data',
    description: 'Access to premium market data',
    mimeType: 'application/json',
  },
  accepts: [
    {
      scheme: 'exact',
      network: 'eip155:84532',
      amount: '10000',
      asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      payTo: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
      maxTimeoutSeconds: 60,
      extra: { name: 'USDC', version: '2' },
    },
  ],
  extensions: {},
};

const SPEC_HEADER = base64Encode(JSON.stringify(SPEC_PAYLOAD));

const ACCEPTED: X402Requirements = {
  scheme: 'exact',
  network: 'eip155:84532',
  amount: '10000',
  asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  payTo: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
  maxTimeoutSeconds: 60,
  extra: { name: 'USDC', version: '2' },
};

const INTENT: PaymentIntent = {
  id: 'intent-1',
  protocol: 'x402',
  network: 'eip155:84532',
  asset: '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
  amount: 10_000n,
  payer: '0x1111111111111111111111111111111111111111',
  payee: '0x209693bc6afc0c5328ba36faf03c514ef312287c',
};

describe('parsePaymentRequired', () => {
  it('parses the specification example', () => {
    const parsed = parsePaymentRequired(SPEC_HEADER);

    expect(parsed.x402Version).toBe(2);
    expect(parsed.error).toBe('PAYMENT-SIGNATURE header is required');
    expect(parsed.resource).toEqual({
      url: 'https://api.example.com/premium-data',
      description: 'Access to premium market data',
      mimeType: 'application/json',
    });
    expect(parsed.accepts).toHaveLength(1);
    expect(parsed.accepts[0]).toEqual(ACCEPTED);
  });

  it('rejects a version it does not speak', () => {
    const header = base64Encode(JSON.stringify({ ...SPEC_PAYLOAD, x402Version: 1 }));
    expect(() => parsePaymentRequired(header)).toThrow(/expected x402Version 2/);
  });

  it('rejects a malformed requirement', () => {
    const noAccepts = base64Encode(JSON.stringify({ ...SPEC_PAYLOAD, accepts: [] }));
    expect(() => parsePaymentRequired(noAccepts)).toThrow(/accepts must be a non-empty array/);

    const badAmount = base64Encode(
      JSON.stringify({ ...SPEC_PAYLOAD, accepts: [{ ...ACCEPTED, amount: '0.01' }] }),
    );
    expect(() => parsePaymentRequired(badAmount)).toThrow(/must be atomic units/);

    const badNetwork = base64Encode(
      JSON.stringify({ ...SPEC_PAYLOAD, accepts: [{ ...ACCEPTED, network: 'base' }] }),
    );
    expect(() => parsePaymentRequired(badNetwork)).toThrow(/not a CAIP-2 chain id/);
  });
});

describe('selectRequirement', () => {
  const cheap: X402Requirements = { ...ACCEPTED, amount: '1000' };
  const pricey: X402Requirements = { ...ACCEPTED, amount: '50000', scheme: 'upto' };

  it('picks the cheapest offer the client can satisfy', () => {
    expect(selectRequirement([pricey, cheap, ACCEPTED]).amount).toBe('1000');
  });

  it('respects scheme, network and asset filters', () => {
    expect(selectRequirement([cheap, pricey], { scheme: 'upto' })).toBe(pricey);
    expect(() => selectRequirement([cheap], { network: 'eip155:8453' })).toThrow(
      /no offered requirement satisfies/,
    );
  });

  it('refuses to pick an offer above the client ceiling', () => {
    expect(() => selectRequirement([ACCEPTED], { maxAmount: 9_999n })).toThrow(SettlementError);
    expect(selectRequirement([ACCEPTED], { maxAmount: 10_000n })).toBe(ACCEPTED);
  });
});

describe('verifyRequirement', () => {
  it('accepts an offer that matches the intent, case-insensitively on addresses', () => {
    expect(() => verifyRequirement(ACCEPTED, INTENT)).not.toThrow();
  });

  it('catches a swapped payTo', () => {
    const tampered = { ...ACCEPTED, payTo: '0x4444444444444444444444444444444444444444' };
    expect(() => verifyRequirement(tampered, INTENT)).toThrow(/payTo .* != /);
  });

  it('catches an inflated amount', () => {
    const tampered = { ...ACCEPTED, amount: '1000000' };
    expect(() => verifyRequirement(tampered, INTENT)).toThrow(/amount 1000000 != 10000/);
  });
});

describe('intentFromRequirement', () => {
  it('anchors the expiry from maxTimeoutSeconds', () => {
    const now = new Date('2026-10-03T00:00:00.000Z');
    const intent = intentFromRequirement(ACCEPTED, { id: 'i1', payer: INTENT.payer, now });

    expect(intent.protocol).toBe('x402');
    expect(intent.amount).toBe(10_000n);
    expect(intent.payee).toBe(ACCEPTED.payTo);
    expect(intent.expiresAt).toBe('2026-10-03T00:01:00.000Z');
  });
});

describe('settlement response and payload codecs', () => {
  it('parses a settlement response', () => {
    const header = base64Encode(
      JSON.stringify({ success: true, transaction: '0xdeadbeef', payer: '0xaaa', network: 'eip155:84532' }),
    );
    expect(parseSettlementResponse(header)).toEqual({
      success: true,
      transaction: '0xdeadbeef',
      payer: '0xaaa',
      network: 'eip155:84532',
    });
  });

  it('requires the success flag', () => {
    const header = base64Encode(JSON.stringify({ transaction: '0xdeadbeef' }));
    expect(() => parseSettlementResponse(header)).toThrow(/success must be a boolean/);
  });

  it('round-trips an opaque scheme payload', () => {
    const payload = { scheme: 'exact', payload: { signature: '0xsig', authorization: { value: '10000' } } };
    expect(parsePaymentSignature(encodePaymentSignature(payload))).toEqual(payload);
  });
});

describe('receiptFromX402', () => {
  it('builds a receipt keyed by the transaction hash', () => {
    const receipt = receiptFromX402({
      intent: INTENT,
      requirement: ACCEPTED,
      response: { success: true, transaction: '0xtx', payer: '0xpayer' },
      settledAt: '2026-10-03T00:00:30.000Z',
    });

    expect(receipt.id).toBe('0xtx');
    expect(receipt.intentId).toBe('intent-1');
    expect(receipt.amount).toBe(10_000n);
    expect(receipt.payer).toBe('0xpayer');
    expect(receipt.transaction).toBe('0xtx');
  });

  it('refuses to mint a receipt for a failed settlement', () => {
    expect(() =>
      receiptFromX402({
        intent: INTENT,
        requirement: ACCEPTED,
        response: { success: false, errorReason: 'insufficient_funds' },
        settledAt: '2026-10-03T00:00:30.000Z',
      }),
    ).toThrow(/insufficient_funds/);
  });

  it('refuses to mint a receipt for terms that drifted from the intent', () => {
    expect(() =>
      receiptFromX402({
        intent: INTENT,
        requirement: { ...ACCEPTED, payTo: '0x4444444444444444444444444444444444444444' },
        response: { success: true, transaction: '0xtx' },
        settledAt: '2026-10-03T00:00:30.000Z',
      }),
    ).toThrow(/does not match intent/);
  });
});
