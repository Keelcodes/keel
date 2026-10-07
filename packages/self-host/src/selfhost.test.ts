import { describe, expect, it } from 'vitest';
import {
  ANVIL_MNEMONIC,
  checkBundler,
  checkChain,
  DEFAULT_LOCAL_PORTS,
  httpRpc,
  LOCAL_CHAIN_ID,
  localEndpoints,
  SELF_HOST_SERVICES,
  stackRpc,
  waitForStack,
  type FetchLike,
  type RpcCall,
} from './index.js';

/** A JSON-RPC fake that answers from a fixed handler map. */
function rpcOf(handlers: Record<string, () => unknown>): RpcCall {
  return async (method) => {
    const handler = handlers[method];
    if (handler === undefined) throw new Error(`unexpected method ${method}`);
    return handler();
  };
}

/** A fake clock whose sleep advances time, so waitForStack terminates fast. */
function clock(): { now: () => number; sleep: (ms: number) => Promise<void> } {
  let t = 0;
  return { now: () => t, sleep: async (ms) => void (t += ms) };
}

describe('localEndpoints', () => {
  it('derives the default stack URLs', () => {
    expect(localEndpoints()).toEqual({
      chainId: LOCAL_CHAIN_ID,
      rpcUrl: 'http://127.0.0.1:8545',
      bundlerUrl: 'http://127.0.0.1:4337',
      paymasterUrl: 'http://127.0.0.1:3000',
      apiUrl: 'http://127.0.0.1:8080',
    });
  });

  it('honours host, port and chain overrides', () => {
    const endpoints = localEndpoints({
      host: 'anvil',
      chainId: 900,
      ports: { bundler: 4437 },
    });
    expect(endpoints.chainId).toBe(900);
    expect(endpoints.rpcUrl).toBe('http://anvil:8545');
    expect(endpoints.bundlerUrl).toBe('http://anvil:4437');
    expect(endpoints.paymasterUrl).toBe('http://anvil:3000');
    expect(endpoints.apiUrl).toBe('http://anvil:8080');
  });
});

describe('SELF_HOST_SERVICES', () => {
  it('names each service once', () => {
    const names = SELF_HOST_SERVICES.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('exposes one chain, deployer, bundler, paymaster and api', () => {
    const roles = SELF_HOST_SERVICES.map((s) => s.role).sort();
    expect(roles).toEqual(['api', 'bundler', 'chain', 'deployer', 'paymaster']);
  });

  it('publishes the same ports the endpoint model assumes', () => {
    const byRole = new Map(SELF_HOST_SERVICES.map((s) => [s.role, s]));
    expect(byRole.get('chain')?.port).toBe(DEFAULT_LOCAL_PORTS.anvil);
    expect(byRole.get('bundler')?.port).toBe(DEFAULT_LOCAL_PORTS.bundler);
    expect(byRole.get('paymaster')?.port).toBe(DEFAULT_LOCAL_PORTS.paymaster);
    expect(byRole.get('api')?.port).toBe(DEFAULT_LOCAL_PORTS.api);
  });

  it('only depends on services that exist', () => {
    const names = new Set(SELF_HOST_SERVICES.map((s) => s.name));
    for (const service of SELF_HOST_SERVICES) {
      for (const dependency of service.dependsOn ?? []) {
        expect(names.has(dependency)).toBe(true);
      }
    }
  });

  it('ships a public, local-only dev mnemonic', () => {
    expect(ANVIL_MNEMONIC.split(' ')).toHaveLength(12);
  });
});

describe('httpRpc', () => {
  const okFetch = (result: unknown, capture?: (body: unknown) => void): FetchLike => {
    return async (_url, init) => {
      capture?.(JSON.parse(init.body));
      return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result }) };
    };
  };

  it('posts a JSON-RPC envelope and returns the result', async () => {
    let body: unknown;
    const rpc = httpRpc('http://x', okFetch('0x1', (b) => (body = b)));
    expect(await rpc('eth_chainId')).toBe('0x1');
    expect(body).toMatchObject({ jsonrpc: '2.0', method: 'eth_chainId', params: [] });
  });

  it('increments the request id', async () => {
    const ids: number[] = [];
    const rpc = httpRpc('http://x', okFetch('0x1', (b) => ids.push((b as { id: number }).id)));
    await rpc('eth_chainId');
    await rpc('eth_chainId');
    expect(ids).toEqual([1, 2]);
  });

  it('throws on a JSON-RPC error payload', async () => {
    const fetchImpl: FetchLike = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ error: { code: -32601, message: 'method not found' } }),
    });
    await expect(httpRpc('http://x', fetchImpl)('eth_chainId')).rejects.toThrow(
      '-32601 method not found',
    );
  });

  it('throws on a non-OK HTTP response', async () => {
    const fetchImpl: FetchLike = async () => ({
      ok: false,
      status: 503,
      json: async () => ({}),
    });
    await expect(httpRpc('http://x', fetchImpl)('eth_chainId')).rejects.toThrow('HTTP 503');
  });

  it('binds one call per endpoint', () => {
    const seen: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
      seen.push(url);
      return { ok: true, status: 200, json: async () => ({ result: '0x1' }) };
    };
    const rpc = stackRpc(localEndpoints(), fetchImpl);
    expect(rpc.chain).toBeTypeOf('function');
    expect(rpc.bundler).toBeTypeOf('function');
    expect(rpc.paymaster).toBeTypeOf('function');
    expect(seen).toEqual([]);
  });
});

describe('checkChain', () => {
  it('accepts the expected chain id', async () => {
    const rpc = rpcOf({ eth_chainId: () => '0x7a69' });
    expect(await checkChain(rpc, LOCAL_CHAIN_ID)).toBe(true);
  });

  it('rejects a different chain id', async () => {
    const rpc = rpcOf({ eth_chainId: () => '0x1' });
    expect(await checkChain(rpc, LOCAL_CHAIN_ID)).toBe(false);
  });

  it('rejects a non-string result', async () => {
    const rpc = rpcOf({ eth_chainId: () => 31337 });
    expect(await checkChain(rpc, LOCAL_CHAIN_ID)).toBe(false);
  });
});

describe('checkBundler', () => {
  it('accepts a non-empty entrypoint list', async () => {
    const rpc = rpcOf({ eth_supportedEntryPoints: () => ['0x0000000071727De22E5E9d8BAf0edAc6f37da032'] });
    expect(await checkBundler(rpc)).toBe(true);
  });

  it('rejects an empty list', async () => {
    const rpc = rpcOf({ eth_supportedEntryPoints: () => [] });
    expect(await checkBundler(rpc)).toBe(false);
  });

  it('rejects a non-array result', async () => {
    const rpc = rpcOf({ eth_supportedEntryPoints: () => null });
    expect(await checkBundler(rpc)).toBe(false);
  });
});

describe('waitForStack', () => {
  it('returns ready once both probes pass', async () => {
    const { now, sleep } = clock();
    const result = await waitForStack({
      chain: rpcOf({ eth_chainId: () => '0x7a69' }),
      bundler: rpcOf({ eth_supportedEntryPoints: () => ['0xe1'] }),
      chainId: LOCAL_CHAIN_ID,
      now,
      sleep,
    });
    expect(result).toMatchObject({ chain: true, bundler: true, ready: true, timedOut: false });
  });

  it('keeps trying while a probe throws, then succeeds', async () => {
    const { now, sleep } = clock();
    let attempts = 0;
    const chain: RpcCall = async () => {
      attempts += 1;
      if (attempts < 3) throw new Error('connection refused');
      return '0x7a69';
    };
    const result = await waitForStack({
      chain,
      bundler: rpcOf({ eth_supportedEntryPoints: () => ['0xe1'] }),
      chainId: LOCAL_CHAIN_ID,
      now,
      sleep,
      intervalMs: 100,
      timeoutMs: 10_000,
    });
    expect(result.ready).toBe(true);
    expect(attempts).toBe(3);
  });

  it('times out when the chain never comes up', async () => {
    const { now, sleep } = clock();
    const result = await waitForStack({
      chain: rpcOf({ eth_chainId: () => '0x1' }),
      bundler: rpcOf({ eth_supportedEntryPoints: () => ['0xe1'] }),
      chainId: LOCAL_CHAIN_ID,
      now,
      sleep,
      intervalMs: 250,
      timeoutMs: 1000,
    });
    expect(result).toMatchObject({ chain: false, bundler: false, ready: false, timedOut: true });
    expect(result.elapsedMs).toBeGreaterThanOrEqual(1000);
  });

  it('does not probe the bundler before the chain is up', async () => {
    const { now, sleep } = clock();
    let bundlerProbes = 0;
    await waitForStack({
      chain: rpcOf({ eth_chainId: () => '0x1' }),
      bundler: async () => {
        bundlerProbes += 1;
        return ['0xe1'];
      },
      chainId: LOCAL_CHAIN_ID,
      now,
      sleep,
      intervalMs: 250,
      timeoutMs: 1000,
    });
    expect(bundlerProbes).toBe(0);
  });
});
