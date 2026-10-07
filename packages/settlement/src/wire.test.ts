import { describe, expect, it } from 'vitest';
import {
  SettlementError,
  base64Decode,
  base64Encode,
  decodeJsonPayload,
  encodeJsonPayload,
  formatAuthHeader,
  parseAuthHeader,
} from './index.js';

describe('base64', () => {
  it('round-trips ASCII and multi-byte text', () => {
    for (const text of ['', 'hello', '{"a":1}', '结算 x402 · 💸', 'àéîõü']) {
      expect(base64Decode(base64Encode(text))).toBe(text);
    }
  });

  it('emits unpadded base64url when asked', () => {
    const encoded = base64Encode('??>>', { urlSafe: true });
    expect(encoded).not.toContain('+');
    expect(encoded).not.toContain('/');
    expect(encoded).not.toContain('=');
    expect(base64Decode(encoded)).toBe('??>>');
  });

  it('accepts padding-less and whitespace-padded input', () => {
    expect(base64Decode('aGVsbG8')).toBe('hello');
    expect(base64Decode('aGVs\nbG8=')).toBe('hello');
  });

  it('decodes the prefix of a real x402 PAYMENT-REQUIRED header', () => {
    // From the x402 v2 seller walkthrough: the header starts
    // `{"x402Version":2,"error":…` in base64.
    expect(base64Decode('eyJ4NDAyVmVyc2lvbiI6MiwiZXJyb3IiO')).toBe('{"x402Version":2,"error"');
  });

  it('rejects characters outside the alphabet', () => {
    expect(() => base64Decode('aGVs bG8*')).toThrow(SettlementError);
  });

  it('round-trips JSON payloads', () => {
    const value = { x402Version: 2, accepts: [{ amount: '10000' }], note: '结' };
    expect(decodeJsonPayload(encodeJsonPayload(value))).toEqual(value);
  });

  it('reports non-JSON payloads as malformed', () => {
    const notJson = base64Encode('nope');
    expect(() => decodeJsonPayload(notJson)).toThrow(/not valid JSON/);
  });
});

describe('HTTP auth headers', () => {
  it('parses a challenge with quoted and bare values', () => {
    const header = parseAuthHeader('Payment id="abc", method=stripe, intent="charge", request="eyJ4IjoxfQ"');

    expect(header.scheme).toBe('Payment');
    expect(header.params).toEqual({
      id: 'abc',
      method: 'stripe',
      intent: 'charge',
      request: 'eyJ4IjoxfQ',
    });
  });

  it('keeps commas and escapes inside quoted values', () => {
    const header = parseAuthHeader('Payment id="a,b", note="say \\"hi\\""');

    expect(header.params['id']).toBe('a,b');
    expect(header.params['note']).toBe('say "hi"');
  });

  it('round-trips values that need quoting', () => {
    const header = { scheme: 'Payment', params: { id: 'a,b', note: 'say "hi"' } };
    expect(parseAuthHeader(formatAuthHeader(header))).toEqual(header);
  });

  it('returns just the scheme when there are no params', () => {
    expect(parseAuthHeader('Negotiate')).toEqual({ scheme: 'Negotiate', params: {} });
  });

  it('rejects malformed input', () => {
    expect(() => parseAuthHeader('   ')).toThrow(/empty auth header/);
    expect(() => parseAuthHeader('Payment id')).toThrow(/has no value/);
    expect(() => parseAuthHeader('Payment id="oops')).toThrow(/unterminated quoted value/);
    expect(() => parseAuthHeader('Payment id="a\\')).toThrow(/dangling escape/);
  });
});
