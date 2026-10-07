import { EXECUTION_MODE, MODULE_TYPE, accountTarget, moduleAdminTarget, type Check, type Suite } from './types.js';

/**
 * ERC-7579 core conformance checks.
 *
 * Coverage in this slice is ERC-7579 (the account surface + the module install
 * contract). ERC-7710 / 7715 / 8004 live in `delegation.ts`, `permissions.ts`
 * and `agents.ts` — see `docs/CONFORMANCE.md` for the coverage matrix.
 */
export const ERC7579_CHECKS: readonly Check[] = [
  {
    id: 'erc7579.account.deployed',
    title: 'Account is deployed',
    spec: 'ERC-7579 §Account',
    severity: 'critical',
    async run(target) {
      const { reader, account } = accountTarget(target);
      if (!(await reader.hasCode(account))) {
        throw new Error(`no bytecode at ${account}`);
      }
      return 'account has bytecode';
    },
  },
  {
    id: 'erc7579.account.supportsSingleMode',
    title: 'Account supports the single execution mode',
    spec: 'ERC-7579 §3.1',
    severity: 'high',
    async run(target) {
      const { reader, account } = accountTarget(target);
      if (!(await reader.supportsExecutionMode(account, EXECUTION_MODE.SINGLE))) {
        throw new Error('supportsExecutionMode(single default) returned false');
      }
      return 'single (callType 0x00) supported';
    },
  },
  {
    id: 'erc7579.account.supportsBatchMode',
    title: 'Account supports the batch execution mode',
    spec: 'ERC-7579 §3.1',
    severity: 'high',
    async run(target) {
      const { reader, account } = accountTarget(target);
      if (!(await reader.supportsExecutionMode(account, EXECUTION_MODE.BATCH))) {
        throw new Error('supportsExecutionMode(batch default) returned false');
      }
      return 'batch (callType 0x01) supported';
    },
  },
  {
    id: 'erc7579.account.accountId',
    title: 'Account reports a non-empty accountId()',
    spec: 'ERC-7579 §Account',
    severity: 'medium',
    async run(target) {
      const { reader, account } = accountTarget(target);
      const id = await reader.accountId(account);
      if (typeof id !== 'string' || id.length === 0) {
        throw new Error(`accountId() returned ${JSON.stringify(id)}`);
      }
      return `accountId() = ${id}`;
    },
  },
  {
    id: 'erc7579.module.installed',
    title: 'Module is reported installed by the account',
    spec: 'ERC-7579 §ModuleManager',
    severity: 'critical',
    async run(target) {
      const { reader, account, module, moduleTypeId } = accountTarget(target);
      const installed = await reader.isModuleInstalled({ account, module, moduleTypeId });
      if (!installed) {
        throw new Error(
          `isModuleInstalled(${moduleTypeId}, ${module}) returned false — the module is not installed`,
        );
      }
      return `module ${module} installed as type ${moduleTypeId}`;
    },
  },
  {
    id: 'erc7579.module.initialized',
    title: 'Installed module reports isInitialized(account)',
    spec: 'ERC-7579 §IModule',
    severity: 'critical',
    async run(target) {
      const { reader, account, module } = accountTarget(target);
      // The second half of the migration probe: a module can be *registered* on
      // the account while its own `onInstall` silently no-op'd (a layout or
      // value mismatch that does not revert). The account then looks configured
      // but the module enforces nothing — an AA24-class silent failure.
      if (!(await reader.isModuleInitialized(module, account))) {
        throw new Error(
          'module is installed but reports isInitialized == false — silent no-op install (AA24-class)',
        );
      }
      return 'module reports initialized';
    },
  },
  {
    id: 'erc7579.module.installUninstallFlow',
    title: 'Module can be installed and uninstalled by type',
    spec: 'ERC-7579 §ModuleManager',
    severity: 'critical',
    async run(target) {
      const { reader, moduleAdmin, account, module, moduleTypeId } = moduleAdminTarget(target);
      // A round trip, so start from a clean account: a pre-existing install
      // would make `installModule` revert or could mask a broken uninstall.
      if (await reader.isModuleInstalled({ account, module, moduleTypeId })) {
        await moduleAdmin.uninstallModule({ account, module, moduleTypeId });
      }
      await moduleAdmin.installModule({ account, module, moduleTypeId });
      if (!(await reader.isModuleInstalled({ account, module, moduleTypeId }))) {
        throw new Error(
          `installModule(${moduleTypeId}, ${module}) did not register the module on ${account}`,
        );
      }
      await moduleAdmin.uninstallModule({ account, module, moduleTypeId });
      if (await reader.isModuleInstalled({ account, module, moduleTypeId })) {
        throw new Error(
          `uninstallModule(${moduleTypeId}, ${module}) left the module installed on ${account}`,
        );
      }
      return `module ${module} installed and uninstalled as type ${moduleTypeId}`;
    },
  },
  {
    id: 'erc7579.module.onInstallOnUninstall',
    title: 'onInstall / onUninstall take effect on the module',
    spec: 'ERC-7579 §IModule',
    severity: 'high',
    async run(target) {
      const { reader, moduleAdmin, account, module, moduleTypeId } = moduleAdminTarget(target);
      // The lifecycle callbacks are only observable through their effect on the
      // module's own state: initialized after install, cleared after uninstall.
      // A silent no-op on either side is exactly the failure this catches.
      if (await reader.isModuleInstalled({ account, module, moduleTypeId })) {
        await moduleAdmin.uninstallModule({ account, module, moduleTypeId });
      }
      await moduleAdmin.installModule({ account, module, moduleTypeId });
      if (!(await reader.isModuleInitialized(module, account))) {
        throw new Error('module reports isInitialized == false after install — onInstall silently no-op\'d');
      }
      await moduleAdmin.uninstallModule({ account, module, moduleTypeId });
      if (await reader.isModuleInitialized(module, account)) {
        throw new Error('module reports isInitialized == true after uninstall — onUninstall silently no-op\'d');
      }
      return 'isInitialized tracks install and uninstall';
    },
  },
  {
    id: 'erc7579.module.isModuleType',
    title: 'Module reports true for exactly its own ERC-7579 type',
    spec: 'ERC-7579 §IModule',
    severity: 'high',
    async run(target) {
      const { reader, module, moduleTypeId } = accountTarget(target);
      // Exercises all four MODULE_TYPE ids: the module must claim its own type
      // and disclaim the other three — a module that answers true to everything
      // (or to the wrong type) would be dispatched as the wrong kind.
      for (const [name, typeId] of Object.entries(MODULE_TYPE)) {
        const expected = typeId === moduleTypeId;
        const actual = await reader.isModuleType(module, typeId);
        if (actual !== expected) {
          throw new Error(
            `isModuleType(${name}=${typeId}) = ${actual}, expected ${expected} for a type-${moduleTypeId} module`,
          );
        }
      }
      return `module ${module} claims only its type ${moduleTypeId}`;
    },
  },
];

/** ERC-7579 core suite. */
export const ERC7579_SUITE: Suite = {
  name: 'ERC-7579',
  spec: 'ERC-7579 (Modular Smart Accounts)',
  checks: ERC7579_CHECKS,
};
