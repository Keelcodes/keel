import type { Check, CheckTarget, RedTeamPort, Severity, Suite } from './types.js';

/**
 * Red-team conformance suite.
 *
 * The adversarial cases are executable Foundry tests
 * (`contracts/test/redteam/KeelPolicyHook.redteam.t.sol`); this module brings
 * their results into the *same* report machinery as the standards suites so a
 * run shows every threat id and whether it was actually exercised.
 *
 * The threat-id mapping is explicit and one-to-one: each `RedTeamCase` names the
 * threat id from `docs/THREAT_MODEL.md` and the Foundry test that covers it,
 * because the two spell ids differently (`T-BYPASS-01` vs `T_BYPASS_01`). A case
 * whose result is absent reads as **"not run"** and fails — an unverified threat
 * is never silently green.
 */

export interface RedTeamCase {
  /** Threat-model id (`docs/THREAT_MODEL.md`), e.g. `T-BYPASS-01`. */
  threat: string;
  /** The Foundry test function that exercises this threat. */
  test: string;
  title: string;
  severity: Severity;
}

/** The threat catalogue, mapped test-by-test to `docs/THREAT_MODEL.md` §4. */
export const REDTEAM_CASES: readonly RedTeamCase[] = [
  {
    threat: 'T-BYPASS-01',
    test: 'test_T_BYPASS_01_delegatecallCannotReachThePolicy',
    title: 'delegatecall cannot route execution around the policy',
    severity: 'critical',
  },
  {
    threat: 'T-BYPASS-02',
    test: 'test_T_BYPASS_02_unknownDispatchSelectorRefused',
    title: 'an unknown dispatch selector is refused',
    severity: 'critical',
  },
  {
    threat: 'T-BYPASS-03',
    test: 'test_T_BYPASS_03_transferFromCannotDrain',
    title: 'transferFrom cannot drain a token-limited rule',
    severity: 'critical',
  },
  {
    threat: 'T-BYPASS-04',
    test: 'test_T_BYPASS_04_shortCalldataCannotSpoofAmount',
    title: 'short calldata cannot spoof the amount as zero',
    severity: 'critical',
  },
  {
    threat: 'T-BYPASS-05',
    test: 'test_T_BYPASS_05_selectorWhitelistCannotBeWidened',
    title: 'a rule selector whitelist cannot be widened from the call site',
    severity: 'critical',
  },
  {
    threat: 'T-BYPASS-06',
    test: 'test_T_BYPASS_06_unauthorisedTargetRefused',
    title: 'a target no rule authorises is refused',
    severity: 'critical',
  },
  {
    threat: 'T-CEILING-01',
    test: 'test_T_CEILING_01_batchCannotSplitAroundDailyCap',
    title: 'a batch cannot split around the native daily cap',
    severity: 'high',
  },
  {
    threat: 'T-CEILING-02',
    test: 'test_T_CEILING_02_batchCannotSplitAroundTokenDailyCap',
    title: 'a batch cannot split around the token daily cap',
    severity: 'high',
  },
  {
    threat: 'T-ACCRUAL-01',
    test: 'test_T_ACCRUAL_01_reinstallCannotResetCounters',
    title: 're-installing a session cannot reset its counters',
    severity: 'high',
  },
  {
    threat: 'T-ACCRUAL-02',
    test: 'test_T_ACCRUAL_02_foreignCallerCannotTouchAccrual',
    title: 'a foreign caller cannot touch another account\'s accrual',
    severity: 'high',
  },
  {
    threat: 'T-WINDOW-01',
    test: 'test_T_WINDOW_01_expiredSessionRefused',
    title: 'a session cannot be used outside its validity window',
    severity: 'high',
  },
  {
    threat: 'T-LIFECYCLE-01',
    test: 'test_T_LIFECYCLE_01_uninstalledSessionCannotBeUsed',
    title: 'an uninstalled session cannot be used',
    severity: 'critical',
  },
  {
    threat: 'T-ENVELOPE-01',
    test: 'test_T_ENVELOPE_01_drawBeyondCapRefused',
    title: 'a draw past the envelope cap is refused',
    severity: 'high',
  },
  {
    threat: 'T-ENVELOPE-02',
    test: 'test_T_ENVELOPE_02_attenuatedCannotRedelegate',
    title: 'an attenuated envelope cannot delegate again',
    severity: 'high',
  },
  {
    threat: 'T-ENVELOPE-03',
    test: 'test_T_ENVELOPE_03_allocationsCannotExceedRootCap',
    title: 'child allocations cannot sum past the root cap',
    severity: 'critical',
  },
  {
    threat: 'T-ENVELOPE-04',
    test: 'test_T_ENVELOPE_04_revokedOrExpiredAdvanceRefused',
    title: 'a revoked or expired envelope cannot advance its cursor',
    severity: 'high',
  },
  {
    threat: 'T-ENVELOPE-05',
    test: 'test_T_ENVELOPE_05_unauthorizedAdvanceAndStatusRefused',
    title: 'a stranger cannot advance a cursor or drive an unauthorized status change',
    severity: 'critical',
  },
  {
    threat: 'T-ENVELOPE-06',
    test: 'test_T_ENVELOPE_06_capabilityRootMismatchRefused',
    title: 'a capability that does not hash to its capabilityRoot is refused',
    severity: 'critical',
  },
  {
    threat: 'T-ENVELOPE-07',
    test: 'test_T_ENVELOPE_07_duplicateRegistrationRefused',
    title: 're-registering the same (principal, capabilityRoot, salt) is refused',
    severity: 'high',
  },
  {
    threat: 'T-ENVELOPE-08',
    test: 'test_T_ENVELOPE_08_foreignEnvelopeCannotBeBound',
    title: "a session cannot be bound to a stranger's envelope",
    severity: 'high',
  },
  {
    threat: 'T-ENVELOPE-09',
    test: 'test_T_ENVELOPE_09_childApproversMustBeSubset',
    title: "an attenuated child cannot swap in its own approver set",
    severity: 'high',
  },
];

function redTeamPort(target: CheckTarget): RedTeamPort {
  const port = target.redTeam;
  if (port === undefined) {
    throw new Error('the red-team suite needs a `redTeam` port on the target');
  }
  return port;
}

export const REDTEAM_CHECKS: readonly Check[] = REDTEAM_CASES.map((testCase) => ({
  id: `redteam.${testCase.threat.toLowerCase()}`,
  title: `${testCase.threat} — ${testCase.title}`,
  spec: 'THREAT_MODEL.md §4',
  severity: testCase.severity,
  async run(target) {
    const outcome = await redTeamPort(target).outcomeOf(testCase.test);
    if (outcome === undefined) {
      throw new Error(`not run — Foundry case ${testCase.test} (${testCase.threat}) was not executed`);
    }
    if (!outcome) {
      throw new Error(`Foundry-verified ✗ ${testCase.test} FAILED — ${testCase.threat} may be exploitable`);
    }
    return `Foundry-verified ✓ ${testCase.test} refuses ${testCase.threat}`;
  },
}));

/** Red-team suite: Foundry adversarial cases reported through the conformance runner. */
export const REDTEAM_SUITE: Suite = {
  name: 'Red-team',
  spec: 'docs/THREAT_MODEL.md §4 (KeelPolicyHook + KeelBoundedActions adversarial cases)',
  checks: REDTEAM_CHECKS,
};

/** Adapts a `testName → passed` table (e.g. from {@link parseForgeRedTeamReport}) to a {@link RedTeamPort}. */
export function toRedTeamPort(results: Readonly<Record<string, boolean>>): RedTeamPort {
  return { outcomeOf: async (testName) => results[testName] };
}

/** Strips a Foundry function signature (`test_Foo()`, `test_Foo(uint256)`) back to its name. */
function normalizeTestName(name: string): string {
  return name.replace(/\(.*\)$/, '');
}

/**
 * Parses `forge test --match-path 'test/redteam/*' --json` output into a
 * `testName → passed` table. Forge nests results by file → contract →
 * `test_results`, so the walk is structural rather than depth-fixed; any leaf
 * carrying a `status` is recorded.
 */
export function parseForgeRedTeamReport(value: unknown): Record<string, boolean> {
  const results: Record<string, boolean> = {};

  const visit = (node: unknown, name?: string): void => {
    if (typeof node !== 'object' || node === null) return;
    const record = node as Record<string, unknown>;
    const status = record['status'];
    if (typeof status === 'string' && name !== undefined) {
      results[normalizeTestName(name)] = status === 'Success';
      return;
    }
    for (const [key, child] of Object.entries(record)) visit(child, key);
  };

  visit(value);
  return results;
}
