import { evaluateCall, policyCommitment, toCall, type Call, type Policy } from '@keelcodes/policy';
import { errorResult, jsonResult, type JsonSchema, type McpTool, type ToolArgs } from './tools.js';

/**
 * The built-in, policy-aware tools.
 *
 * These are the three moves an agent needs in front of a policy-bounded account,
 * in the order it needs them:
 *
 * 1. `keel_policy` — read what it is allowed to do.
 * 2. `keel_check_call` — dry-run a call and learn the verdict before spending.
 * 3. `keel_execute_call` — execute, gated: a denied call never reaches the
 *    executor.
 *
 * Reading and dry-running are deliberately **not** gated — refusing them would
 * only hide the policy from the model and push it to guess.
 */

/** Runs a policy-approved call. Wire it to a bundler/paymaster via `@keelcodes/adapters`. */
export type CallExecutor = (call: Call) => Promise<Record<string, unknown>> | Record<string, unknown>;

export interface PolicyToolsOptions {
  /** The normalised policy these tools describe and enforce. */
  policy: Policy;
  /** Required for `keel_execute_call`; without it that tool reports unavailable. */
  executor?: CallExecutor;
  /** Clock for the dry-run; defaults to the wall clock. */
  now?: () => bigint;
}

const CALL_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    target: { type: 'string', description: 'Contract or recipient address, 0x-prefixed.' },
    value: { type: 'string', description: 'Native value in wei as a decimal string. Defaults to "0".' },
    data: { type: 'string', description: 'Call data, 0x-prefixed. Defaults to "0x", a plain value transfer.' },
  },
  required: ['target'],
  additionalProperties: false,
};

const EMPTY_SCHEMA: JsonSchema = { type: 'object', properties: {}, additionalProperties: false };

export function createPolicyTools(options: PolicyToolsOptions): McpTool[] {
  const { policy } = options;
  const now = options.now ?? (() => BigInt(Math.floor(Date.now() / 1000)));

  const policyTool: McpTool = {
    name: 'keel_policy',
    title: 'Keel policy',
    description:
      'Return the authorization policy this server enforces: its canonical commitment hash and normalised rules. Read-only.',
    inputSchema: EMPTY_SCHEMA,
    run: () => jsonResult({ commitment: policyCommitment(policy), policy: describePolicy(policy) }),
  };

  const checkTool: McpTool = {
    name: 'keel_check_call',
    title: 'Dry-run a call against the policy',
    description:
      'Evaluate a proposed call against the policy without executing it. Returns whether it would be allowed and, if not, the exact rule that refused it. Read-only and never gated.',
    inputSchema: CALL_SCHEMA,
    run: (args: ToolArgs) => {
      const call = callFromArgs(args);
      const decision = evaluateCall(policy, { now: now(), usage: [] }, call);
      return jsonResult({
        allowed: decision.allowed,
        ...(decision.reason !== undefined ? { reason: decision.reason } : {}),
        ...(decision.ruleIndex !== undefined ? { ruleIndex: decision.ruleIndex } : {}),
      });
    },
  };

  const executeTool: McpTool = {
    name: 'keel_execute_call',
    title: 'Execute a policy-approved call',
    description:
      'Execute a call on the agent account. The call is checked against the policy first; a denied call is never executed.',
    inputSchema: CALL_SCHEMA,
    action: (args: ToolArgs) => ({ kind: 'execute-call', call: callFromArgs(args) }),
    run: async (args: ToolArgs) => {
      if (options.executor === undefined) {
        return errorResult('this server has no call executor configured; keel_execute_call is unavailable');
      }
      const call = callFromArgs(args);
      const outcome = await options.executor(call);
      return jsonResult({ executed: true, call: describeCall(call), ...outcome });
    },
  };

  return [policyTool, checkTool, executeTool];
}

/** A JSON-safe rendering of a normalised policy (bigints become decimal strings). */
export function describePolicy(policy: Policy): Record<string, unknown> {
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
export function describeCall(call: Call): Record<string, unknown> {
  return {
    target: call.target,
    value: call.value.toString(),
    data: call.data,
    selector: call.selector,
  };
}

function callFromArgs(args: ToolArgs): Call {
  const target = requireString(args, 'target');
  const data = args.data === undefined ? undefined : requireString(args, 'data');
  const value = args.value === undefined ? 0n : parseWei(args.value);
  return toCall({
    target: target as `0x${string}`,
    value,
    ...(data !== undefined ? { data: data as `0x${string}` } : {}),
  });
}

function parseWei(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value !== 'string') throw new Error('"value" must be a decimal string of wei');
  try {
    return BigInt(value);
  } catch {
    throw new Error(`"value" is not a valid integer: "${value}"`);
  }
}

function requireString(args: ToolArgs, name: string): string {
  const value = args[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`"${name}" is required and must be a non-empty string`);
  }
  return value;
}
