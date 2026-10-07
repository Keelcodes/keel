/**
 * @keelcodes/mcp
 *
 * A **policy-aware MCP server**: it exposes on-chain actions to a model as MCP
 * tools, and every action passes through `@keelcodes/policy` before it runs.
 *
 * The server implements the server side of the Model Context Protocol revision
 * `2025-06-18` — `initialize`, `tools/list`, `tools/call` — over the
 * newline-delimited stdio transport, and ships three built-in tools
 * ({@link createPolicyTools}): read the policy, dry-run a call, execute a call.
 *
 * What makes it *policy-aware* rather than merely *policy-documented*: a denied
 * call never reaches the tool's handler. The gate stands in front of `run`, so
 * the account cannot be instructed past the policy even by a misbehaving model.
 *
 * @packageDocumentation
 */

export {
  JSONRPC_ERROR,
  MCP_METHODS,
  MCP_PROTOCOL_VERSION,
  MCP_SUPPORTED_VERSIONS,
  rpcError,
} from './protocol.js';
export type {
  JsonRpcErrorBody,
  JsonRpcFailure,
  JsonRpcId,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcSuccess,
  McpInitializeResult,
  McpServerInfo,
  McpTextContent,
  McpToolResult,
} from './protocol.js';

export { DENY_ALL, createPolicyGate } from './gate.js';
export type {
  GateDecision,
  GateVerdict,
  PolicyGate,
  PolicyGateOptions,
  ToolAction,
} from './gate.js';

export { ToolRegistry, errorResult, jsonReplacer, jsonResult, textResult } from './tools.js';
export type { JsonSchema, McpTool, ToolArgs, ToolDescriptor } from './tools.js';

export { createMcpServer } from './server.js';
export type { McpServer, McpServerOptions } from './server.js';

export { serveStdio } from './stdio.js';
export type { ReadableLike, ServeStdioOptions, WritableLike } from './stdio.js';

export { createPolicyTools, describeCall, describePolicy } from './builtin.js';
export type { CallExecutor, PolicyToolsOptions } from './builtin.js';

export { createPimTools } from './pim.js';

// Environment-driven configuration, for the `keel-mcp` bin and any host that
// prefers to configure the server from a process environment.
export {
  ConfigError,
  EXECUTOR_TOKEN_ENV,
  EXECUTOR_URL_ENV,
  POLICY_ENV,
  parsePolicy,
  readEnvConfig,
} from './config.js';
export type { Env, ExecutorConfig, RuntimeConfig } from './config.js';

export { createHttpExecutor } from './executor.js';
export type { ExecutorRequest, ExecutorResponseLike, FetchLike } from './executor.js';
