import { DENY_ALL, type PolicyGate, type ToolAction } from './gate.js';
import {
  JSONRPC_ERROR,
  MCP_METHODS,
  MCP_PROTOCOL_VERSION,
  MCP_SUPPORTED_VERSIONS,
  rpcError,
  type JsonRpcId,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type McpInitializeResult,
} from './protocol.js';
import { ToolRegistry, errorResult, type McpTool } from './tools.js';

export interface McpServerOptions {
  /** Server name reported in `initialize`. */
  name: string;
  version: string;
  tools: readonly McpTool[];
  /**
   * The gate every tool action passes through before it runs. Defaults to
   * {@link DENY_ALL} — a server with no policy must not be able to act.
   */
  gate?: PolicyGate;
  /** Optional guidance returned to the client in `initialize`. */
  instructions?: string;
}

export interface McpServer {
  readonly tools: ToolRegistry;
  /** Handles one JSON-RPC message; returns `undefined` for notifications. */
  handle(request: JsonRpcRequest): Promise<JsonRpcResponse | undefined>;
}

export function createMcpServer(options: McpServerOptions): McpServer {
  const tools = new ToolRegistry(options.tools);
  const gate = options.gate ?? DENY_ALL;

  function initialize(params: unknown): McpInitializeResult {
    const requested =
      isObject(params) && typeof params.protocolVersion === 'string' ? params.protocolVersion : undefined;
    const protocolVersion =
      requested !== undefined && (MCP_SUPPORTED_VERSIONS as readonly string[]).includes(requested)
        ? requested
        : MCP_PROTOCOL_VERSION;

    const result: McpInitializeResult = {
      protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: options.name, version: options.version },
    };
    if (options.instructions !== undefined) result.instructions = options.instructions;
    return result;
  }

  async function callTool(id: JsonRpcId, params: unknown): Promise<JsonRpcResponse> {
    if (!isObject(params) || typeof params.name !== 'string') {
      return rpcError(id, JSONRPC_ERROR.INVALID_PARAMS, 'tools/call requires a "name" string');
    }

    const tool = tools.get(params.name);
    if (tool === undefined) {
      return rpcError(id, JSONRPC_ERROR.INVALID_PARAMS, `unknown tool "${params.name}"`);
    }

    const args = isObject(params.arguments) ? params.arguments : {};

    // The gate stands in front of every action. A denial is a *tool* result, not
    // a protocol error: the model sees why it was refused and can propose
    // something else, which is the whole point of being policy-aware.
    let action: ToolAction | undefined;
    try {
      action = tool.action?.(args);
    } catch (error) {
      return { jsonrpc: '2.0', id, result: errorResult(messageOf(error)) };
    }

    if (action !== undefined) {
      const decision = await gate.check(action);
      if (decision.verdict === 'deny') {
        return {
          jsonrpc: '2.0',
          id,
          result: errorResult(decision.reason ?? `policy denied ${action.kind}`, {
            denied: true,
            kind: action.kind,
            ...(decision.ruleIndex !== undefined ? { ruleIndex: decision.ruleIndex } : {}),
          }),
        };
      }
    }

    try {
      return { jsonrpc: '2.0', id, result: await tool.run(args) };
    } catch (error) {
      return { jsonrpc: '2.0', id, result: errorResult(messageOf(error)) };
    }
  }

  return {
    tools,

    async handle(request: JsonRpcRequest): Promise<JsonRpcResponse | undefined> {
      const id = request.id ?? null;
      const isNotification = request.id === undefined;

      switch (request.method) {
        case MCP_METHODS.INITIALIZE:
          return isNotification ? undefined : { jsonrpc: '2.0', id, result: initialize(request.params) };

        // A notification: the client confirming it is ready. No reply, ever.
        case MCP_METHODS.INITIALIZED:
          return undefined;

        case MCP_METHODS.PING:
          return isNotification ? undefined : { jsonrpc: '2.0', id, result: {} };

        case MCP_METHODS.TOOLS_LIST:
          return isNotification
            ? undefined
            : { jsonrpc: '2.0', id, result: { tools: tools.descriptors() } };

        case MCP_METHODS.TOOLS_CALL:
          return isNotification ? undefined : callTool(id, request.params);

        default:
          return isNotification
            ? undefined
            : rpcError(id, JSONRPC_ERROR.METHOD_NOT_FOUND, `unknown method "${request.method}"`);
      }
    },
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
