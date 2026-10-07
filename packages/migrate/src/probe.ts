/**
 * The migration probe: the two on-chain assertions that separate "the module is
 * registered" from "the module actually enforces something".
 *
 * An install can register a module on the account (`isModuleInstalled == true`)
 * while the module's own `onInstall` silently no-ops — a mismatched `initData`
 * layout, or a value it ignored. Nothing reverts, the account looks configured,
 * and the module enforces nothing. Cutting traffic over on that state is an
 * AA24-class silent failure, so both halves must be asserted.
 */
export interface ModuleProbe {
  /** ERC-7579 `isModuleInstalled(moduleTypeId, module, additionalContext)` on the account. */
  isModuleInstalled(args: { account: string; module: string; moduleTypeId: bigint }): Promise<boolean>;
  /** ERC-7579 `IModule.isInitialized(smartAccount)` on the module. */
  isModuleInitialized(module: string, account: string): Promise<boolean>;
}

export interface ProbeArgs {
  account: string;
  module: string;
  moduleTypeId: bigint;
}

export interface ProbeResult {
  installed: boolean;
  initialized: boolean;
  ok: boolean;
  /** Why the probe failed, when it did. */
  reason?: string;
}

/** Reads both halves of the probe; `ok` only when both hold. */
export async function probeModule(probe: ModuleProbe, args: ProbeArgs): Promise<ProbeResult> {
  const installed = await probe.isModuleInstalled(args);
  if (!installed) {
    return {
      installed: false,
      initialized: false,
      ok: false,
      reason: 'module is not installed on the account',
    };
  }

  const initialized = await probe.isModuleInitialized(args.module, args.account);
  if (!initialized) {
    return {
      installed: true,
      initialized: false,
      ok: false,
      reason: 'module is installed but isInitialized() is false — silent no-op install (AA24-class)',
    };
  }

  return { installed: true, initialized: true, ok: true };
}
