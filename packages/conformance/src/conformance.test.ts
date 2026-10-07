import type { PublicClient } from 'viem';
import { describe, expect, it } from 'vitest';
import {
  ERC7579_CHECKS,
  ERC7579_SUITE,
  createViemReader,
  formatReport,
  runSuite,
  summarize,
} from './index.js';
import { EXECUTION_MODE, MODULE_TYPE, type AccountReader, type Address, type ModuleAdminPort } from './types.js';

const ACCOUNT = '0x1111111111111111111111111111111111111111' as Address;
const MODULE = '0x2222222222222222222222222222222222222222' as Address;

const installedKey = (account: Address, moduleTypeId: bigint, module: Address) =>
  `${account}:${moduleTypeId}:${module}`;
const initializedKey = (module: Address, account: Address) => `${module}:${account}`;

/**
 * A tiny in-memory account + module: the read port and the write port share one
 * state, so an install observed through `AccountReader` is exactly the one the
 * `ModuleAdminPort` performed. The module starts installed and initialized, the
 * state a conformance run is normally pointed at.
 */
function makeReader(
  installed: Set<string>,
  initialized: Set<string>,
  overrides: Partial<AccountReader>,
): AccountReader {
  return {
    hasCode: async () => true,
    isModuleInstalled: async ({ account, module, moduleTypeId }) =>
      installed.has(installedKey(account, moduleTypeId, module)),
    supportsExecutionMode: async () => true,
    accountId: async () => 'kernel.v3.1',
    isModuleInitialized: async (module, account) => initialized.has(initializedKey(module, account)),
    isModuleType: async (_module, moduleTypeId) => moduleTypeId === MODULE_TYPE.HOOK,
    ...overrides,
  };
}

function makeAdmin(
  installed: Set<string>,
  initialized: Set<string>,
  overrides: Partial<ModuleAdminPort>,
): ModuleAdminPort {
  return {
    installModule: async ({ account, module, moduleTypeId }) => {
      const key = installedKey(account, moduleTypeId, module);
      if (installed.has(key)) throw new Error('module already installed');
      installed.add(key);
      initialized.add(initializedKey(module, account));
    },
    uninstallModule: async ({ account, module, moduleTypeId }) => {
      installed.delete(installedKey(account, moduleTypeId, module));
      initialized.delete(initializedKey(module, account));
    },
    ...overrides,
  };
}

function world(
  readerOverrides: Partial<AccountReader> = {},
  adminOverrides: Partial<ModuleAdminPort> = {},
) {
  const installed = new Set<string>();
  const initialized = new Set<string>();
  installed.add(installedKey(ACCOUNT, MODULE_TYPE.HOOK, MODULE));
  initialized.add(initializedKey(MODULE, ACCOUNT));
  return {
    reader: makeReader(installed, initialized, readerOverrides),
    admin: makeAdmin(installed, initialized, adminOverrides),
    installed,
    initialized,
  };
}

function target(w: ReturnType<typeof world>) {
  return {
    reader: w.reader,
    moduleAdmin: w.admin,
    account: ACCOUNT,
    module: MODULE,
    moduleTypeId: MODULE_TYPE.HOOK,
  };
}

interface ReadContractCall {
  address: Address;
  functionName: string;
  args?: readonly unknown[];
}

function stubClient(handler: (call: ReadContractCall) => unknown): PublicClient {
  return {
    getCode: async () => '0x60006000',
    readContract: async (call: ReadContractCall) => handler(call),
  } as unknown as PublicClient;
}

describe('runSuite', () => {
  it('passes on a conformant account', async () => {
    const report = await runSuite(target(world()), ERC7579_SUITE);

    expect(report.summary).toEqual({ passed: ERC7579_CHECKS.length, failed: 0, criticalFailures: 0, ok: true });
    expect(report.results.every((result) => result.status === 'pass')).toBe(true);
    expect(report.account).toBe(ACCOUNT);
    expect(report.moduleTypeId).toBe(MODULE_TYPE.HOOK);
  });

  it('fails when a module is installed but not initialized (silent AA24)', async () => {
    const report = await runSuite(target(world({ isModuleInitialized: async () => false })), ERC7579_SUITE);

    const check = report.results.find((result) => result.id === 'erc7579.module.initialized');
    expect(check?.status).toBe('fail');
    expect(check?.message).toMatch(/silent no-op install/);
    expect(report.summary.ok).toBe(false);
    expect(report.summary.criticalFailures).toBe(1);
  });

  it('fails the deployment check when the account has no code', async () => {
    const report = await runSuite(target(world({ hasCode: async () => false })), ERC7579_SUITE);

    const failed = report.results.filter((result) => result.status === 'fail');
    expect(failed.map((result) => result.id)).toEqual(['erc7579.account.deployed']);
    expect(report.summary.ok).toBe(false);
  });

  it('records a reader error as a failure instead of throwing', async () => {
    const w = world({
      accountId: async () => {
        throw new Error('rpc exploded');
      },
    });

    const report = await runSuite(target(w), ERC7579_SUITE);
    const check = report.results.find((result) => result.id === 'erc7579.account.accountId');
    expect(check?.status).toBe('fail');
    expect(check?.message).toBe('rpc exploded');
  });

  it('times each check', async () => {
    const report = await runSuite(target(world()), ERC7579_SUITE);
    expect(report.results.every((result) => result.durationMs >= 0)).toBe(true);
  });
});

describe('module lifecycle checks', () => {
  it('passes the install/uninstall flow, onInstall/onUninstall and isModuleType on a conformant module', async () => {
    const report = await runSuite(target(world()), ERC7579_SUITE);
    for (const id of [
      'erc7579.module.installUninstallFlow',
      'erc7579.module.onInstallOnUninstall',
      'erc7579.module.isModuleType',
    ]) {
      expect(report.results.find((result) => result.id === id)?.status).toBe('pass');
    }
  });

  it('fails the flow when installModule does not register the module', async () => {
    const report = await runSuite(
      target(world({}, { installModule: async () => {} })),
      ERC7579_SUITE,
    );
    const check = report.results.find((result) => result.id === 'erc7579.module.installUninstallFlow');
    expect(check?.status).toBe('fail');
    expect(check?.message).toMatch(/did not register the module/);
  });

  it('fails the flow when uninstallModule leaves the module installed', async () => {
    const report = await runSuite(
      target(world({}, { installModule: async () => {}, uninstallModule: async () => {} })),
      ERC7579_SUITE,
    );
    const check = report.results.find((result) => result.id === 'erc7579.module.installUninstallFlow');
    expect(check?.status).toBe('fail');
    expect(check?.message).toMatch(/left the module installed/);
  });

  it('fails when onUninstall silently no-ops and isInitialized stays true', async () => {
    const w = world();
    // Uninstall forgets to clear the module's own initialized flag.
    w.admin.uninstallModule = async ({ account, module, moduleTypeId }) => {
      w.installed.delete(installedKey(account, moduleTypeId, module));
    };

    const report = await runSuite(target(w), ERC7579_SUITE);
    const check = report.results.find((result) => result.id === 'erc7579.module.onInstallOnUninstall');
    expect(check?.status).toBe('fail');
    expect(check?.message).toMatch(/onUninstall silently no-op/);
  });

  it('fails isModuleType when the module claims every type', async () => {
    const report = await runSuite(target(world({ isModuleType: async () => true })), ERC7579_SUITE);
    const check = report.results.find((result) => result.id === 'erc7579.module.isModuleType');
    expect(check?.status).toBe('fail');
    expect(check?.message).toMatch(/expected false/);
  });

  it('fails the mutation checks clearly when no moduleAdmin port is supplied', async () => {
    const w = world();
    const report = await runSuite(
      { reader: w.reader, account: ACCOUNT, module: MODULE, moduleTypeId: MODULE_TYPE.HOOK },
      ERC7579_SUITE,
    );
    for (const id of ['erc7579.module.installUninstallFlow', 'erc7579.module.onInstallOnUninstall']) {
      const check = report.results.find((result) => result.id === id);
      expect(check?.status).toBe('fail');
      expect(check?.message).toMatch(/module lifecycle checks need reader, moduleAdmin/);
    }
  });
});

describe('summarize', () => {
  it('reports ok only when nothing failed', async () => {
    const ok = await runSuite(target(world()), ERC7579_SUITE);
    const bad = await runSuite(target(world({ supportsExecutionMode: async () => false })), ERC7579_SUITE);

    expect(summarize(ok.results).ok).toBe(true);
    expect(summarize(bad.results).ok).toBe(false);
  });
});

describe('formatReport', () => {
  it('marks failures and summarises the run', async () => {
    const report = await runSuite(target(world({ hasCode: async () => false })), ERC7579_SUITE);
    const text = formatReport(report);

    expect(text).toMatch(/^FAIL/);
    expect(text).toContain('✗');
    expect(text).toContain('erc7579.account.deployed');
    expect(text).toContain('critical');
  });
});

describe('ERC7579_CHECKS', () => {
  it('has unique ids, spec anchors and severities', () => {
    const ids = ERC7579_CHECKS.map((check) => check.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const check of ERC7579_CHECKS) {
      expect(check.spec).toMatch(/^ERC-7579/);
      expect(check.severity.length).toBeGreaterThan(0);
    }
  });
});

describe('EXECUTION_MODE', () => {
  it('encodes the callType in the leading byte of the mode word', () => {
    expect(EXECUTION_MODE.SINGLE).toHaveLength(66);
    expect(EXECUTION_MODE.SINGLE.slice(0, 4)).toBe('0x00');
    expect(EXECUTION_MODE.BATCH.slice(0, 4)).toBe('0x01');
  });
});

describe('createViemReader', () => {
  it('probes the account for account-level reads and the module for isInitialized', async () => {
    const calls: ReadContractCall[] = [];
    const reader = createViemReader(
      stubClient((call) => {
        calls.push(call);
        if (call.functionName === 'supportsExecutionMode') return true;
        if (call.functionName === 'accountId') return 'safe.1.0';
        return true;
      }),
    );

    await expect(reader.hasCode(ACCOUNT)).resolves.toBe(true);
    await expect(reader.isModuleInstalled({ account: ACCOUNT, module: MODULE, moduleTypeId: MODULE_TYPE.HOOK })).resolves.toBe(true);
    await expect(reader.supportsExecutionMode(ACCOUNT, EXECUTION_MODE.BATCH)).resolves.toBe(true);
    await expect(reader.accountId(ACCOUNT)).resolves.toBe('safe.1.0');
    await expect(reader.isModuleInitialized(MODULE, ACCOUNT)).resolves.toBe(true);
    await expect(reader.isModuleType(MODULE, MODULE_TYPE.HOOK)).resolves.toBe(true);

    const installed = calls.find((call) => call.functionName === 'isModuleInstalled');
    expect(installed?.address).toBe(ACCOUNT);
    expect(installed?.args).toEqual([MODULE_TYPE.HOOK, MODULE, '0x']);

    const initialized = calls.find((call) => call.functionName === 'isInitialized');
    // isInitialized lives on the module, keyed by the account — not vice versa.
    expect(initialized?.address).toBe(MODULE);
    expect(initialized?.args).toEqual([ACCOUNT]);

    const typeCall = calls.find((call) => call.functionName === 'isModuleType');
    // isModuleType also lives on the module, keyed by the type id.
    expect(typeCall?.address).toBe(MODULE);
    expect(typeCall?.args).toEqual([MODULE_TYPE.HOOK]);
  });

  it('reports no install when the account is not deployed, without reading it', async () => {
    const calls: ReadContractCall[] = [];
    const client = {
      getCode: async () => '0x',
      readContract: async (call: ReadContractCall) => {
        calls.push(call);
        return true;
      },
    } as unknown as PublicClient;

    const reader = createViemReader(client);
    await expect(reader.isModuleInstalled({ account: ACCOUNT, module: MODULE, moduleTypeId: MODULE_TYPE.HOOK })).resolves.toBe(false);
    expect(calls).toHaveLength(0);
  });
});
