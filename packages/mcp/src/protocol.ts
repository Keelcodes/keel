/**
 * The MCP wire types this server speaks, plus the JSON-RPC 2.0 envelope they
 * ride on.
 *
 * Modelled on the Model Context Protocol revision `2025-06-18`
 * (https://modelcontextprotocol.io/specification/2025-06-18) — specifically the
 * `initialize`, `tools/list` and `tools/call` messages. Only the server side is
 * implemented, and only the parts a tool server needs.
 */

/** MCP revisions this server can speak, newest first. */
export const MCP_SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;

/** The revision advertised when a client asks for one we do not know. */
export const MCP_PROTOCOL_VERSION = MCP_SUPPORTED_VERSIONS[0];

export const MCP_METHODS = {
  INITIALIZE: 'initialize',
  INITIALIZED: 'notifications/initialized',
  PING: 'ping',
  TOOLS_LIST: 'tools/list',
  TOOLS_CALL: 'tools/call',
} as const;

/** JSON-RPC 2.0 error codes (https://www.jsonrpc.org/specification#error_object). */
export const JSONRPC_ERROR = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  /** Absent on notifications, which must not be answered. */
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result: unknown;
}

export interface JsonRpcErrorBody {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcFailure {
  jsonrpc: '2.0';
  id: JsonRpcId;
  error: JsonRpcErrorBody;
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

export function rpcError(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcFailure {
  return { jsonrpc: '2.0', id, error: data === undefined ? { code, message } : { code, message, data } };
}

export interface McpServerInfo {
  name: string;
  version: string;
}

export interface McpInitializeResult {
  protocolVersion: string;
  capabilities: { tools: { listChanged: boolean } };
  serverInfo: McpServerInfo;
  instructions?: string;
}

/** A text item in a tool result. The only content type this server emits. */
export interface McpTextContent {
  type: 'text';
  text: string;
}

/**
 * A tool result. `isError: true` marks a *tool* failure (including a policy
 * denial), which the model sees as output and can react to — as opposed to a
 * JSON-RPC error, which aborts the call.
 */
export interface McpToolResult {
  content: McpTextContent[];
  isError?: boolean;
  /** Machine-readable payload mirroring `content`, when there is one. */
  structuredContent?: unknown;
}
