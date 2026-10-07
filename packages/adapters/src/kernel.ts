import { concat, encodeAbiParameters } from 'viem';
import { KERNEL_CHAIN_IDS } from './chains.js';
import { ERC7579AccountAdapter } from './erc7579.js';
import type { AccountAdapterOptions, Address, Hex } from './types.js';

/** Kernel release used to pick the validator `initData` layout. */
export type KernelVersion = '0.3.0-beta' | '0.3.1';

/** `address(1)` — Kernel convention for "no hook". */
export const HOOK_NONE: Address = '0x0000000000000000000000000000000000000001';

/** Placeholder hookData when no hook is used (any non-empty bytes work). */
export const NO_HOOK_DATA: Hex = '0xff';

export interface KernelAdapterOptions extends AccountAdapterOptions {
  /** Defaults to `0.3.1` (BSC's official Kernel). */
  version?: KernelVersion;
}

/**
 * Kernel (ZeroDev) adapter.
 *
 * Kernel is the one account in the initial set with a real install-time quirk:
 * `installModule` reads the hook from the first 20 bytes of `initData` and
 * changed the tail layout in v3.1. Passing the wrong layout does **not**
 * revert — Kernel decodes an empty `validatorData`, the module's `onInstall`
 * silently returns, and the module stays uninitialized while
 * `isModuleInstalled` still reports `true`.
 */
export class KernelAdapter extends ERC7579AccountAdapter {
  readonly kind = 'kernel' as const;

  private readonly version: KernelVersion;

  constructor({ version = '0.3.1', ...options }: KernelAdapterOptions) {
    super(options.client, options.chainIds ?? KERNEL_CHAIN_IDS);
    this.version = version;
  }

  /**
   * Wraps a validator's `enableData` into the `initData` layout Kernel expects.
   *
   * - `0.3.0-beta`: `abi.encode(address hook, bytes validatorData, bytes hookData)`
   * - `0.3.1+`:     `hook(20B) ‖ abi.encode(bytes validatorData, bytes hookData, bytes selectorData)`
   *
   * Feed the result to {@link encodeInstallModule}; never pass `enableData`
   * directly as `initData`.
   */
  encodeValidatorInstallData(
    enableData: Hex,
    hook: Address = HOOK_NONE,
    hookData: Hex = NO_HOOK_DATA,
  ): Hex {
    if (this.version === '0.3.0-beta') {
      return encodeAbiParameters(
        [{ type: 'address' }, { type: 'bytes' }, { type: 'bytes' }],
        [hook, enableData, hookData],
      );
    }
    return concat([
      hook,
      encodeAbiParameters(
        [{ type: 'bytes' }, { type: 'bytes' }, { type: 'bytes' }],
        [enableData, hookData, '0x'],
      ),
    ]);
  }
}
