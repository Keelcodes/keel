#!/usr/bin/env node
// Emits a conformance report for the Foundry red-team suite, so the adversarial
// cases run through the *same* report machinery as the standards suites.
//
//   node scripts/redteam-report.mjs
//   node scripts/redteam-report.mjs --contracts-dir /path/to/contracts
//   node scripts/redteam-report.mjs --input forge-redteam.json
//
// Requires the package to be built first (`pnpm --filter @keelcodes/conformance
// build`), since it imports the emitted dist. Cases that Foundry did not run are
// reported as "not run" and fail the run — an unverified threat is never green.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const repoRoot = resolve(pkgRoot, '..', '..');
const distEntry = resolve(pkgRoot, 'dist', 'index.js');

if (!existsSync(distEntry)) {
  console.error(
    '[redteam] packages/conformance/dist not found — run `pnpm --filter @keelcodes/conformance build` first.',
  );
  process.exit(2);
}

const { REDTEAM_CASES, REDTEAM_SUITE, formatReport, parseForgeRedTeamReport, runSuite, toRedTeamPort } =
  await import(distEntry);

const argv = process.argv.slice(2);
let input;
let contractsDir = resolve(repoRoot, 'contracts');
for (let index = 0; index < argv.length; index += 1) {
  if (argv[index] === '--input') input = argv[index + 1];
  else if (argv[index] === '--contracts-dir') contractsDir = resolve(argv[index + 1]);
}

let raw = '{}';
if (input !== undefined) {
  raw = readFileSync(resolve(process.cwd(), input), 'utf8');
} else {
  const forge = spawnSync('forge', ['test', '--match-path', 'test/redteam/*', '--json'], {
    cwd: contractsDir,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (forge.error) {
    console.error(`[redteam] could not run forge (${forge.error.message}) — reporting every case as not run.`);
  } else {
    raw = forge.stdout || '{}';
    if (forge.status !== 0) {
      console.error(`[redteam] forge exited with status ${forge.status}; parsing stdout.`);
      if (forge.stderr) console.error(forge.stderr.trim());
    }
  }
}

let forgeJson = {};
try {
  forgeJson = JSON.parse(raw);
} catch (error) {
  console.error(`[redteam] could not parse forge JSON: ${error.message} — reporting every case as not run.`);
}

const results = parseForgeRedTeamReport(forgeJson);
const report = await runSuite({ redTeam: toRedTeamPort(results) }, REDTEAM_SUITE);
console.log(formatReport(report));

console.log(`\nThreat mapping (${Object.keys(results).length} case(s) executed):`);
for (const testCase of REDTEAM_CASES) {
  const outcome = results[testCase.test];
  const label = outcome === undefined ? 'not run' : outcome ? 'verified' : 'FAILED  ';
  console.log(`  ${label}  ${testCase.threat}  ${testCase.test}`);
}

process.exit(report.summary.ok ? 0 : 1);
