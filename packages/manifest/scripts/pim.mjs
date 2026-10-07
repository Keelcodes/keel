#!/usr/bin/env node
// ============================================================================
// ERC-8313 PIM consumer CLI.
//
//   node scripts/pim.mjs validate <file>   # structural + semantic validation
//   node scripts/pim.mjs inspect  <file>   # summary + trust level
//   node scripts/pim.mjs keel --chain-id 8453 --policy-hook 0x… --bounded-actions 0x…
//
// Reads the built package (`../dist/index.js`); run `pnpm build` first. Uses
// only `node:util` parseArgs — no third-party argument parser.
// ============================================================================

import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';

async function load() {
  try {
    return await import('../dist/index.js');
  } catch (error) {
    console.error('Could not load @keelcodes/manifest from ./dist.');
    console.error('Build the package first:  pnpm --filter @keelcodes/manifest build');
    throw error;
  }
}

const { PIM_DRAFT, buildKeelPim, trustLevelOf, validatePim } = await load();

const HELP = `ERC-8313 Protocol Interaction Manifest (draft ${PIM_DRAFT})

Usage:
  node scripts/pim.mjs validate <file> [--chain-id <id>] [--now <unix>]
  node scripts/pim.mjs inspect  <file>
  node scripts/pim.mjs keel --policy-hook <0x…> --bounded-actions <0x…> [--chain-id <id> ...]

Commands:
  validate   Check a manifest; exits non-zero when any error is found.
  inspect    Print protocol, chains, intents, contracts and trust level.
  keel       Emit Keel's own manifest as JSON on stdout.`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    'chain-id': { type: 'string', multiple: true },
    'policy-hook': { type: 'string' },
    'bounded-actions': { type: 'string' },
    now: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});

if (values.help || positionals.length === 0) {
  console.log(HELP);
  process.exit(positionals.length === 0 && !values.help ? 1 : 0);
}

const command = positionals[0];

switch (command) {
  case 'validate':
    await cmdValidate();
    break;
  case 'inspect':
    await cmdInspect();
    break;
  case 'keel':
    await cmdKeel();
    break;
  default:
    console.error(`unknown command "${command}"\n`);
    console.log(HELP);
    process.exit(1);
}

function readPim(file) {
  if (!file) fail('a <file> argument is required');
  const absolute = resolve(process.cwd(), file);
  let text;
  try {
    text = readFileSync(absolute, 'utf8');
  } catch (error) {
    fail(`could not read ${absolute}: ${error.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(`${absolute} is not valid JSON: ${error.message}`);
  }
}

async function cmdValidate() {
  const pim = readPim(positionals[1]);
  const options = {};
  if (values.now !== undefined) options.now = parseIntFlag(values.now, '--now');
  const chains = chainIds();
  if (chains.length === 1) options.chainId = chains[0];

  const result = validatePim(pim, options);
  printIssues(result);
  if (result.valid) {
    console.log('valid: no errors');
  } else {
    console.log(`invalid: ${result.errors.length} error(s), ${result.warnings.length} warning(s)`);
    process.exit(1);
  }
}

async function cmdInspect() {
  const pim = readPim(positionals[1]);
  const result = validatePim(pim);
  const trust = await trustLevelOf(pim);

  const metadata = isObject(pim.metadata) ? pim.metadata : {};
  console.log(`Protocol:    ${metadata.protocol ?? '(unknown)'}`);
  console.log(`Category:    ${metadata.category ?? '(unknown)'}`);
  console.log(`PIM version: ${metadata.pimVersion ?? '(unknown)'}`);
  console.log(`Chains:      ${Array.isArray(metadata.chainId) ? metadata.chainId.join(', ') : '(unknown)'}`);
  console.log(`Valid:       ${result.valid ? 'yes' : `no (${result.errors.length} error(s))`}`);
  console.log(`Trust:       Level ${trust.level} (${trust.name}) — ${trust.reason}`);

  console.log('Contracts:');
  for (const [name, contract] of entries(pim.contracts)) {
    const where = contract.address ?? `lookup:${contract.lookup}`;
    console.log(`  - ${name} (${contract.role}): ${contract.description} [${where}]`);
  }

  console.log('Intents:');
  for (const [name, intent] of entries(pim.intents)) {
    console.log(`  - ${name}: ${intent.description}`);
  }

  if (!result.valid) printIssues(result);
}

async function cmdKeel() {
  if (!values['policy-hook']) fail('--policy-hook <0x…> is required');
  if (!values['bounded-actions']) fail('--bounded-actions <0x…> is required');

  const options = {
    policyHook: values['policy-hook'],
    boundedActions: values['bounded-actions'],
  };
  const chains = chainIds();
  if (chains.length > 0) options.chainId = chains;

  let pim;
  try {
    pim = buildKeelPim(options);
  } catch (error) {
    fail(error.message);
  }

  const result = validatePim(pim);
  if (!result.valid) {
    // Should never happen; surface it loudly rather than emit a bad manifest.
    printIssues(result);
    fail('internal error: generated Keel PIM failed validation');
  }
  console.log(JSON.stringify(pim, null, 2));
}

function chainIds() {
  return (values['chain-id'] ?? []).map((value) => parseIntFlag(value, '--chain-id'));
}

function parseIntFlag(value, flag) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) fail(`${flag} must be a positive integer, got "${value}"`);
  return parsed;
}

function printIssues(result) {
  for (const issue of [...result.errors, ...result.warnings]) {
    console.log(`[${issue.severity}] ${issue.path || '<root>'}: ${issue.message}`);
  }
}

function entries(value) {
  return isObject(value) ? Object.entries(value) : [];
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}
