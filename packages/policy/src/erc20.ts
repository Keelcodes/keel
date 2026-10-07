import type { Call, Hex } from './types.js';

// ============================================================================
// Standard ERC-20 call shapes.
//
// Token-level ceilings can only be enforced by reading the amount out of the
// token's own call data, so Keel recognises the three standard value-moving
// methods. Everything else is left to the rule's selector whitelist.
//
// `transferFrom` is recognised but *blocked* when a token limit is configured
// (see evaluate.ts): bounding it is ambiguous enough that the conservative
// choice — mirroring the existing infraX module — is to refuse it outright.
// ============================================================================

/** Selectors of the standard ERC-20 methods Keel understands. */
export const ERC20_SELECTOR = {
  transfer: '0xa9059cbb',
  approve: '0x095ea7b3',
  transferFrom: '0x23b872dd',
} as const satisfies Record<string, Hex>;

/** Outcome of reading an ERC-20 amount from a call. */
export type Erc20Read =
  /** Selector is not one of the standard value-moving methods. */
  | { readonly kind: 'not-erc20' }
  /** A standard method whose call data is too short to carry an amount. */
  | { readonly kind: 'malformed'; readonly selector: Hex }
  /** A standard method with an amount as its final 32-byte word. */
  | { readonly kind: 'amount'; readonly selector: Hex; readonly value: bigint };

function isStandardSelector(selector: Hex): boolean {
  return (
    selector === ERC20_SELECTOR.transfer ||
    selector === ERC20_SELECTOR.approve ||
    selector === ERC20_SELECTOR.transferFrom
  );
}

/**
 * Reads the amount from a standard ERC-20 `transfer` / `approve` /
 * `transferFrom` call. In all three the amount is the final `uint256` word, so
 * the same slice works for each (68-byte and 100-byte call data respectively).
 */
export function readErc20Amount(call: Call): Erc20Read {
  if (!isStandardSelector(call.selector)) return { kind: 'not-erc20' };
  // Selector (4 bytes) + at least two words (recipient + amount).
  if (call.data.length < 10 + 64) return { kind: 'malformed', selector: call.selector };
  return { kind: 'amount', selector: call.selector, value: BigInt(`0x${call.data.slice(-64)}`) };
}
