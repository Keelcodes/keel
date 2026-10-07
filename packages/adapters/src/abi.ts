import { parseAbi } from 'viem';

/**
 * ERC-7579 account module-manager surface, shared by Kernel, Nexus and
 * Safe7579. All three speak this exact ABI, which is why Keel needs a single
 * base implementation plus three thin account-specific shims.
 */
export const erc7579AccountAbi = parseAbi([
  'function isModuleInstalled(uint256 moduleTypeId, address module, bytes additionalContext) view returns (bool)',
  'function installModule(uint256 moduleTypeId, address module, bytes initData)',
  'function uninstallModule(uint256 moduleTypeId, address module, bytes deInitData)',
]);

/**
 * The ERC-7579 `IModule` surface a module exposes about itself. `isInitialized`
 * is the module-side half of the migration probe: it reports whether the module
 * actually stored state for an account during `onInstall`, which is the fact an
 * AA24-class silent no-op install gets wrong while `isModuleInstalled` on the
 * account still returns true.
 */
export const erc7579ModuleAbi = parseAbi([
  'function isInitialized(address smartAccount) view returns (bool)',
  'function isModuleType(uint256 moduleTypeId) view returns (bool)',
]);
