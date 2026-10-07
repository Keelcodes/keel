import {
  ERC7710_SUITE,
  ERC7715_SUITE,
  ERC7579_SUITE,
  ERC8004_SUITE,
  createViemAgentRegistryReader,
  createViemDelegationReader,
  createViemReader,
  formatReport,
  runSuite,
  type CheckTarget,
  type Suite,
} from '@keelcodes/conformance';
import { createModuleRegistry, routeSession, type ModuleDescriptor } from '@keelcodes/migrate';
import {
  evaluateCall,
  normalizePolicy,
  policyCommitment,
  toCall,
  type Address,
  type Call,
  type Policy,
  type PolicyInput,
  type PolicyRuleInput,
  type TokenLimitInput,
} from '@keelcodes/policy';
import { createPublicClient, http, type PublicClient } from 'viem';
import type { ParsedArgs } from './args.js';
import { UsageError } from './errors.js';
import { readInput, type CliIo } from './io.js';
import { cliPackage } from './version.js';

// ============================================================================
// Commands.
//
// Each command writes its own output and returns a process exit code: 0 for
// success, 1 for a subject-level failure (a denied call, a failing suite), and
// 2 for a usage error — which `runCli` raises as a `UsageError` instead.
// ============================================================================

/** `keel version` — print the CLI's own name and version. */
export function versionCommand(args: ParsedArgs, io: CliIo): number {
  const pkg = cliPackage();
  if (args.bool('json')) io.out(JSON.stringify(pkg, null, 2));
  else io.out(`${pkg.name} ${pkg.version}`);
  return 0;
}

/**
 * `keel policy check` — normalise a policy and print its commitment. When a
 * target is given, also dry-run a call against it. Exit code 1 when the call is
 * denied, so it composes with `&&` in a script.
 */
export async function policyCheck(args: ParsedArgs, io: CliIo): Promise<number> {
  const policy = normalizePolicy(parsePolicyInput(await readJson(io, args.require('policy'))));
  const commitment = policyCommitment(policy);

  const target = args.get('target');
  if (target === undefined) {
    if (args.bool('json')) {
      io.out(JSON.stringify({ commitment, policy: policyJson(policy) }, null, 2));
    } else {
      io.out(`policy ${commitment}`);
      for (const [index, rule] of policy.rules.entries()) {
        io.out(
          `  rule ${index}: target=${rule.target} selectors=${rule.selectors.length === 0 ? 'any' : rule.selectors.join(',')} maxPerTx=${rule.maxPerTx} maxDaily=${rule.maxDaily} maxCalls=${rule.maxCalls} tokens=${rule.tokenLimits.length}`,
        );
      }
    }
    return 0;
  }

  const valueArg = args.get('value');
  const dataArg = args.get('data');
  const call = toCall({
    target: target as Address,
    ...(valueArg !== undefined ? { value: parseWei(valueArg, '--value') } : {}),
    ...(dataArg !== undefined ? { data: dataArg as Address } : {}),
  });
  const now = args.int('at') ?? BigInt(Math.floor(Date.now() / 1000));
  const decision = evaluateCall(policy, { now, usage: [] }, call);

  if (args.bool('json')) {
    io.out(JSON.stringify({ commitment, call: callJson(call), decision }, null, 2));
  } else {
    io.out(`commitment ${commitment}`);
    io.out(`call target=${call.target} value=${call.value} selector=${call.selector}`);
    if (decision.allowed) {
      io.out(`allow rule=${decision.ruleIndex}`);
    } else {
      const rule = decision.ruleIndex === undefined ? '' : ` rule=${decision.ruleIndex}`;
      io.out(`deny reason=${decision.reason}${rule}`);
    }
  }
  return decision.allowed ? 0 : 1;
}

/**
 * `keel migrate route` — route a session record to its module generation using a
 * registry read from a JSON file.
 */
export async function migrateRoute(args: ParsedArgs, io: CliIo): Promise<number> {
  const raw = await readJson(io, args.require('registry'));
  const { modules, defaultVersion } = readRegistry(raw);
  const registry = createModuleRegistry(modules, defaultVersion === undefined ? {} : { defaultVersion });

  const id = args.require('id');
  const moduleVersion = args.get('module-version');
  const routed = routeSession(registry, {
    id,
    ...(moduleVersion === undefined ? {} : { moduleVersion }),
  });

  if (args.bool('json')) {
    io.out(
      JSON.stringify(
        { session: { id, ...(moduleVersion === undefined ? {} : { moduleVersion }) }, module: routed },
        null,
        2,
      ),
    );
  } else {
    const version = moduleVersion === undefined ? 'no moduleVersion' : `moduleVersion ${moduleVersion}`;
    io.out(`session ${id} (${version})`);
    const address = routed.address === undefined ? '' : ` address=${routed.address}`;
    io.out(
      `  → ${routed.version} encoding=${routed.encoding} multiSession=${routed.multiSession} enforcedLimits=${routed.enforcedLimits}${address}`,
    );
  }
  return 0;
}

/** `keel conformance list` — print the available suites and their check counts. */
export function conformanceList(args: ParsedArgs, io: CliIo): number {
  if (args.bool('json')) {
    io.out(
      JSON.stringify(
        SUITES.map((suite) => ({ name: suite.name, spec: suite.spec, checks: suite.checks.length })),
        null,
        2,
      ),
    );
    return 0;
  }
  for (const suite of SUITES) {
    io.out(`${suite.name} · ${suite.spec} · ${suite.checks.length} checks`);
  }
  return 0;
}

/**
 * `keel conformance run` — run one suite against a live chain. Exit code 1 when
 * the suite fails (any check, or a critical one).
 */
export async function conformanceRun(args: ParsedArgs, io: CliIo): Promise<number> {
  const suite = suiteFromKey(args.get('suite') ?? 'erc7579');
  const rpc = args.get('rpc') ?? io.env.KEEL_RPC_URL;
  if (rpc === undefined) {
    throw new UsageError('missing required option --rpc (or the KEEL_RPC_URL environment variable)');
  }

  const client = createPublicClient({ transport: http(rpc) });
  const report = await runSuite(conformanceTarget(suite, args, client), suite);

  if (args.bool('json')) io.out(JSON.stringify(report, null, 2));
  else io.out(formatReport(report));
  return report.summary.ok ? 0 : 1;
}

// ============================================================================
// Suite selection.
// ============================================================================

const SUITES: readonly Suite[] = [ERC7579_SUITE, ERC7710_SUITE, ERC7715_SUITE, ERC8004_SUITE];

const SUITE_BY_KEY: Readonly<Record<string, Suite>> = {
  erc7579: ERC7579_SUITE,
  '7579': ERC7579_SUITE,
  erc7710: ERC7710_SUITE,
  '7710': ERC7710_SUITE,
  erc7715: ERC7715_SUITE,
  '7715': ERC7715_SUITE,
  erc8004: ERC8004_SUITE,
  '8004': ERC8004_SUITE,
};

function suiteFromKey(key: string): Suite {
  const suite = SUITE_BY_KEY[key.toLowerCase()];
  if (suite === undefined) {
    throw new UsageError(`unknown suite "${key}"; known suites: ${SUITES.map((entry) => entry.name).join(', ')}`);
  }
  return suite;
}

/**
 * Binds a suite to its target from flags. ERC-7579, 7710 and 8004 read from the
 * chain, so the CLI can wire them from an RPC URL; ERC-7715 needs a wallet
 * (EIP-1193) provider, which the CLI cannot construct.
 */
function conformanceTarget(suite: Suite, args: ParsedArgs, client: PublicClient): CheckTarget {
  switch (suite.name) {
    case 'ERC-7579':
      return {
        reader: createViemReader(client),
        account: args.require('account') as Address,
        module: args.require('module') as Address,
        moduleTypeId: args.int('type') ?? 1n,
      };
    case 'ERC-7710':
      return { delegation: createViemDelegationReader(client, args.require('manager') as Address) };
    case 'ERC-8004': {
      const agentId = args.int('agent-id');
      if (agentId === undefined) throw new UsageError('missing required option --agent-id for the ERC-8004 suite');
      const reputationRegistry = args.get('reputation-registry');
      return {
        agentRegistry: createViemAgentRegistryReader(client, {
          identityRegistry: args.require('identity-registry') as Address,
          agentId,
          ...(reputationRegistry === undefined ? {} : { reputationRegistry: reputationRegistry as Address }),
        }),
      };
    }
    default:
      throw new UsageError(
        `the ${suite.name} suite needs a wallet provider, which the CLI cannot construct; run it via the SDK`,
      );
  }
}

// ============================================================================
// Input parsing.
// ============================================================================

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readJson(io: CliIo, path: string): Promise<unknown> {
  const text = await readInput(io, path);
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`${path}: not valid JSON: ${messageOf(error)}`);
  }
}

function asRecord(value: unknown, at: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${at}: expected an object`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, at: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${at}: expected a non-empty string`);
  return value;
}

function optionalBigint(record: Record<string, unknown>, key: string, at: string): bigint | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) throw new Error(`${at}.${key}: expected an integer`);
    return BigInt(value);
  }
  if (typeof value === 'string') {
    try {
      return BigInt(value);
    } catch {
      throw new Error(`${at}.${key}: expected a decimal integer string, got "${value}"`);
    }
  }
  throw new Error(`${at}.${key}: expected a decimal integer string`);
}

function optionalNumber(record: Record<string, unknown>, key: string, at: string): number | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  if (!Number.isInteger(parsed)) throw new Error(`${at}.${key}: expected an integer`);
  return parsed;
}

/**
 * Parses a policy as authored: the {@link PolicyInput} shape, with wei amounts
 * written as decimal strings because JSON has no bigint. Throws a plain `Error`
 * on a malformed shape — `normalizePolicy` then validates the meaning.
 */
export function parsePolicyInput(value: unknown): PolicyInput {
  const record = asRecord(value, 'policy');
  const rules = record.rules;
  if (!Array.isArray(rules)) throw new Error('policy.rules: expected an array');

  const validAfter = optionalBigint(record, 'validAfter', 'policy');
  const validUntil = optionalBigint(record, 'validUntil', 'policy');
  return {
    rules: rules.map((rule, index) => parseRule(rule, `policy.rules[${index}]`)),
    ...(validAfter === undefined ? {} : { validAfter }),
    ...(validUntil === undefined ? {} : { validUntil }),
  };
}

function parseRule(value: unknown, at: string): PolicyRuleInput {
  const record = asRecord(value, at);
  const target = asString(record.target, `${at}.target`) as Address;

  const selectorsRaw = record.selectors;
  const selectors =
    selectorsRaw === undefined || selectorsRaw === null
      ? undefined
      : parseArray(selectorsRaw, `${at}.selectors`).map((selector, index) =>
          asString(selector, `${at}.selectors[${index}]`) as Address,
        );

  const tokenLimitsRaw = record.tokenLimits;
  const tokenLimits =
    tokenLimitsRaw === undefined || tokenLimitsRaw === null
      ? undefined
      : parseArray(tokenLimitsRaw, `${at}.tokenLimits`).map((limit, index) =>
          parseTokenLimit(limit, `${at}.tokenLimits[${index}]`),
        );

  const maxPerTx = optionalBigint(record, 'maxPerTx', at);
  const maxDaily = optionalBigint(record, 'maxDaily', at);
  const maxCalls = optionalNumber(record, 'maxCalls', at);

  return {
    target,
    ...(selectors === undefined ? {} : { selectors }),
    ...(maxPerTx === undefined ? {} : { maxPerTx }),
    ...(maxDaily === undefined ? {} : { maxDaily }),
    ...(maxCalls === undefined ? {} : { maxCalls }),
    ...(tokenLimits === undefined ? {} : { tokenLimits }),
  };
}

function parseTokenLimit(value: unknown, at: string): TokenLimitInput {
  const record = asRecord(value, at);
  const token = asString(record.token, `${at}.token`) as Address;
  const maxPerTx = optionalBigint(record, 'maxPerTx', at);
  const maxDaily = optionalBigint(record, 'maxDaily', at);
  return {
    token,
    ...(maxPerTx === undefined ? {} : { maxPerTx }),
    ...(maxDaily === undefined ? {} : { maxDaily }),
  };
}

function parseArray(value: unknown, at: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${at}: expected an array`);
  return value;
}

function readRegistry(raw: unknown): { modules: readonly ModuleDescriptor[]; defaultVersion?: string } {
  if (Array.isArray(raw)) {
    return { modules: raw.map((module, index) => parseModuleDescriptor(module, `modules[${index}]`)) };
  }

  const record = asRecord(raw, 'registry');
  if (!Array.isArray(record.modules)) throw new Error('registry.modules: expected an array');
  const modules = record.modules.map((module, index) => parseModuleDescriptor(module, `modules[${index}]`));
  if (record.defaultVersion === undefined || record.defaultVersion === null) return { modules };
  return { modules, defaultVersion: asString(record.defaultVersion, 'registry.defaultVersion') };
}

function parseModuleDescriptor(value: unknown, at: string): ModuleDescriptor {
  const record = asRecord(value, at);
  const encoding = asString(record.encoding, `${at}.encoding`);
  if (encoding !== 'onchain' && encoding !== 'payload') {
    throw new Error(`${at}.encoding: expected "onchain" or "payload", got "${encoding}"`);
  }
  if (typeof record.multiSession !== 'boolean') throw new Error(`${at}.multiSession: expected a boolean`);
  if (typeof record.enforcedLimits !== 'boolean') throw new Error(`${at}.enforcedLimits: expected a boolean`);

  const address = record.address;
  if (address !== undefined && address !== null && typeof address !== 'string') {
    throw new Error(`${at}.address: expected a string`);
  }
  return {
    version: asString(record.version, `${at}.version`),
    encoding,
    multiSession: record.multiSession,
    enforcedLimits: record.enforcedLimits,
    ...(typeof address === 'string' ? { address } : {}),
  };
}

// ============================================================================
// Output rendering.
// ============================================================================

function parseWei(value: string, at: string): bigint {
  try {
    return BigInt(value);
  } catch {
    throw new UsageError(`${at} must be a decimal integer of wei, got "${value}"`);
  }
}

/** A JSON-safe rendering of a normalised policy (bigints become decimal strings). */
function policyJson(policy: Policy): Record<string, unknown> {
  return {
    version: policy.version,
    validAfter: policy.validAfter.toString(),
    validUntil: policy.validUntil.toString(),
    rules: policy.rules.map((rule) => ({
      target: rule.target,
      selectors: [...rule.selectors],
      maxPerTx: rule.maxPerTx.toString(),
      maxDaily: rule.maxDaily.toString(),
      maxCalls: rule.maxCalls,
      tokenLimits: rule.tokenLimits.map((limit) => ({
        token: limit.token,
        maxPerTx: limit.maxPerTx.toString(),
        maxDaily: limit.maxDaily.toString(),
      })),
    })),
  };
}

/** A JSON-safe rendering of a call. */
function callJson(call: Call): Record<string, unknown> {
  return { target: call.target, value: call.value.toString(), data: call.data, selector: call.selector };
}
