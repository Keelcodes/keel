import { describe, expect, it } from 'vitest';
import { ContractFunctionRevertedError, RpcRequestError, type PublicClient } from 'viem';
import { erc7579ModuleAbi } from './abi.js';
import { probeModule } from '../../migrate/src/probe.js';
import { createViemModuleProbe } from './module-probe.js';

const ACCOUNT = '0xaaaa000000000000000000000000000000000001';
const MODULE = '0xbbbb000000000000000000000000000000000002';
const ARGS = { account: ACCOUNT, module: MODULE, moduleTypeId: 4n };

/** Minimal fake of the two viem reads the probe performs. */
function fakeClient(read: {
  code?: string;
  isModuleInstalled?: boolean;
  isInitialized?: boolean | (() => never);
}): PublicClient {
  return {
    getCode: async () => read.code ?? '0x',
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === 'isModuleInstalled') return read.isModuleInstalled ?? false;
      if (functionName === 'isInitialized') {
        if (typeof read.isInitialized === 'function') return read.isInitialized();
        return read.isInitialized ?? false;
      }
      throw new Error(`unexpected functionName: ${functionName}`);
    },
  } as unknown as PublicClient;
}

describe('createViemModuleProbe', () => {
  it('reports not installed for an account with no code, without reading the module', async () => {
    const probe = createViemModuleProbe(fakeClient({ code: '0x' }));
    const result = await probeModule(probe, ARGS);
    expect(result).toEqual({
      installed: false,
      initialized: false,
      ok: false,
      reason: 'module is not installed on the account',
    });
  });

  it('reports installed and initialized when both halves hold', async () => {
    const probe = createViemModuleProbe(
      fakeClient({ code: '0x6000', isModuleInstalled: true, isInitialized: true }),
    );
    expect(await probeModule(probe, ARGS)).toEqual({ installed: true, initialized: true, ok: true });
  });

  it('treats a reverting isInitialized() as not initialized (AA24 silent no-op)', async () => {
    const probe = createViemModuleProbe(
      fakeClient({
        code: '0x6000',
        isModuleInstalled: true,
        isInitialized: () => {
          // What viem throws when the module never implemented the function.
          throw new ContractFunctionRevertedError({
            abi: erc7579ModuleAbi,
            functionName: 'isInitialized',
            message: 'execution reverted',
          });
        },
      }),
    );
    const result = await probeModule(probe, ARGS);
    expect(result.installed).toBe(true);
    expect(result.initialized).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/isInitialized\(\) is false/);
  });

  it('rethrows an RPC failure instead of reading it as not-initialized', async () => {
    const probe = createViemModuleProbe(
      fakeClient({
        code: '0x6000',
        isModuleInstalled: true,
        isInitialized: () => {
          // A public RPC answers a rate limit with a JSON-RPC error, which viem
          // surfaces as RpcRequestError. The module was never read, so this must
          // not become a `false` verdict (it flapped a real rollout gate).
          throw new RpcRequestError({
            body: { jsonrpc: '2.0', id: 1, method: 'eth_call' },
            error: { code: -32005, message: 'over rate limit' },
            url: 'https://mainnet.base.org',
          });
        },
      }),
    );
    await expect(probe.isModuleInitialized(MODULE, ACCOUNT)).rejects.toBeInstanceOf(RpcRequestError);
  });

  it('reports installed-but-not-initialized when the module returns false', async () => {
    const probe = createViemModuleProbe(
      fakeClient({ code: '0x6000', isModuleInstalled: true, isInitialized: false }),
    );
    const result = await probeModule(probe, ARGS);
    expect(result.installed).toBe(true);
    expect(result.initialized).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/silent no-op install/);
  });
});
