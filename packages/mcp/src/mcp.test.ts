import { normalizePolicy } from '@keelcodes/policy';
import { describe, expect, it, vi } from 'vitest';
import {
  DENY_ALL,
  ToolRegistry,
  createMcpServer,
  createPolicyGate,
  createPolicyTools,
  serveStdio,
  type CallExecutor,
  type JsonRpcFailure,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type JsonRpcSuccess,
  type McpTool,
  type McpServer,
  type ReadableLike,
  type WritableLike,
} from './index.js';

// The policy under test: one rule allowing calls to TOKEN up to 1000 wei each.
const TOKEN = '0x0000000000000000000000000000000000000001' as const;
const OTHER = '0x0000000000000000000000000000000000000002' as const;
const policy = normalizePolicy({ rules: [{ target: TOKEN, maxPerTx: 1000n }] });

function ok(response: JsonRpcResponse | undefined): JsonRpcSuccess {
  if (response === undefined || 'error' in response) {
    throw new Error(`expected a successful response, got ${JSON.stringify(response)}`);
  }
  return response;
}

function failure(response: JsonRpcResponse | undefined): JsonRpcFailure {
  if (response === undefined || !('error' in response)) {
    throw new Error(`expected an error response, got ${JSON.stringify(response)}`);
  }
  return response;
}

function call(method: string, params?: unknown, id: number | undefined = 1): JsonRpcRequest {
  return id === undefined ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id, method, params };
}

describe('createMcpServer', () => {
  const server = createMcpServer({ name: 'keel-test', version: '1.2.3', tools: [] });

  it('answers initialize with server info and a supported protocol version', async () => {
    const result = ok(await server.handle(call('initialize', { protocolVersion: '2025-06-18' }))) as JsonRpcSuccess;
    expect(result.result).toMatchObject({
      protocolVersion: '2025-06-18',
      serverInfo: { name: 'keel-test', version: '1.2.3' },
      capabilities: { tools: { listChanged: false } },
    });
  });

  it('falls back to its own version when the client asks for an unknown one', async () => {
    const result = ok(await server.handle(call('initialize', { protocolVersion: '1999-01-01' })));
    expect(result.result).toMatchObject({ protocolVersion: '2025-06-18' });
  });

  it('lists tools', async () => {
    const tool: McpTool = {
      name: 'demo',
      description: 'a demo tool',
      inputSchema: { type: 'object' },
      run: () => ({ content: [{ type: 'text', text: 'ok' }] }),
    };
    const withTool = createMcpServer({ name: 'n', version: '1', tools: [tool] });
    const result = ok(await withTool.handle(call('tools/list')));
    expect(result.result).toMatchObject({ tools: [{ name: 'demo', description: 'a demo tool' }] });
  });

  it('reports an unknown method as -32601', async () => {
    expect(failure(await server.handle(call('does/not/exist'))).error.code).toBe(-32601);
  });

  it('reports an unknown tool as -32602', async () => {
    expect(failure(await server.handle(call('tools/call', { name: 'nope' }))).error.code).toBe(-32602);
  });

  it('does not reply to notifications', async () => {
    expect(await server.handle(call('notifications/initialized', undefined, undefined))).toBeUndefined();
  });

  it('answers ping', async () => {
    expect(ok(await server.handle(call('ping'))).result).toEqual({});
  });
});

describe('ToolRegistry', () => {
  it('rejects a duplicate name', () => {
    const tool: McpTool = {
      name: 'dup',
      description: 'x',
      inputSchema: {},
      run: () => ({ content: [] }),
    };
    expect(() => new ToolRegistry([tool, tool])).toThrow('already registered');
  });

  it('omits an absent title from descriptors', () => {
    const registry = new ToolRegistry([
      { name: 'a', description: 'a', inputSchema: {}, run: () => ({ content: [] }) },
      { name: 'b', title: 'Bee', description: 'b', inputSchema: {}, run: () => ({ content: [] }) },
    ]);
    const [first, second] = registry.descriptors();
    expect(first).not.toHaveProperty('title');
    expect(second).toMatchObject({ title: 'Bee' });
  });
});

describe('createPolicyGate', () => {
  const gate = createPolicyGate({ policy, now: () => 1_000n });

  it('allows an action with no call', () => {
    expect(gate.check({ kind: 'read' })).toMatchObject({ verdict: 'allow' });
  });

  it('allows a call inside the cap', () => {
    expect(gate.check({ kind: 'execute', call: { target: TOKEN, value: 500n, data: '0x', selector: '0x' } })).toMatchObject(
      { verdict: 'allow' },
    );
  });

  it('denies a call over the cap, naming the rule', () => {
    const decision = gate.check({ kind: 'execute', call: { target: TOKEN, value: 2000n, data: '0x', selector: '0x' } });
    expect(decision).toMatchObject({ verdict: 'deny', reason: 'policy denied execute: value-per-tx-exceeded', ruleIndex: 0 });
  });

  it('denies a call to an unknown target', () => {
    const decision = gate.check({ kind: 'execute', call: { target: OTHER, value: 1n, data: '0x', selector: '0x' } });
    expect(decision).toMatchObject({ verdict: 'deny', reason: 'policy denied execute: no-matching-rule' });
  });

  it('denies everything when no policy is configured', () => {
    expect(DENY_ALL.check({ kind: 'anything' })).toMatchObject({ verdict: 'deny' });
  });
});

describe('createPolicyTools', () => {
  function serverWith(executor?: CallExecutor) {
    return createMcpServer({
      name: 'keel',
      version: '0.1.0',
      tools: createPolicyTools({ policy, executor, now: () => 1_000n }),
      gate: createPolicyGate({ policy, now: () => 1_000n }),
    });
  }

  async function callTool(server: McpServer, name: string, args: unknown): Promise<JsonRpcSuccess> {
    return ok(await server.handle(call('tools/call', { name, arguments: args })));
  }

  it('keel_policy returns the commitment and the rules', async () => {
    const result = await callTool(serverWith(), 'keel_policy', {});
    expect(result.result).toMatchObject({
      structuredContent: {
        commitment: expect.stringMatching(/^0x[0-9a-f]{64}$/),
        policy: { version: 1, rules: [{ target: TOKEN, maxPerTx: '1000' }] },
      },
    });
  });

  it('keel_check_call dry-runs without executing', async () => {
    const executor = vi.fn(async () => ({}));
    const result = await callTool(serverWith(executor), 'keel_check_call', { target: TOKEN, value: '2000' });
    expect(result.result).toMatchObject({ structuredContent: { allowed: false, reason: 'value-per-tx-exceeded' } });
    expect(executor).not.toHaveBeenCalled();
  });

  it('keel_execute_call runs an allowed call', async () => {
    const executor = vi.fn(async () => ({ transactionHash: '0xabc' }));
    const result = await callTool(serverWith(executor), 'keel_execute_call', { target: TOKEN, value: '500' });
    expect(executor).toHaveBeenCalledTimes(1);
    expect(result.result).toMatchObject({ structuredContent: { executed: true, transactionHash: '0xabc' } });
  });

  it('keel_execute_call never reaches the executor when the policy denies', async () => {
    const executor = vi.fn(async () => ({ transactionHash: '0xabc' }));
    const result = await callTool(serverWith(executor), 'keel_execute_call', { target: TOKEN, value: '2000' });
    expect(executor).not.toHaveBeenCalled();
    expect(result.result).toMatchObject({
      isError: true,
      structuredContent: { denied: true, kind: 'execute-call' },
    });
  });

  it('keel_execute_call reports unavailable without an executor', async () => {
    const result = await callTool(serverWith(), 'keel_execute_call', { target: TOKEN, value: '1' });
    expect(result.result).toMatchObject({ isError: true });
    expect(JSON.stringify(result.result)).toContain('no call executor');
  });

  it('reports malformed arguments as a tool error, not a protocol error', async () => {
    const result = await callTool(serverWith(), 'keel_execute_call', { target: 'not-an-address' });
    expect(result.result).toMatchObject({ isError: true });
  });
});

function fakeInput(): ReadableLike & { emit(event: 'data' | 'end', chunk?: string): void } {
  const listeners = new Map<string, Array<(chunk: string) => void>>();
  return {
    setEncoding: () => undefined,
    on: (event: string, listener: (chunk: string) => void) => {
      const list = listeners.get(event) ?? [];
      list.push(listener);
      listeners.set(event, list);
      return undefined;
    },
    emit: (event, chunk = '') => {
      for (const listener of listeners.get(event) ?? []) listener(chunk);
    },
  };
}

function fakeOutput(): WritableLike & { chunks: string[] } {
  const chunks: string[] = [];
  return {
    chunks,
    write: (chunk: string) => {
      chunks.push(chunk);
      return undefined;
    },
  };
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('serveStdio', () => {
  it('answers framed requests and stays silent on notifications', async () => {
    const server = createMcpServer({ name: 'keel', version: '0.1.0', tools: [] });
    const input = fakeInput();
    const output = fakeOutput();
    serveStdio({ server, input, output });

    input.emit('data', `${JSON.stringify(call('initialize', { protocolVersion: '2025-06-18' }))}\n`);
    input.emit('data', `${JSON.stringify(call('notifications/initialized', undefined, undefined))}\n`);
    input.emit('data', `${JSON.stringify(call('ping'))}\n`);
    await flush();

    expect(output.chunks).toHaveLength(2);
    const [first, second] = output.chunks;
    expect(JSON.parse(first!)).toMatchObject({ jsonrpc: '2.0', id: 1, result: { serverInfo: { name: 'keel' } } });
    expect(JSON.parse(second!)).toMatchObject({ jsonrpc: '2.0', id: 1, result: {} });
  });

  it('handles a message split across chunks', async () => {
    const server = createMcpServer({ name: 'keel', version: '0.1.0', tools: [] });
    const input = fakeInput();
    const output = fakeOutput();
    serveStdio({ server, input, output });

    const line = JSON.stringify(call('ping'));
    input.emit('data', line.slice(0, 5));
    input.emit('data', `${line.slice(5)}\n`);
    await flush();

    expect(output.chunks).toHaveLength(1);
    expect(JSON.parse(output.chunks[0]!)).toMatchObject({ result: {} });
  });

  it('reports unparseable input as a parse error', async () => {
    const server = createMcpServer({ name: 'keel', version: '0.1.0', tools: [] });
    const input = fakeInput();
    const output = fakeOutput();
    serveStdio({ server, input, output });

    input.emit('data', 'not json\n');
    await flush();

    expect(JSON.parse(output.chunks[0]!)).toMatchObject({ error: { code: -32700 } });
  });
});
