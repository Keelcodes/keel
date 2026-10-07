#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { createMcpServer, createPolicyGate, createPolicyTools, serveStdio } from './index.js';
import { ConfigError, EXECUTOR_URL_ENV, readEnvConfig } from './config.js';
import { createHttpExecutor } from './executor.js';

/**
 * The `keel-mcp` entry point: a policy-aware MCP server over stdio, configured
 * entirely from the environment so an MCP client can launch it with nothing
 * but a `mcpServers` block.
 *
 *   KEEL_POLICY        policy JSON, inline or "@path/to/policy.json"  (required)
 *   KEEL_EXECUTOR_URL  http(s) endpoint approved calls are POSTed to  (optional)
 *   KEEL_EXECUTOR_TOKEN  bearer token for that endpoint               (optional)
 *
 * Failing to load a policy is fatal: a server that cannot enforce its policy
 * must not pretend to. It writes the reason to stderr and exits non-zero, which
 * is the only signal an MCP client surfaces.
 */

/** Kept in sync with `package.json`; shown in `initialize`. */
const SERVER_VERSION = '0.2.2';

function main(): void {
  let config;
  try {
    config = readEnvConfig(process.env, (path) => readFileSync(path, 'utf8'));
  } catch (error) {
    fail(error instanceof ConfigError ? error.message : `unexpected error: ${messageOf(error)}`);
    return;
  }

  const server = createMcpServer({
    name: 'keel',
    version: SERVER_VERSION,
    tools: createPolicyTools({
      policy: config.policy,
      ...(config.executor !== undefined ? { executor: createHttpExecutor(config.executor) } : {}),
    }),
    gate: createPolicyGate({ policy: config.policy }),
    instructions: instructionsFor(config.policySource, config.executor !== undefined),
  });

  serveStdio({
    server,
    input: process.stdin,
    output: process.stdout,
    onError: (error) => process.stderr.write(`keel-mcp: ${messageOf(error)}\n`),
  });
}

function instructionsFor(policySource: string, hasExecutor: boolean): string {
  const execution = hasExecutor
    ? 'keel_execute_call is available: an allowed call is forwarded to the configured executor.'
    : `keel_execute_call is unavailable — no executor is configured. Set ${EXECUTOR_URL_ENV} to enable execution.`;
  return (
    'Keel exposes a policy-bounded on-chain account to the model. ' +
    `The active policy is loaded from ${policySource}; every action is checked against it before it runs. ` +
    'A denied call is returned as a tool error and is never executed. ' +
    execution
  );
}

function fail(message: string): void {
  process.stderr.write(`keel-mcp: ${message}\n`);
  process.exitCode = 1;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

main();
