import { KernelAdapter, type KernelVersion } from './kernel.js';
import { NexusAdapter } from './nexus.js';
import { Safe7579Adapter } from './safe7579.js';
import type { AccountAdapter, AccountAdapterOptions, AccountKind } from './types.js';

export interface CreateAdapterOptions extends AccountAdapterOptions {
  /** Kernel only: selects the validator `initData` layout. */
  kernelVersion?: KernelVersion;
}

/** Builds the adapter for a given account implementation. */
export function createAdapter(kind: AccountKind, options: CreateAdapterOptions): AccountAdapter {
  switch (kind) {
    case 'kernel':
      return new KernelAdapter({
        client: options.client,
        chainIds: options.chainIds,
        version: options.kernelVersion,
      });
    case 'nexus':
      return new NexusAdapter(options);
    case 'safe7579':
      return new Safe7579Adapter(options);
    default: {
      const unreachable: never = kind;
      throw new Error(`unknown account kind: ${String(unreachable)}`);
    }
  }
}
