/**
 * @keelcodes/adapters
 *
 * Thin adapters that expose different smart-account implementations behind a
 * single ERC-7579 interface. Keel does not implement account modules: every
 * supported account already speaks ERC-7579, so this package only installs,
 * uninstalls and probes standards-compliant modules.
 *
 * The design is "1 + 3 thin glue": one standards implementation
 * ({@link ERC7579AccountAdapter}) plus three account shims
 * ({@link KernelAdapter}, {@link NexusAdapter}, {@link Safe7579Adapter}) that
 * only carry the parts that genuinely differ — defaults and install-time
 * quirks.
 *
 * @packageDocumentation
 */

export { erc7579AccountAbi, erc7579ModuleAbi } from './abi.js';
export { createViemModuleProbe } from './module-probe.js';
export { BUNDLER_RPC, createBundlerAdapter } from './bundler.js';
export {
  accountsFor,
  CHAIN_ID,
  CHAINS,
  DEFAULT_CHAIN_ID,
  getChain,
  isChainSupported,
  KERNEL_CHAIN_IDS,
  NEXUS_CHAIN_IDS,
  SAFE7579_CHAIN_IDS,
} from './chains.js';
export { createEndpointResolver, pimlicoUrl } from './endpoints.js';
export { ERC7579AccountAdapter } from './erc7579.js';
export { HOOK_NONE, KernelAdapter, NO_HOOK_DATA } from './kernel.js';
export { NexusAdapter } from './nexus.js';
export { PAYMASTER_RPC, createPaymasterAdapter } from './paymaster.js';
export { Safe7579Adapter } from './safe7579.js';
export { createAdapter } from './registry.js';
export { MODULE_TYPE } from './types.js';

export type { BundlerAdapter, BundlerAdapterOptions, BundlerKind } from './bundler.js';
export type { ChainInfo } from './chains.js';
export type { Endpoint, EndpointResolver, EndpointResolverOptions, EndpointSet } from './endpoints.js';
export type { CreateAdapterOptions } from './registry.js';
export type { ViemModuleProbe } from './module-probe.js';
export type { KernelAdapterOptions, KernelVersion } from './kernel.js';
export type { PaymasterAdapter, PaymasterAdapterOptions, PaymasterKind } from './paymaster.js';
export type {
  AccountAdapter,
  AccountAdapterOptions,
  AccountKind,
  Address,
  Hex,
  InstallModuleArgs,
  IsModuleInstalledArgs,
  UninstallModuleArgs,
} from './types.js';
