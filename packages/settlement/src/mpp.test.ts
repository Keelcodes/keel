import { describe, expect, it } from 'vitest';
import {
  SettlementError,
  classifyMppResponse,
  decodeMppRequest,
  encodeMppRequest,
  formatCredential,
  formatWwwAuthenticate,
  mppIntent,
  parseCredential,
  parseWwwAuthenticate,
  receiptFromMpp,
  type MppChallenge,
} from './index.js';

const REQUEST = { amount: '2500', currency: 'usd', network: 'eip155:8453' };

const CHALLENGE: MppChallenge = {
  id: 'ch_123',
  method: 'stripe',
  intent: 'charge',
  request: encodeMppRequest(REQUEST),
};

describe('WWW-Authenticate challenge', () => {
  it('round-trips a challenge, including base64url request and extra params', () => {
    const header = formatWwwAuthenticate({ ...CHALLENGE, params: { realm: 'api.example.com' } });

    expect(header.startsWith('Payment ')).toBe(true);
    expect(parseWwwAuthenticate(header)).toEqual({
      ...CHALLENGE,
      params: { realm: 'api.example.com' },
    });
  });

  it('hands the method-specific request to the caller to decode', () => {
    const challenge = parseWwwAuthenticate(formatWwwAuthenticate(CHALLENGE));
    expect(decodeMppRequest(challenge)).toEqual(REQUEST);
  });

  it('rejects a challenge missing a required parameter', () => {
    expect(() => parseWwwAuthenticate('Payment id="a", method="b", intent="charge"')).toThrow(
      /missing request/,
    );
  });

  it('ignores other auth schemes', () => {
    expect(() => parseWwwAuthenticate('Bearer abc')).toThrow(/expected the Payment auth scheme/);
  });
});

describe('classifyMppResponse', () => {
  it('separates a payment barrier from a policy denial', () => {
    expect(classifyMppResponse(200)).toBe('granted');
    expect(classifyMppResponse(402)).toBe('challenge');
    // 403 means the payment itself was accepted, so re-paying cannot help.
    expect(classifyMppResponse(403)).toBe('policy-denied');
    expect(classifyMppResponse(401)).toBe('other');
  });
});

describe('credential', () => {
  it('round-trips Authorization: Payment <token>', () => {
    const header = formatCredential('spt_abc.123');
    expect(header).toBe('Payment spt_abc.123');
    expect(parseCredential(header)).toEqual({ scheme: 'Payment', token: 'spt_abc.123' });
  });

  it('rejects an empty token and foreign schemes', () => {
    expect(() => formatCredential('   ')).toThrow(/empty/);
    expect(() => parseCredential('Payment ')).toThrow(/empty/);
    expect(() => parseCredential('Bearer abc')).toThrow(/expected the Payment auth scheme/);
  });
});

describe('mppIntent', () => {
  it('takes identity from the challenge and terms from the method spec', () => {
    const intent = mppIntent(CHALLENGE, {
      payer: '0xpayer',
      payee: '0xpayee',
      network: 'eip155:8453',
      asset: '0xusdc',
      amount: 2500n,
    });

    expect(intent.id).toBe('ch_123');
    expect(intent.protocol).toBe('mpp');
    expect(intent.amount).toBe(2500n);
  });

  it('rejects a network that is not CAIP-2', () => {
    expect(() =>
      mppIntent(CHALLENGE, {
        payer: '0xpayer',
        payee: '0xpayee',
        network: 'base',
        asset: '0xusdc',
        amount: 1n,
      }),
    ).toThrow(SettlementError);
  });
});

describe('receiptFromMpp', () => {
  const intent = mppIntent(CHALLENGE, {
    payer: '0xpayer',
    payee: '0xpayee',
    network: 'eip155:8453',
    asset: '0xusdc',
    amount: 2500n,
  });

  it('uses the receipt value as the id, so a replay surfaces as a duplicate', () => {
    const receipt = receiptFromMpp({ intent, receipt: 'rcpt_9', settledAt: '2026-10-03T00:00:00.000Z' });

    expect(receipt.id).toBe('rcpt_9');
    expect(receipt.protocol).toBe('mpp');
    expect(receipt.intentId).toBe('ch_123');
  });

  it('refuses an empty receipt', () => {
    expect(() => receiptFromMpp({ intent, receipt: '   ', settledAt: '2026-10-03T00:00:00.000Z' })).toThrow(
      /empty/,
    );
  });
});
