import {
  normalizePolicy,
  type Address,
  type Hex,
  type Policy,
  type PolicyInput,
  type PolicyRuleInput,
  type TokenLimitInput,
} from '@keelcodes/policy';

/**
 * Environment-driven configuration for the `keel-mcp` bin.
 *
 * The library takes a `Policy` object; a process spawned by an MCP client has
 * no way to construct one, so the bin reads it from the environment instead.
 * This module is deliberately pure — the file read is injected — so the parsing
 * rules are unit-testable without touching the filesystem.
 *
 * Only three variables are read, and each one changes behaviour. Nothing here
 * is accepted "for completeness": an unused variable would be dead config, and
 * a policy that silently ignores half its settings is exactly the failure this
 * project refuses elsewhere.
 */

/** A subset of `process.env`. */
export type Env = Record<string, string | undefined>;

/** Raised for a missing or malformed environment configuration. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export const POLICY_ENV = 'KEEL_POLICY';
export const EXECUTOR_URL_ENV = 'KEEL_EXECUTOR_URL';
export const EXECUTOR_TOKEN_ENV = 'KEEL_EXECUTOR_TOKEN';

/** Where approved calls are forwarded. See {@link createHttpExecutor}. */
export interface ExecutorConfig {
  url: string;
  token?: string;
}

/** The configuration a `keel-mcp` process runs with. */
export interface RuntimeConfig {
  /** The normalised policy the server describes and enforces. */
  policy: Policy;
  /** Absent when `KEEL_EXECUTOR_URL` is unset: `keel_execute_call` then refuses. */
  executor?: ExecutorConfig;
  /** Human-readable origin of the policy, used in the server's instructions. */
  policySource: string;
}

/**
 * Reads the environment, or throws {@link ConfigError} explaining what to fix.
 *
 * `readFile` is injected so the caller decides how `@path` is resolved (the bin
 * passes `node:fs`); this keeps the module free of I/O.
 */
export function readEnvConfig(env: Env, readFile: (path: string) => string): RuntimeConfig {
  const raw = trimmed(env[POLICY_ENV]);
  if (raw === undefined) {
    throw new ConfigError(
      `no policy configured — set ${POLICY_ENV} to a policy JSON document, ` +
        `or to "@path/to/policy.json" to read one from disk`,
    );
  }

  const inline = !raw.startsWith('@');
  const source = inline ? `${POLICY_ENV} (inline)` : raw.slice(1);
  const text = inline ? raw : readPolicyFile(raw.slice(1), readFile);

  const policy = parsePolicy(text, source);
  const executor = readExecutor(env);
  return executor === undefined
    ? { policy, policySource: source }
    : { policy, executor, policySource: source };
}

/** Parses a policy JSON document and normalises it. Throws {@link ConfigError}. */
export function parsePolicy(text: string, source: string): Policy {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(`${source}: not valid JSON (${messageOf(error)})`);
  }
  try {
    return normalizePolicy(toPolicyInput(value, source));
  } catch (error) {
    throw new ConfigError(`${source}: ${messageOf(error)}`);
  }
}

function readPolicyFile(path: string, readFile: (path: string) => string): string {
  try {
    return readFile(path);
  } catch (error) {
    throw new ConfigError(`${POLICY_ENV}: cannot read "${path}" (${messageOf(error)})`);
  }
}

function readExecutor(env: Env): ExecutorConfig | undefined {
  const url = trimmed(env[EXECUTOR_URL_ENV]);
  if (url === undefined) return undefined;
  if (!/^https?:\/\/\S+$/.test(url)) {
    throw new ConfigError(`${EXECUTOR_URL_ENV}: expected an http(s) URL, got "${url}"`);
  }
  const token = trimmed(env[EXECUTOR_TOKEN_ENV]);
  return token === undefined ? { url } : { url, token };
}

// ============================================================================
// JSON → PolicyInput.
//
// JSON has no bigint, so the numeric fields arrive as decimal strings or
// numbers and have to be coerced before `normalizePolicy` sees them. Every
// field is checked here with a path-qualified message, because "policy is
// invalid" without a location is useless when the document is a config file.
// Address and selector *formats* are left to `normalizePolicy`, which already
// owns those rules and their error messages.
// ============================================================================

function toPolicyInput(value: unknown, source: string): PolicyInput {
  const root = asObject(value, source);

  const rules = root.rules;
  if (!Array.isArray(rules) || rules.length === 0) {
    throw new ConfigError(`${source}: "rules" must be a non-empty array`);
  }

  const input: PolicyInput = {
    rules: rules.map((rule, index) => toRuleInput(rule, `${source}.rules[${index}]`)),
  };

  const validAfter = optionalBigInt(root.validAfter, `${source}.validAfter`);
  const validUntil = optionalBigInt(root.validUntil, `${source}.validUntil`);
  if (validAfter !== undefined) input.validAfter = validAfter;
  if (validUntil !== undefined) input.validUntil = validUntil;

  return input;
}

function toRuleInput(value: unknown, at: string): PolicyRuleInput {
  const rule = asObject(value, at);
  const input: PolicyRuleInput = { target: requireString(rule.target, `${at}.target`) as Address };

  if (rule.selectors !== undefined) {
    if (!Array.isArray(rule.selectors)) throw new ConfigError(`${at}.selectors: expected an array`);
    input.selectors = rule.selectors.map(
      (selector, index) => requireString(selector, `${at}.selectors[${index}]`) as Hex,
    );
  }

  const maxPerTx = optionalBigInt(rule.maxPerTx, `${at}.maxPerTx`);
  const maxDaily = optionalBigInt(rule.maxDaily, `${at}.maxDaily`);
  const maxCalls = optionalNumber(rule.maxCalls, `${at}.maxCalls`);
  if (maxPerTx !== undefined) input.maxPerTx = maxPerTx;
  if (maxDaily !== undefined) input.maxDaily = maxDaily;
  if (maxCalls !== undefined) input.maxCalls = maxCalls;

  if (rule.tokenLimits !== undefined) {
    if (!Array.isArray(rule.tokenLimits)) {
      throw new ConfigError(`${at}.tokenLimits: expected an array`);
    }
    input.tokenLimits = rule.tokenLimits.map((limit, index) =>
      toTokenLimitInput(limit, `${at}.tokenLimits[${index}]`),
    );
  }

  return input;
}

function toTokenLimitInput(value: unknown, at: string): TokenLimitInput {
  const limit = asObject(value, at);
  const input: TokenLimitInput = { token: requireString(limit.token, `${at}.token`) as Address };

  const maxPerTx = optionalBigInt(limit.maxPerTx, `${at}.maxPerTx`);
  const maxDaily = optionalBigInt(limit.maxDaily, `${at}.maxDaily`);
  if (maxPerTx !== undefined) input.maxPerTx = maxPerTx;
  if (maxDaily !== undefined) input.maxDaily = maxDaily;

  return input;
}

function asObject(value: unknown, at: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ConfigError(`${at}: expected a JSON object`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, at: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ConfigError(`${at}: expected a non-empty string`);
  }
  return value;
}

function optionalBigInt(value: unknown, at: string): bigint | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  throw new ConfigError(`${at}: expected a non-negative integer or a decimal string, got ${preview(value)}`);
}

function optionalNumber(value: unknown, at: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  throw new ConfigError(`${at}: expected a non-negative integer, got ${preview(value)}`);
}

function trimmed(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const text = value.trim();
  return text.length === 0 ? undefined : text;
}

function preview(value: unknown): string {
  const text = JSON.stringify(value) ?? String(value);
  return text.length > 48 ? `${text.slice(0, 45)}…` : text;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
