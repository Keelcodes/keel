import type { ConformanceReport, Severity } from './types.js';

const SEVERITY_MARK: Record<Severity, string> = {
  critical: '!!',
  high: '! ',
  medium: '· ',
  low: '  ',
};

/** Renders a report as human-readable lines. */
export function formatReport(report: ConformanceReport): string {
  const subject: string[] = [];
  if (report.account !== undefined) subject.push(`account ${report.account}`);
  if (report.module !== undefined) subject.push(`module ${report.module}`);
  if (report.moduleTypeId !== undefined && report.moduleTypeId !== 0n) {
    subject.push(`type ${report.moduleTypeId}`);
  }
  const suffix = subject.length > 0 ? ` · ${subject.join(' · ')}` : '';

  const lines: string[] = [
    `${report.summary.ok ? 'PASS' : 'FAIL'} · ${report.suite} · ${report.results.length} checks${suffix}`,
  ];
  for (const result of report.results) {
    const mark = result.status === 'pass' ? '✓' : '✗';
    lines.push(
      `  ${mark} ${SEVERITY_MARK[result.severity]} ${result.id} — ${result.message}`,
    );
  }
  const { passed, failed, criticalFailures } = report.summary;
  lines.push(
    `${passed} passed · ${failed} failed (${criticalFailures} critical) · ${report.durationMs}ms`,
  );
  return lines.join('\n');
}
