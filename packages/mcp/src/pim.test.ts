import { buildKeelPim } from '@keelcodes/manifest';
import { describe, expect, it } from 'vitest';
import { createMcpServer, createPimTools, type JsonRpcRequest, type JsonRpcResponse, type JsonRpcSuccess } from './index.js';

const POLICY_HOOK = '0x1111111111111111111111111111111111111111';
const BOUNDED_ACTIONS = '0x2222222222222222222222222222222222222222';

function ok(response: JsonRpcResponse | undefined): JsonRpcSuccess {
  if (response === undefined || 'error' in response) {
    throw new Error(`expected a successful response, got ${JSON.stringify(response)}`);
  }
  return response;
}

function call(method: string, params?: unknown, id = 1): JsonRpcRequest {
  return { jsonrpc: '2.0', id, method, params };
}

const server = createMcpServer({ name: 'keel-pim', version: '0.1.0', tools: createPimTools() });

async function callTool(name: string, args: unknown): Promise<JsonRpcSuccess> {
  return ok(await server.handle(call('tools/call', { name, arguments: args })));
}

const validPim = buildKeelPim({ policyHook: POLICY_HOOK, boundedActions: BOUNDED_ACTIONS });

describe('createPimTools', () => {
  it('lists both PIM tools', () => {
    const names = server.tools.list().map((tool) => tool.name);
    expect(names).toEqual(['pim_validate', 'pim_inspect']);
  });

  it('pim_validate accepts a valid manifest', async () => {
    const result = await callTool('pim_validate', { pim: validPim });
    expect(result.result).toMatchObject({ structuredContent: { valid: true, errors: [] } });
  });

  it('pim_validate reports errors as a tool result, not a protocol error', async () => {
    const broken = structuredClone(validPim) as Record<string, any>;
    delete broken.metadata;
    const result = await callTool('pim_validate', { pim: broken });
    expect(result.result).toMatchObject({ structuredContent: { valid: false } });
    expect(JSON.stringify(result.result)).toContain('metadata');
  });

  it('pim_validate honours the chainId context', async () => {
    const pim = structuredClone(validPim) as Record<string, any>;
    pim.metadata.chainId = [1];
    const result = await callTool('pim_validate', { pim, chainId: 8453 });
    expect(result.result).toMatchObject({ structuredContent: { valid: false } });
  });

  it('pim_validate rejects a non-object argument as a tool error', async () => {
    const result = await callTool('pim_validate', { pim: 'not-a-manifest' });
    expect(result.result).toMatchObject({ isError: true });
  });

  it('pim_inspect summarises the manifest and its trust level', async () => {
    const result = await callTool('pim_inspect', { pim: validPim });
    expect(result.result).toMatchObject({
      structuredContent: {
        valid: true,
        protocol: 'Keel',
        category: 'other',
        contracts: [
          { name: 'policyHook', role: 'other', address: POLICY_HOOK },
          { name: 'boundedActions', role: 'registry', address: BOUNDED_ACTIONS },
        ],
        trustLevel: { level: 0, name: 'Unverified', verified: false },
      },
    });
    const structured = (result.result as { structuredContent: { intents: Array<{ name: string }> } })
      .structuredContent;
    expect(structured.intents.map((intent) => intent.name)).toEqual(
      expect.arrayContaining(['grantBoundedSession', 'drawBoundedAction']),
    );
  });
});
