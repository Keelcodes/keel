import type {
  Check,
  CheckResult,
  CheckTarget,
  ConformanceReport,
  ConformanceSummary,
  Suite,
} from './types.js';

async function runCheck(target: CheckTarget, check: Check): Promise<CheckResult> {
  const startedAt = Date.now();
  const base = {
    id: check.id,
    title: check.title,
    spec: check.spec,
    severity: check.severity,
    durationMs: 0,
  };

  try {
    const message = await check.run(target);
    return { ...base, status: 'pass', message, durationMs: Date.now() - startedAt };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ...base, status: 'fail', message, durationMs: Date.now() - startedAt };
  }
}

/** Runs every check, converting thrown errors into failures. Never throws. */
export async function runChecks(
  target: CheckTarget,
  checks: readonly Check[],
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const check of checks) {
    results.push(await runCheck(target, check));
  }
  return results;
}

/** Tallies results. `ok` is false on any failure (critical or not). */
export function summarize(results: readonly CheckResult[]): ConformanceSummary {
  let passed = 0;
  let failed = 0;
  let criticalFailures = 0;
  for (const result of results) {
    if (result.status === 'pass') {
      passed += 1;
      continue;
    }
    failed += 1;
    if (result.severity === 'critical') criticalFailures += 1;
  }
  return { passed, failed, criticalFailures, ok: failed === 0 };
}

/** Runs a suite against a target and returns the full report. */
export async function runSuite(target: CheckTarget, suite: Suite): Promise<ConformanceReport> {
  const startedAt = Date.now();
  const results = await runChecks(target, suite.checks);
  const report: ConformanceReport = {
    suite: suite.name,
    startedAt: new Date(startedAt).toISOString(),
    durationMs: Date.now() - startedAt,
    results,
    summary: summarize(results),
  };
  if (target.account !== undefined) report.account = target.account;
  if (target.module !== undefined) report.module = target.module;
  if (target.moduleTypeId !== undefined) report.moduleTypeId = target.moduleTypeId;
  return report;
}
