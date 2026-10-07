import type { PublicClient } from 'viem';

/** Supported smart-account implementations. */
export type AccountKind = 'kernel' | 'nexus' | 'safe7579';

export type Address = `0x${string}`;
export type Hex = `0x${string}`;

/** ERC-7579 module type ids. */
export const MODULE_TYPE = {
  VALIDATOR: 1n,
  EXECUTOR: 2n,
  FALLBACK: 3n,
  HOOK: 4n,
} as const;

export interface IsModuleInstalledArgs {
  account: Address;
  module: Address;
  /** Defaults to {@link MODULE_TYPE}.VALIDATOR. */
  moduleType?: bigint;
}

export interface InstallModuleArgs {
  moduleType: bigint;
  module: Address;
  /** ERC-7579 `initData`. Defaults to `0x`. */
  initData?: Hex;
}

export interface UninstallModuleArgs {
  moduleType: bigint;
  module: Address;
  /** ERC-7579 `deInitData`. Defaults to `0x`. */
  deInitData?: Hex;
}

/**
 * Thin adapter exposing one smart-account implementation behind the standard
 * ERC-7579 module-manager surface. Keel never re-implements account modules:
 * every supported account already speaks ERC-7579, so an adapter only encodes
 * and probes standard install/uninstall calls.
 */
export interface AccountAdapter {
  readonly kind: AccountKind;

  /** Chain ids this adapter is known to support. */
  readonly chainIds: readonly number[];

  /**
   * Returns whether `module` is installed on `account`.
   *
   * Adapters expose this so callers can verify module state explicitly instead
   * of relying on silent failure modes (e.g. a mismatched initData layout that
   * does not revert but leaves the module uninitialized).
   */
  isModuleInstalled(args: IsModuleInstalledArgs): Promise<boolean>;

  /** Encodes an ERC-7579 `installModule` call. */
  encodeInstallModule(args: InstallModuleArgs): Hex;

  /** Encodes an ERC-7579 `uninstallModule` call. */
  encodeUninstallModule(args: UninstallModuleArgs): Hex;
}

export interface AccountAdapterOptions {
  /** viem public client used for on-chain probes. */
  client: PublicClient;
  /** Override the adapter's default set of supported chain ids. */
  chainIds?: readonly number[];
}
