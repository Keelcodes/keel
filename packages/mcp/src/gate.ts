import { evaluateCall, type Call, type DenyReason, type Policy, type RuleUsage } from '@keelcodes/policy';

/**
 * What a tool wants to do, in terms the policy engine understands.
 *
 * A tool that performs no call (a read, a dry-run) declares no `call` and is
 * always allowed through — the gate only stands in front of actions.
 */
export interface ToolAction {
  /** Short label used in denial messages, e.g. `transfer`. */
  kind: string;
  /** The call to evaluate. When absent, the action is not gated. */
  call?: Call;
}

export type GateVerdict = 'allow' | 'deny';

export interface GateDecision {
  verdict: GateVerdict;
  /** Set when `verdict` is `deny`. */
  reason?: string;
  /** The policy rule that decided it, when one matched. */
  ruleIndex?: number;
}

/** Decides whether a tool action may proceed. */
export interface PolicyGate {
  check(action: ToolAction): Promise<GateDecision> | GateDecision;
}

export interface PolicyGateOptions {
  /** The normalised policy to enforce. */
  policy: Policy;
  /** Current unix time in seconds. Defaults to the wall clock. */
  now?: () => bigint;
  /**
   * Usage aligned to `policy.rules` by index. Defaults to zero, which is right
   * for a stateless server; a stateful one advances it as calls are allowed.
   */
  usage?: () => readonly RuleUsage[];
}

const noUsage: readonly RuleUsage[] = [];

/**
 * Wraps `@keelcodes/policy`'s off-chain pre-check as a {@link PolicyGate}.
 *
 * The gate never widens what the on-chain module allows: it runs the same
 * `evaluateCall` the account's hook mirrors, so a denial here is a denial there.
 */
export function createPolicyGate(options: PolicyGateOptions): PolicyGate {
  const now = options.now ?? (() => BigInt(Math.floor(Date.now() / 1000)));
  const usage = options.usage ?? (() => noUsage);

  return {
    check(action: ToolAction): GateDecision {
      if (action.call === undefined) return { verdict: 'allow' };

      const decision = evaluateCall(options.policy, { now: now(), usage: usage() }, action.call);
      if (decision.allowed) {
        return decision.ruleIndex === undefined
          ? { verdict: 'allow' }
          : { verdict: 'allow', ruleIndex: decision.ruleIndex };
      }
      return {
        verdict: 'deny',
        reason: describeDenial(decision.reason, action.kind),
        ...(decision.ruleIndex !== undefined ? { ruleIndex: decision.ruleIndex } : {}),
      };
    },
  };
}

/** A gate that denies every action — the safe default when no policy is wired. */
export const DENY_ALL: PolicyGate = {
  check: () => ({ verdict: 'deny', reason: 'no policy configured; all actions are denied' }),
};

function describeDenial(reason: DenyReason | undefined, kind: string): string {
  const detail = reason ?? 'unknown';
  return `policy denied ${kind}: ${detail}`;
}
