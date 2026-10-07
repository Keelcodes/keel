/**
 * The console's data layer.
 *
 * Sessions no longer come from a local seed: they are read straight off
 * `KeelPolicyHook` by `readSessions` in [`hook.ts`](./hook.ts), so the panel
 * shows what the chain actually enforces. Settlement is not deployed, so there
 * is no ledger to read and the panel says so rather than inventing rows.
 * Conformance runs the real ERC-7579 suite from `@keelcodes/conformance` against
 * a live chain, defaulting its subject to the deployed hook.
 */

import {
  ERC7579_SUITE,
  createViemReader,
  formatReport,
  runSuite,
  type ConformanceReport,
} from '@keelcodes/conformance';
import type { Address } from 'viem';
import { KEEL_POLICY_HOOK, shortAddress } from './chains.js';

// ============================================================================
// Conformance
// ============================================================================

/** Row shape the conformance table renders, plus the full text report. */
export interface ConformanceRow {
  suite: string;
  subject: string;
  passed: number;
  failed: number;
  critical: number;
  ok: boolean;
  report: string;
}

export interface ConformanceTarget {
  client: ConformanceClient;
  account: Address;
  module: Address;
  moduleTypeId: bigint;
}

/**
 * The client shape `createViemReader` accepts. Taken from the package rather
 * than imported from `viem` directly: pnpm can resolve two viem instances (one
 * for wagmi, one for the package), whose structurally-similar `PublicClient`
 * types are not interchangeable, so the caller bridges the two at this seam.
 */
export type ConformanceClient = Parameters<typeof createViemReader>[0];

/**
 * The module the ERC-7579 suite checks. `VITE_CONFORMANCE_MODULE` overrides it;
 * unset, it defaults to the deployed `KeelPolicyHook` with module type 4 (hook),
 * so the panel runs out of the box.
 */
export function conformanceTargetFromEnv(): { module: Address; moduleTypeId: bigint } {
  const rawModule = import.meta.env.VITE_CONFORMANCE_MODULE;
  const module =
    typeof rawModule === 'string' && /^0x[0-9a-fA-F]{40}$/.test(rawModule)
      ? (rawModule as Address)
      : KEEL_POLICY_HOOK;

  const rawType = import.meta.env.VITE_CONFORMANCE_MODULE_TYPE;
  const moduleTypeId = typeof rawType === 'string' && /^\d+$/.test(rawType) ? BigInt(rawType) : 4n;

  return { module, moduleTypeId };
}

/** Runs the ERC-7579 suite against a live account and formats the report. */
export async function loadConformance(target: ConformanceTarget): Promise<ConformanceRow> {
  const report: ConformanceReport = await runSuite(
    {
      reader: createViemReader(target.client),
      account: target.account,
      module: target.module,
      moduleTypeId: target.moduleTypeId,
    },
    ERC7579_SUITE,
  );

  const account = report.account ?? target.account;
  const module = report.module ?? target.module;

  return {
    suite: report.suite,
    subject: `${shortAddress(account)} · ${shortAddress(module)}`,
    passed: report.summary.passed,
    failed: report.summary.failed,
    critical: report.summary.criticalFailures,
    ok: report.summary.ok,
    report: formatReport(report),
  };
}
