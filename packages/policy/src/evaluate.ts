import { isAddress } from 'viem';
import { ERC20_SELECTOR, readErc20Amount } from './erc20.js';
import { PolicyError } from './errors.js';
import type {
  Address,
  Call,
  Decision,
  DenyReason,
  Hex,
  Policy,
  PolicyRule,
  PolicyState,
  RuleUsage,
} from './types.js';

// ============================================================================
// Off-chain pre-check and simulation.
//
// These are pure functions over (policy, state, call). They mirror the rules
// the on-chain hook will enforce, so a caller can dry-run a batch before
// signing: reject it locally with a precise reason instead of paying for a
// bundler round-trip that ends in a validation failure. The on-chain module
// remains the source of truth; this layer never widens what is allowed.
// ============================================================================

/** Usage of a rule that has never been exercised. */
export const ZERO_USAGE: RuleUsage = Object.freeze({ calls: 0, dailySpent: 0n });

/** Builds a {@link Call}, deriving the selector from `data`. */
export function toCall(input: { target: Address; value?: bigint; data?: Hex }): Call {
  if (!isAddress(input.target)) throw new PolicyError(`call.target: invalid address "${input.target}"`);
  const data = (input.data ?? '0x') as Hex;
  const selector = (data.length >= 10 ? data.slice(0, 10) : '0x').toLowerCase() as Hex;
  return { target: input.target.toLowerCase() as Address, value: input.value ?? 0n, data, selector };
}

function matches(rule: PolicyRule, call: Call): boolean {
  if (rule.target !== call.target.toLowerCase()) return false;
  if (rule.selectors.length === 0) return true;
  return rule.selectors.includes(call.selector.toLowerCase() as Hex);
}

/**
 * Applies a rule's per-token ceiling, if one is configured for this call's
 * target. Returns the reason to deny, or `undefined` to allow.
 *
 * `transferFrom` is refused outright while a limit is configured: its amount is
 * readable but bounding a pull from an arbitrary address is ambiguous enough
 * that the conservative choice (matching the existing infraX module) is to
 * reject it. Calls to a limited token that are not standard ERC-20 methods are
 * left to the rule's selector whitelist.
 */
function tokenDenial(rule: PolicyRule, usage: RuleUsage, call: Call): DenyReason | undefined {
  const limit = rule.tokenLimits.find((entry) => entry.token === call.target.toLowerCase());
  if (!limit) return undefined;

  const read = readErc20Amount(call);
  if (read.kind === 'malformed') return 'token-amount-unparsable';
  if (read.kind === 'not-erc20') return undefined;
  if (read.selector === ERC20_SELECTOR.transferFrom) return 'token-transfer-from-blocked';

  if (limit.maxPerTx > 0n && read.value > limit.maxPerTx) return 'token-per-tx-exceeded';

  const spent = usage.tokenSpent?.[limit.token] ?? 0n;
  if (limit.maxDaily > 0n && spent + read.value > limit.maxDaily) return 'token-daily-limit-exceeded';

  return undefined;
}

/**
 * Evaluates a single call against the policy. Validity is checked first, then
 * a matching rule is looked up in declared order (first match wins), then that
 * rule's per-tx / daily / count and per-token ceilings are applied.
 */
export function evaluateCall(policy: Policy, state: PolicyState, call: Call): Decision {
  if (policy.validAfter > 0n && state.now < policy.validAfter) return { allowed: false, reason: 'not-yet-valid' };
  if (policy.validUntil > 0n && state.now > policy.validUntil) return { allowed: false, reason: 'expired' };

  const ruleIndex = policy.rules.findIndex((rule) => matches(rule, call));
  if (ruleIndex === -1) return { allowed: false, reason: 'no-matching-rule' };

  const rule = policy.rules[ruleIndex]!;
  const usage = state.usage[ruleIndex] ?? ZERO_USAGE;

  if (rule.maxPerTx > 0n && call.value > rule.maxPerTx) {
    return { allowed: false, reason: 'value-per-tx-exceeded', ruleIndex };
  }
  const tokenReason = tokenDenial(rule, usage, call);
  if (tokenReason) return { allowed: false, reason: tokenReason, ruleIndex };
  if (rule.maxDaily > 0n && usage.dailySpent + call.value > rule.maxDaily) {
    return { allowed: false, reason: 'daily-limit-exceeded', ruleIndex };
  }
  if (rule.maxCalls > 0 && usage.calls + 1 > rule.maxCalls) {
    return { allowed: false, reason: 'call-count-exceeded', ruleIndex };
  }
  return { allowed: true, ruleIndex };
}

/** Advances a rule's usage by one allowed call, including any token amount. */
function advanceUsage(rule: PolicyRule, usage: RuleUsage, call: Call): RuleUsage {
  const next: { calls: number; dailySpent: bigint; tokenSpent?: Record<string, bigint> } = {
    calls: usage.calls + 1,
    dailySpent: usage.dailySpent + call.value,
  };

  const limit = rule.tokenLimits.find((entry) => entry.token === call.target.toLowerCase());
  const read = limit ? readErc20Amount(call) : undefined;
  if (limit && read?.kind === 'amount' && read.selector !== ERC20_SELECTOR.transferFrom) {
    const tokenSpent = { ...(usage.tokenSpent ?? {}) };
    tokenSpent[limit.token] = (tokenSpent[limit.token] ?? 0n) + read.value;
    next.tokenSpent = tokenSpent;
  } else if (usage.tokenSpent) {
    next.tokenSpent = usage.tokenSpent;
  }

  return next;
}

export interface SimulationResult {
  readonly allowed: boolean;
  /** The last decision evaluated: the first denial, or the final allow. */
  readonly decision: Decision;
  /** Usage after applying every allowed call; input state is never mutated. */
  readonly usage: readonly RuleUsage[];
}

/**
 * Dry-runs `calls` in order, accumulating usage so that later calls see the
 * effect of earlier ones (e.g. a batch that would breach a daily cap only
 * together). Stops and returns at the first denial.
 *
 * `state.usage` is aligned to `policy.rules` by index; callers reset
 * `dailySpent` / `tokenSpent` themselves when the day window rolls over.
 */
export function simulateCalls(policy: Policy, state: PolicyState, calls: readonly Call[]): SimulationResult {
  const usage: RuleUsage[] = policy.rules.map((_, index) => state.usage[index] ?? ZERO_USAGE);
  let decision: Decision = { allowed: true };

  for (const call of calls) {
    decision = evaluateCall(policy, { now: state.now, usage }, call);
    if (!decision.allowed) return { allowed: false, decision, usage };

    const index = decision.ruleIndex!;
    usage[index] = advanceUsage(policy.rules[index]!, usage[index] ?? ZERO_USAGE, call);
  }

  return { allowed: true, decision, usage };
}
