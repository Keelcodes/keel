import { JSONRPC_ERROR, rpcError, type JsonRpcRequest, type JsonRpcResponse } from './protocol.js';
import type { McpServer } from './server.js';

/**
 * The little of a Node readable stream this needs. Kept structural so the
 * transport is testable with a plain object and carries no `@types/node`
 * dependency.
 */
export interface ReadableLike {
  /**
   * The transport is UTF-8 by definition (the framing is JSON text), so it asks
   * for exactly that. Narrowing the argument to `'utf8'` is what lets a Node
   * `ReadStream` — whose `setEncoding` takes a `BufferEncoding` — satisfy this
   * interface without a cast.
   */
  setEncoding(encoding: 'utf8'): unknown;
  on(event: 'data', listener: (chunk: string) => void): unknown;
  on(event: 'end', listener: () => void): unknown;
}

export interface WritableLike {
  write(chunk: string): unknown;
}

export interface ServeStdioOptions {
  server: McpServer;
  input: ReadableLike;
  output: WritableLike;
  /** Called for transport-level failures that must not kill the stream. */
  onError?: (error: unknown) => void;
}

/**
 * Serves MCP over stdio using the newline-delimited JSON-RPC framing the spec
 * prescribes for local servers: one JSON message per line, no embedded
 * newlines, responses written back the same way.
 *
 * Notifications produce no output, so a client's `notifications/initialized`
 * is simply consumed.
 */
export function serveStdio(options: ServeStdioOptions): void {
  let buffer = '';

  const write = (response: JsonRpcResponse): void => {
    options.output.write(`${JSON.stringify(response)}\n`);
  };

  options.input.setEncoding('utf8');
  options.input.on('data', (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line.length > 0) void handleLine(line, options, write);
      newline = buffer.indexOf('\n');
    }
  });

  options.input.on('end', () => {
    const rest = buffer.trim();
    buffer = '';
    if (rest.length > 0) void handleLine(rest, options, write);
  });
}

async function handleLine(
  line: string,
  options: ServeStdioOptions,
  write: (response: JsonRpcResponse) => void,
): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    write(rpcError(null, JSONRPC_ERROR.PARSE_ERROR, 'parse error'));
    return;
  }

  if (!isRequest(parsed)) {
    write(rpcError(null, JSONRPC_ERROR.INVALID_REQUEST, 'invalid request'));
    return;
  }

  try {
    const response = await options.server.handle(parsed);
    if (response !== undefined) write(response);
  } catch (error) {
    options.onError?.(error);
    write(rpcError(parsed.id ?? null, JSONRPC_ERROR.INTERNAL_ERROR, messageOf(error)));
  }
}

function isRequest(value: unknown): value is JsonRpcRequest {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (value as { jsonrpc?: unknown }).jsonrpc === '2.0' &&
    typeof (value as { method?: unknown }).method === 'string'
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
