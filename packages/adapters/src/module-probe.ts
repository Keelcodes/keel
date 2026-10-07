import {
  BaseError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  type PublicClient,
} from 'viem';
import { erc7579AccountAbi, erc7579ModuleAbi } from './abi.js';
import type { Address } from './types.js';

/**
 * The only failure that is a statement about the **module**: a module that never
 * implemented `isInitialized()` reverts, with a reason or with no data at all.
 * That is exactly the AA24-class silent no-op the probe exists to surface, so it
 * resolves to "not initialised".
 *
 * Everything else — an HTTP error, a JSON-RPC rate limit, a timeout — is a
 * statement about the **RPC**, not the module, and is deliberately *not* matched
 * here so the caller can rethrow it. Folding a transient blip into `false` would
 * record a permanent module verdict and flap a rollout gate. Class-matching on
 * the transport error is not enough: a genuine revert also carries an
 * `RpcRequestError` in its cause chain (`… > ExecutionRevertedError >
 * RpcRequestError`), so the discriminator has to be "is there a revert in the
 * chain at all", not "what kind of RPC error is this".
 */
function isModuleSideMiss(error: unknown): boolean {
  return (
    error instanceof BaseError &&
    Boolean(
      error.walk(
        (e) =>
          e instanceof ContractFunctionRevertedError || e instanceof ContractFunctionZeroDataError,
      ),
    )
  );
}

/**
 * Structural port of `@keelcodes/migrate`'s `ModuleProbe`.
 *
 * Adapters deliberately does not depend on migrate: migrate is the
 * zero-dependency core (routing + state machine + pure probe), while adapters is
 * the viem I/O layer. The two are kept compatible **by shape, not by an import**,
 * so a `createViemModuleProbe(client)` return value can be handed straight to
 * `probeModule(probe, args)` from `@keelcodes/migrate` with no adapter code.
 */
export interface ViemModuleProbe {
  /** ERC-7579 `isModuleInstalled(moduleTypeId, module, 0x)` on the account. */
  isModuleInstalled(args: { account: string; module: string; moduleTypeId: bigint }): Promise<boolean>;
  /** ERC-7579 `IModule.isInitialized(smartAccount)` on the module. */
  isModuleInitialized(module: string, account: string): Promise<boolean>;
}

/**
 * Builds a viem-backed `ModuleProbe` from a public client.
 *
 * The two halves read two different contracts on purpose: `isModuleInstalled`
 * asks the **account** whether the module is registered, while
 * `isModuleInitialized` asks the **module** whether it actually stored state for
 * the account during `onInstall`. Only when both hold is the install real — a
 * mismatched `initData` layout can leave the account looking configured while the
 * module enforces nothing (an AA24-class silent no-op).
 */
export function createViemModuleProbe(client: PublicClient): ViemModuleProbe {
  return {
    async isModuleInstalled({ account, module, moduleTypeId }) {
      // An account with no code is not deployed yet → no module can be installed.
      const code = await client.getCode({ address: account as Address });
      if (!code || code === '0x') return false;

      return client.readContract({
        address: account as Address,
        abi: erc7579AccountAbi,
        functionName: 'isModuleInstalled',
        args: [moduleTypeId, module as Address, '0x'],
      });
    },

    async isModuleInitialized(module, account) {
      try {
        return await client.readContract({
          address: module as Address,
          abi: erc7579ModuleAbi,
          functionName: 'isInitialized',
          args: [account as Address],
        });
      } catch (error) {
        // A module-side miss (revert / no data) is the AA24-class silent no-op
        // the probe exists to surface → resolve to `false`.
        if (isModuleSideMiss(error)) return false;
        // Anything else is not a module verdict. Rethrow it rather than folding
        // it into `false` so a transient RPC failure cannot flap a rollout gate.
        throw error;
      }
    },
  };
}
