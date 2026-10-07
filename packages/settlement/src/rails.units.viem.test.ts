import { describe, expect, it } from 'vitest';
import { formatUnits as viemFormatUnits, parseUnits as viemParseUnits } from 'viem';
import { SettlementError, formatUnits, parseUnits } from './index.js';

/**
 * Differential test against `viem`'s unit helpers.
 *
 * `parseUnits` is deliberately stricter than viem's: viem rounds when the input
 * carries more fractional digits than the asset supports, while settlement
 * refuses. This file pins both halves of that contract — the agreement on the
 * accepted domain, and the intentional divergence — so that a future viem
 * release, or a well-meaning "just use viem" refactor, cannot silently change
 * settlement arithmetic.
 *
 * Verified against viem 2.57.x (`utils/unit/Value.ts`).
 */

describe('parseUnits agrees with viem on the accepted domain', () => {
  const agreed: Array<[value: string, decimals: number]> = [
    ['0', 0],
    ['0', 6],
    ['1', 0],
    ['1', 6],
    ['1.00', 6],
    ['0.000001', 6],
    ['123.456789', 6],
    ['1000000', 6],
    ['12345.6789', 18],
  ];

  for (const [value, decimals] of agreed) {
    it(`parseUnits(${value}, ${decimals})`, () => {
      expect(parseUnits(value, decimals)).toBe(viemParseUnits(value, decimals));
    });
  }
});

describe('parseUnits diverges from viem by design', () => {
  it('rejects excess fractional digits where viem rounds down', () => {
    expect(viemParseUnits('1.234', 2)).toBe(123n);
    expect(() => parseUnits('1.234', 2)).toThrow(SettlementError);
  });

  it('rejects excess fractional digits where viem rounds up', () => {
    expect(viemParseUnits('1.235', 2)).toBe(124n);
    expect(() => parseUnits('1.235', 2)).toThrow(SettlementError);
  });

  it('rejects sub-unit fractions at zero decimals where viem rounds', () => {
    expect(viemParseUnits('1.5', 0)).toBe(2n);
    expect(viemParseUnits('1.4', 0)).toBe(1n);
    expect(() => parseUnits('1.5', 0)).toThrow(SettlementError);
    expect(() => parseUnits('1.4', 0)).toThrow(SettlementError);
  });

  it('rejects the negative and shorthand forms that viem accepts', () => {
    expect(viemParseUnits('-1.5', 6)).toBe(-1500000n);
    expect(viemParseUnits('.5', 6)).toBe(500000n);
    expect(viemParseUnits('5.', 6)).toBe(5000000n);
    expect(() => parseUnits('-1.5', 6)).toThrow(SettlementError);
    expect(() => parseUnits('.5', 6)).toThrow(SettlementError);
    expect(() => parseUnits('5.', 6)).toThrow(SettlementError);
  });
});

describe('formatUnits agrees with viem', () => {
  const agreed: Array<[value: bigint, decimals: number]> = [
    [0n, 0],
    [0n, 6],
    [1n, 6],
    [10000n, 6],
    [1000000n, 6],
    [123456789n, 6],
    [123n, 2],
    [-1500000n, 6],
    [-1n, 18],
  ];

  for (const [value, decimals] of agreed) {
    it(`formatUnits(${value}, ${decimals})`, () => {
      expect(formatUnits(value, decimals)).toBe(viemFormatUnits(value, decimals));
    });
  }
});
