import { decodeAbiParameters, decodeFunctionData, type PublicClient } from 'viem';
import { describe, expect, it } from 'vitest';
import { erc7579AccountAbi } from './abi.js';
import { CHAIN_ID } from './chains.js';
import { HOOK_NONE, KernelAdapter, NO_HOOK_DATA } from './kernel.js';
import { createAdapter } from './registry.js';
import { MODULE_TYPE, type Address, type Hex } from './types.js';

const ACCOUNT = '0x1111111111111111111111111111111111111111' as Address;
const MODULE = '0x2222222222222222222222222222222222222222' as Address;
const ENABLE_DATA = '0xdeadbeef' as Hex;

/** Minimal PublicClient stub: only the two reads the adapters actually use. */
function stubClient(code: Hex | undefined, installed = false): PublicClient {
  return {
    getCode: async () => code,
    readContract: async () => installed,
  } as unknown as PublicClient;
}

const adapter = () => new KernelAdapter({ client: stubClient('0x') });

describe('erc7579 module encoding', () => {
  it('encodes a standard installModule call', () => {
    const data = adapter().encodeInstallModule({
      moduleType: MODULE_TYPE.VALIDATOR,
      module: MODULE,
      initData: ENABLE_DATA,
    });
    const decoded = decodeFunctionData({ abi: erc7579AccountAbi, data });
    expect(decoded.functionName).toBe('installModule');
    expect(decoded.args).toEqual([MODULE_TYPE.VALIDATOR, MODULE, ENABLE_DATA]);
  });

  it('encodes a standard uninstallModule call', () => {
    const data = adapter().encodeUninstallModule({
      moduleType: MODULE_TYPE.VALIDATOR,
      module: MODULE,
    });
    const decoded = decodeFunctionData({ abi: erc7579AccountAbi, data });
    expect(decoded.functionName).toBe('uninstallModule');
    expect(decoded.args).toEqual([MODULE_TYPE.VALIDATOR, MODULE, '0x']);
  });
});

describe('isModuleInstalled', () => {
  it('returns false for an undeployed account without reading state', async () => {
    const underTest = new KernelAdapter({ client: stubClient('0x') });
    await expect(underTest.isModuleInstalled({ account: ACCOUNT, module: MODULE })).resolves.toBe(false);
  });

  it('reads ERC-7579 state once the account has code', async () => {
    const deployed = new KernelAdapter({ client: stubClient('0x6001', true) });
    await expect(deployed.isModuleInstalled({ account: ACCOUNT, module: MODULE })).resolves.toBe(true);
  });
});

describe('kernel validator initData layout', () => {
  it('uses the abi.encode layout for 0.3.0-beta', () => {
    const kernel = new KernelAdapter({ client: stubClient('0x'), version: '0.3.0-beta' });
    const initData = kernel.encodeValidatorInstallData(ENABLE_DATA);
    const [hook, validatorData, hookData] = decodeAbiParameters(
      [{ type: 'address' }, { type: 'bytes' }, { type: 'bytes' }],
      initData,
    );
    expect(hook).toBe(HOOK_NONE);
    expect(validatorData).toBe(ENABLE_DATA);
    expect(hookData).toBe(NO_HOOK_DATA);
  });

  it('prefixes the hook as raw 20 bytes for 0.3.1', () => {
    const kernel = new KernelAdapter({ client: stubClient('0x') });
    const initData = kernel.encodeValidatorInstallData(ENABLE_DATA);
    expect(initData.slice(0, 42).toLowerCase()).toBe(HOOK_NONE.toLowerCase());

    const [validatorData, hookData, selectorData] = decodeAbiParameters(
      [{ type: 'bytes' }, { type: 'bytes' }, { type: 'bytes' }],
      `0x${initData.slice(42)}` as Hex,
    );
    expect(validatorData).toBe(ENABLE_DATA);
    expect(hookData).toBe(NO_HOOK_DATA);
    expect(selectorData).toBe('0x');
  });

  it('feeds the wrapped initData into installModule', () => {
    const kernel = new KernelAdapter({ client: stubClient('0x') });
    const initData = kernel.encodeValidatorInstallData(ENABLE_DATA);
    const data = kernel.encodeInstallModule({ moduleType: MODULE_TYPE.VALIDATOR, module: MODULE, initData });
    const decoded = decodeFunctionData({ abi: erc7579AccountAbi, data });
    expect(decoded.args).toEqual([MODULE_TYPE.VALIDATOR, MODULE, initData]);
  });
});

describe('createAdapter', () => {
  it('returns an adapter per account kind', () => {
    const client = stubClient('0x');
    expect(createAdapter('kernel', { client }).kind).toBe('kernel');
    expect(createAdapter('nexus', { client }).kind).toBe('nexus');
    expect(createAdapter('safe7579', { client }).kind).toBe('safe7579');
  });

  it('leads the Kernel chain set with BSC', () => {
    expect(createAdapter('kernel', { client: stubClient('0x') }).chainIds[0]).toBe(CHAIN_ID.bsc);
  });
});
