import { getAddress, isAddress } from 'viem';
import { PolicyError } from './errors.js';
import {
  POLICY_VERSION,
  type Address,
  type Hex,
  type Policy,
  type PolicyInput,
  type PolicyRule,
  type PolicyRuleInput,
  type TokenLimit,
  type TokenLimitInput,
} from './types.js';

// ============================================================================
// Authored DSL → normalised Policy.
//
// Normalisation fills every optional field with its zero/default so that the
// commitment hash depends on meaning, not on which fields a caller happened to
// spell out: `{ maxPerTx: 0n }` and `{}` hash identically. Addresses are
// lower-cased for the same reason (the ABI encoding already ignores case, but
// keeping it deterministic makes policies comparable with `===` too).
// ============================================================================

const SELECTOR_PATTERN = /^0x[0-9a-fA-F]{8}$/;

function normalizeAddress(value: string, field: string): Address {
  if (!isAddress(value)) throw new PolicyError(`${field}: invalid address "${value}"`);
  return getAddress(value).toLowerCase() as Address;
}

function normalizeSelector(value: string, field: string): Hex {
  if (!SELECTOR_PATTERN.test(value)) {
    throw new PolicyError(`${field}: selector must be 4 bytes (0x + 8 hex), got "${value}"`);
  }
  return value.toLowerCase() as Hex;
}

function normalizeNonNegative(value: bigint, field: string): bigint {
  if (value < 0n) throw new PolicyError(`${field}: must be >= 0, got ${value}`);
  return value;
}

function normalizeTokenLimit(input: TokenLimitInput, field: string): TokenLimit {
  const token = normalizeAddress(input.token, `${field}.token`);
  return Object.freeze({
    token,
    maxPerTx: normalizeNonNegative(input.maxPerTx ?? 0n, `${field}.maxPerTx`),
    maxDaily: normalizeNonNegative(input.maxDaily ?? 0n, `${field}.maxDaily`),
  });
}

function normalizeRule(input: PolicyRuleInput, index: number): PolicyRule {
  const at = `rules[${index}]`;
  const target = normalizeAddress(input.target, `${at}.target`);
  const selectors = (input.selectors ?? []).map((selector, i) =>
    normalizeSelector(selector, `${at}.selectors[${i}]`),
  );

  const maxCalls = input.maxCalls ?? 0;
  if (!Number.isInteger(maxCalls) || maxCalls < 0) {
    throw new PolicyError(`${at}.maxCalls: must be a non-negative integer, got ${maxCalls}`);
  }

  // A token cap can only be enforced on calls made directly to the token, so a
  // limit for any other address would be dead config — reject it loudly.
  const tokenLimits = (input.tokenLimits ?? []).map((limit, i) => {
    const normalized = normalizeTokenLimit(limit, `${at}.tokenLimits[${i}]`);
    if (normalized.token !== target) {
      throw new PolicyError(
        `${at}.tokenLimits[${i}]: token ${normalized.token} must equal the rule target ${target}`,
      );
    }
    return normalized;
  });
  if (new Set(tokenLimits.map((limit) => limit.token)).size !== tokenLimits.length) {
    throw new PolicyError(`${at}.tokenLimits: duplicate limit for the same token`);
  }

  return Object.freeze({
    target,
    selectors: Object.freeze(selectors),
    maxPerTx: normalizeNonNegative(input.maxPerTx ?? 0n, `${at}.maxPerTx`),
    maxDaily: normalizeNonNegative(input.maxDaily ?? 0n, `${at}.maxDaily`),
    maxCalls,
    tokenLimits: Object.freeze(tokenLimits),
  });
}

/**
 * Validates an authored policy and returns its normalised form.
 *
 * Throws {@link PolicyError} rather than returning a partial policy, so a
 * malformed policy surfaces at definition time instead of as a silent on-chain
 * mismatch later.
 */
export function normalizePolicy(input: PolicyInput): Policy {
  const rules = input.rules ?? [];
  if (rules.length === 0) throw new PolicyError('policy must declare at least one rule');

  const validAfter = normalizeNonNegative(input.validAfter ?? 0n, 'validAfter');
  const validUntil = normalizeNonNegative(input.validUntil ?? 0n, 'validUntil');
  // validUntil = 0 is the sentinel for "never expires", so only a non-zero
  // value has to be strictly after validAfter.
  if (validUntil !== 0n && validUntil <= validAfter) {
    throw new PolicyError(`validUntil (${validUntil}) must be greater than validAfter (${validAfter})`);
  }

  return Object.freeze({
    version: POLICY_VERSION,
    validAfter,
    validUntil,
    rules: Object.freeze(rules.map(normalizeRule)),
  });
}
