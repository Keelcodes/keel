import { encodeFunctionData, type PublicClient } from 'viem';
import { erc7579AccountAbi } from './abi.js';
import {
  MODULE_TYPE,
  type AccountAdapter,
  type AccountKind,
  type Hex,
  type InstallModuleArgs,
  type IsModuleInstalledArgs,
  type UninstallModuleArgs,
} from './types.js';

/**
 * The "1" of the "1 + 3 thin glue" design: a single standards-based
 * implementation of the ERC-7579 module-manager surface. Account-specific
 * adapters subclass this and only override the parts that actually differ.
 */
export abstract class ERC7579AccountAdapter implements AccountAdapter {
  abstract readonly kind: AccountKind;

  readonly chainIds: readonly number[];
  protected readonly client: PublicClient;

  protected constructor(client: PublicClient, chainIds: readonly number[]) {
    this.client = client;
    this.chainIds = chainIds;
  }

  async isModuleInstalled({
    account,
    module,
    moduleType = MODULE_TYPE.VALIDATOR,
  }: IsModuleInstalledArgs): Promise<boolean> {
    // An account with no code is not deployed yet → no module can be installed.
    const code = await this.client.getCode({ address: account });
    if (!code || code === '0x') return false;

    return this.client.readContract({
      address: account,
      abi: erc7579AccountAbi,
      functionName: 'isModuleInstalled',
      args: [moduleType, module, '0x'],
    });
  }

  encodeInstallModule({ moduleType, module, initData = '0x' }: InstallModuleArgs): Hex {
    return encodeFunctionData({
      abi: erc7579AccountAbi,
      functionName: 'installModule',
      args: [moduleType, module, initData],
    });
  }

  encodeUninstallModule({ moduleType, module, deInitData = '0x' }: UninstallModuleArgs): Hex {
    return encodeFunctionData({
      abi: erc7579AccountAbi,
      functionName: 'uninstallModule',
      args: [moduleType, module, deInitData],
    });
  }
}
