import { NEXUS_CHAIN_IDS } from './chains.js';
import { ERC7579AccountAdapter } from './erc7579.js';
import type { AccountAdapterOptions } from './types.js';

/**
 * Nexus (Biconomy) adapter.
 *
 * Nexus is standards-faithful: its module manager already matches ERC-7579
 * exactly, so there is no install-time quirk to shim. The adapter exists to
 * pin the default chain set and to give callers a uniform `kind` handle for
 * migration tooling — which is the whole point of "1 + 3 thin glue".
 */
export class NexusAdapter extends ERC7579AccountAdapter {
  readonly kind = 'nexus' as const;

  constructor(options: AccountAdapterOptions) {
    super(options.client, options.chainIds ?? NEXUS_CHAIN_IDS);
  }
}
