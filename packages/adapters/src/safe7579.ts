import { SAFE7579_CHAIN_IDS } from './chains.js';
import { ERC7579AccountAdapter } from './erc7579.js';
import type { AccountAdapterOptions } from './types.js';

/**
 * Safe7579 adapter.
 *
 * A Safe account only speaks ERC-7579 once the Safe7579 adapter (module +
 * fallback handler) is enabled on it, and install/uninstall calls are executed
 * through that adapter. From the outside the module-manager ABI is standard,
 * so the base implementation is reused as-is; the adapter pins Safe's default
 * chain set and documents the precondition.
 *
 * Precondition for every call: the target `account` already has Safe7579
 * enabled. {@link ERC7579AccountAdapter.isModuleInstalled} reports `false` for
 * a Safe that has not been upgraded yet, which is the correct signal.
 */
export class Safe7579Adapter extends ERC7579AccountAdapter {
  readonly kind = 'safe7579' as const;

  constructor(options: AccountAdapterOptions) {
    super(options.client, options.chainIds ?? SAFE7579_CHAIN_IDS);
  }
}
