import { describe, expect, it } from 'vitest';
import {
  A2A_METADATA_KEYS,
  A2A_X402_EXTENSION_URI,
  SettlementError,
  a2aIntent,
  assertA2ATransition,
  buildPaymentMetadata,
  canTransitionA2A,
  isA2AErrorCode,
  isTerminalA2AStatus,
  parsePaymentMetadata,
  parsePaymentPayload,
  parsePaymentRequiredResponse,
  parseSettleResponse,
  receiptFromA2A,
  verifyA2ARequirement,
  type A2APaymentRequiredResponse,
  type A2APaymentRequirements,
  type PaymentIntent,
} from './index.js';

const NETWORK = 'eip155:8453';
const ASSET = '0x833589fCD6eDb6E08f4c7C32D4f71b54bda02913';
const PAY_TO = '0x2222222222222222222222222222222222222222';
const PAYER = '0x1111111111111111111111111111111111111111';

/** The A2A x402 extension example, with Keel's CAIP-2 network discipline. */
const REQUIRED: A2APaymentRequiredResponse = {
  x402Version: 1,
  accepts: [
    {
      scheme: 'exact',
      network: NETWORK,
      asset: ASSET,
      payTo: PAY_TO,
      maxAmountRequired: '48240000',
      resource: 'https://api.example.com/generate-image',
      description: 'Generate an image',
      maxTimeoutSeconds: 600,
      extra: { name: 'USD Coin', version: 2 },
    },
  ],
};

const ACCEPTED: A2APaymentRequirements = {
  scheme: 'exact',
  network: NETWORK,
  asset: ASSET,
  payTo: PAY_TO,
  maxAmountRequired: '48240000',
  resource: 'https://api.example.com/generate-image',
  description: 'Generate an image',
  maxTimeoutSeconds: 600,
  extra: { name: 'USD Coin', version: 2 },
};

const INTENT: PaymentIntent = {
  id: 'intent-a2a-1',
  protocol: 'x402',
  network: NETWORK,
  asset: ASSET.toLowerCase(),
  amount: 48_240_000n,
  payer: PAYER,
  payee: PAY_TO.toLowerCase(),
};

describe('A2A extension constants', () => {
  it('exposes the canonical extension URI and metadata keys', () => {
    expect(A2A_X402_EXTENSION_URI).toBe('https://github.com/google-a2a/a2a-x402/v0.1');
    expect(A2A_METADATA_KEYS).toEqual({
      status: 'x402.payment.status',
      required: 'x402.payment.required',
      payload: 'x402.payment.payload',
      receipts: 'x402.payment.receipts',
      error: 'x402.payment.error',
    });
  });
});

describe('A2A payment status machine', () => {
  it('walks the happy path required -> submitted -> verified -> completed', () => {
    expect(canTransitionA2A('payment-required', 'payment-submitted')).toBe(true);
    expect(canTransitionA2A('payment-submitted', 'payment-verified')).toBe(true);
    expect(canTransitionA2A('payment-verified', 'payment-completed')).toBe(true);
    expect(() => assertA2ATransition('payment-required', 'payment-submitted')).not.toThrow();
    expect(() => assertA2ATransition('payment-verified', 'payment-completed')).not.toThrow();
  });

  it('allows rejection while payment is only required', () => {
    expect(canTransitionA2A('payment-required', 'payment-rejected')).toBe(true);
  });

  it('allows failure from both submitted and verified (spec §8)', () => {
    expect(canTransitionA2A('payment-submitted', 'payment-failed')).toBe(true);
    expect(canTransitionA2A('payment-verified', 'payment-failed')).toBe(true);
  });

  it('rejects skipped and terminal transitions', () => {
    expect(canTransitionA2A('payment-required', 'payment-completed')).toBe(false);
    expect(() => assertA2ATransition('payment-required', 'payment-verified')).toThrow(SettlementError);
    expect(() => assertA2ATransition('payment-completed', 'payment-failed')).toThrow(/cannot go/);
  });

  it('knows which statuses are terminal', () => {
    expect(isTerminalA2AStatus('payment-completed')).toBe(true);
    expect(isTerminalA2AStatus('payment-failed')).toBe(true);
    expect(isTerminalA2AStatus('payment-rejected')).toBe(true);
    expect(isTerminalA2AStatus('payment-submitted')).toBe(false);
  });
});

describe('A2A error codes', () => {
  it('guards the defined codes', () => {
    expect(isA2AErrorCode('EXPIRED_PAYMENT')).toBe(true);
    expect(isA2AErrorCode('DUPLICATE_NONCE')).toBe(true);
    expect(isA2AErrorCode('NOT_A_CODE')).toBe(false);
  });
});

describe('parsePaymentRequiredResponse', () => {
  it('parses the acceptance options', () => {
    const parsed = parsePaymentRequiredResponse(REQUIRED);
    expect(parsed.x402Version).toBe(1);
    expect(parsed.accepts).toHaveLength(1);
    expect(parsed.accepts[0]).toEqual(ACCEPTED);
  });

  it('rejects a non-CAIP-2 network', () => {
    const bad = { ...REQUIRED, accepts: [{ ...ACCEPTED, network: 'base' }] };
    expect(() => parsePaymentRequiredResponse(bad)).toThrow(/not a CAIP-2/);
  });

  it('rejects a non-atomic maxAmountRequired', () => {
    const bad = { ...REQUIRED, accepts: [{ ...ACCEPTED, maxAmountRequired: '48.24' }] };
    expect(() => parsePaymentRequiredResponse(bad)).toThrow(/atomic units/);
  });

  it('requires at least one acceptance option', () => {
    expect(() => parsePaymentRequiredResponse({ x402Version: 1, accepts: [] })).toThrow(/non-empty array/);
  });
});

describe('parsePaymentPayload / parseSettleResponse', () => {
  it('keeps the scheme payload opaque', () => {
    const payload = {
      x402Version: 1,
      network: 'base',
      scheme: 'exact',
      payload: { signature: '0xdeadbeef', authorization: { nonce: '0x01' } },
    };
    expect(parsePaymentPayload(payload)).toEqual(payload);
  });

  it('parses a settle response and its optional fields', () => {
    const response = {
      success: true,
      network: 'base',
      transaction: '0xabc123',
      payer: PAYER,
    };
    expect(parseSettleResponse(response)).toEqual(response);
    expect(() => parseSettleResponse({ network: 'base' })).toThrow(/success must be a boolean/);
  });
});

describe('payment metadata codec', () => {
  it('round-trips a payment-required metadata record', () => {
    const metadata = buildPaymentMetadata({ status: 'payment-required', required: REQUIRED });
    expect(metadata['x402.payment.status']).toBe('payment-required');

    const parsed = parsePaymentMetadata(metadata);
    expect(parsed.status).toBe('payment-required');
    expect(parsed.required).toEqual(REQUIRED);
  });

  it('round-trips receipts and a failure code', () => {
    const metadata = buildPaymentMetadata({
      status: 'payment-failed',
      receipts: [{ success: false, network: 'base', errorReason: 'signature expired' }],
      error: 'EXPIRED_PAYMENT',
    });
    const parsed = parsePaymentMetadata(metadata);
    expect(parsed.receipts).toEqual([{ success: false, network: 'base', errorReason: 'signature expired' }]);
    expect(parsed.error).toBe('EXPIRED_PAYMENT');
  });

  it('requires a known status', () => {
    expect(() => parsePaymentMetadata({})).toThrow(/x402.payment.status is required/);
    expect(() => parsePaymentMetadata({ 'x402.payment.status': 'payment-nonsense' })).toThrow(/unknown A2A payment status/);
  });
});

describe('intent and anti-tamper verification', () => {
  it('anchors the intent to the accepted requirement', () => {
    const intent = a2aIntent(ACCEPTED, { id: 'intent-a2a-1', payer: PAYER, reference: 'task-123' });
    expect(intent.network).toBe(NETWORK);
    expect(intent.amount).toBe(48_240_000n);
    expect(intent.payee).toBe(PAY_TO);
    expect(intent.reference).toBe('task-123');
    expect(intent.expiresAt).toBeUndefined();

    const anchored = a2aIntent(ACCEPTED, { id: 'intent-a2a-1', payer: PAYER, now: new Date('2026-01-01T00:00:00Z') });
    expect(anchored.expiresAt).toBe('2026-01-01T00:10:00.000Z');
  });

  it('catches a drifted payTo or amount', () => {
    expect(() => verifyA2ARequirement(ACCEPTED, INTENT)).not.toThrow();

    const tampered = { ...ACCEPTED, maxAmountRequired: '99999999' };
    expect(() => verifyA2ARequirement(tampered, INTENT)).toThrow(/does not match intent/);
  });
});

describe('receiptFromA2A', () => {
  it('builds a receipt only for a successful, matching settlement', () => {
    const receipt = receiptFromA2A({
      intent: INTENT,
      requirement: ACCEPTED,
      response: { success: true, network: NETWORK, transaction: '0xtx', payer: PAYER },
      settledAt: '2026-01-01T00:05:00.000Z',
    });
    expect(receipt.protocol).toBe('x402');
    expect(receipt.id).toBe('0xtx');
    expect(receipt.amount).toBe(48_240_000n);
    expect(receipt.transaction).toBe('0xtx');
  });

  it('refuses an unsuccessful settlement', () => {
    expect(() =>
      receiptFromA2A({
        intent: INTENT,
        requirement: ACCEPTED,
        response: { success: false, network: NETWORK, errorReason: 'insufficient funds' },
        settledAt: '2026-01-01T00:05:00.000Z',
      }),
    ).toThrow(/A2A settlement failed: insufficient funds/);
  });

  it('re-checks the terms before attesting', () => {
    expect(() =>
      receiptFromA2A({
        intent: INTENT,
        requirement: { ...ACCEPTED, payTo: '0x3333333333333333333333333333333333333333' },
        response: { success: true, network: NETWORK },
        settledAt: '2026-01-01T00:05:00.000Z',
      }),
    ).toThrow(/does not match intent/);
  });
});
