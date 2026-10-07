import type { PublicClient } from 'viem';
import { erc7579AccountAbi, erc7579ModuleAbi } from './abi.js';
import type { AccountReader, Address, Hex } from './types.js';

/**
 * Adapts a viem `PublicClient` to {@link AccountReader} — the "run it against a
 * live chain" path. Everything is a plain `view` call, so a read-only client and
 * no signer are enough.
 */
export function createViemReader(client: PublicClient): AccountReader {
  const hasCode = async (account: Address): Promise<boolean> => {
    const code = await client.getCode({ address: account });
    return Boolean(code && code !== '0x');
  };

  return {
    hasCode,

    async isModuleInstalled({ account, module, moduleTypeId }) {
      // An account with no code is not deployed: nothing can be installed on it.
      if (!(await hasCode(account))) return false;
      return client.readContract({
        address: account,
        abi: erc7579AccountAbi,
        functionName: 'isModuleInstalled',
        args: [moduleTypeId, module, '0x'],
      });
    },

    async supportsExecutionMode(account, mode: Hex) {
      return client.readContract({
        address: account,
        abi: erc7579AccountAbi,
        functionName: 'supportsExecutionMode',
        args: [mode],
      });
    },

    async accountId(account) {
      return client.readContract({
        address: account,
        abi: erc7579AccountAbi,
        functionName: 'accountId',
      });
    },

    async isModuleInitialized(module, account) {
      return client.readContract({
        address: module,
        abi: erc7579ModuleAbi,
        functionName: 'isInitialized',
        args: [account],
      });
    },

    async isModuleType(module, moduleTypeId) {
      return client.readContract({
        address: module,
        abi: erc7579ModuleAbi,
        functionName: 'isModuleType',
        args: [moduleTypeId],
      });
    },
  };
}
