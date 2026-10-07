import { describe, expect, it, vi } from 'vitest';
import {
  MigrationError,
  applyMigrationAction,
  canApplyMigrationAction,
  createModuleRegistry,
  isTerminalMigrationStatus,
  migrateSession,
  probeModule,
  routeSession,
  type MigrationRecord,
  type ModuleDescriptor,
  type ModuleProbe,
} from './index.js';

const LEGACY: ModuleDescriptor = {
  version: 'legacy',
  address: '0x1111111111111111111111111111111111111111',
  encoding: 'payload',
  multiSession: false,
  enforcedLimits: false,
};

const V1: ModuleDescriptor = {
  version: 'v1',
  address: '0x2222222222222222222222222222222222222222',
  encoding: 'onchain',
  multiSession: true,
  enforcedLimits: true,
};

function record(overrides: Partial<MigrationRecord> = {}): MigrationRecord {
  return {
    account: '0xaaaa000000000000000000000000000000000001',
    sessionId: 's-1',
    fromVersion: 'legacy',
    toVersion: 'v1',
    status: 'not-migrated',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function probe(installed: boolean, initialized: boolean): ModuleProbe {
  return {
    isModuleInstalled: async () => installed,
    isModuleInitialized: async () => initialized,
  };
}

describe('createModuleRegistry', () => {
  it('defaults to the newest generation and indexes by version', () => {
    const registry = createModuleRegistry([LEGACY, V1]);
    expect(registry.defaultVersion).toBe('v1');
    expect(registry.default()).toEqual(V1);
    expect(registry.get('legacy')).toEqual(LEGACY);
    expect(registry.list()).toEqual([LEGACY, V1]);
  });

  it('honours an explicit default version', () => {
    const registry = createModuleRegistry([LEGACY, V1], { defaultVersion: 'legacy' });
    expect(registry.default()).toEqual(LEGACY);
  });

  it('rejects a duplicate version', () => {
    expect(() => createModuleRegistry([V1, V1])).toThrow(MigrationError);
    expect(() => createModuleRegistry([V1, V1])).toThrow(/registered twice/);
  });

  it('rejects an empty registry or an unregistered default', () => {
    expect(() => createModuleRegistry([])).toThrow(/at least one descriptor/);
    expect(() => createModuleRegistry([LEGACY], { defaultVersion: 'v9' })).toThrow(/not registered/);
  });
});

describe('routeSession', () => {
  const registry = createModuleRegistry([LEGACY, V1]);

  it('routes a listed version to its own module', () => {
    expect(routeSession(registry, { id: 's-old', moduleVersion: 'legacy' })).toEqual(LEGACY);
    expect(routeSession(registry, { id: 's-new', moduleVersion: 'v1' })).toEqual(V1);
  });

  it('routes a version-less (pre-backfill) record to the default generation', () => {
    expect(routeSession(registry, { id: 's-legacy' })).toEqual(V1);
  });

  it('rejects a record that references an unregistered version', () => {
    expect(() => routeSession(registry, { id: 's-x', moduleVersion: 'v9' })).toThrow(/unregistered module version v9/);
  });
});

describe('probeModule', () => {
  const args = { account: '0xaa', module: '0xmm', moduleTypeId: 1n };

  it('passes only when both halves hold', async () => {
    await expect(probeModule(probe(true, true), args)).resolves.toEqual({
      installed: true,
      initialized: true,
      ok: true,
    });
  });

  it('fails when the module is not installed', async () => {
    const result = await probeModule(probe(false, false), args);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/not installed/);
  });

  it('fails on a silent no-op install', async () => {
    const result = await probeModule(probe(true, false), args);
    expect(result).toMatchObject({ installed: true, initialized: false, ok: false });
    expect(result.reason).toMatch(/silent no-op install/);
  });

  it('short-circuits the module read when the install is missing', async () => {
    const isModuleInitialized = vi.fn(async () => true);
    await probeModule({ isModuleInstalled: async () => false, isModuleInitialized }, args);
    expect(isModuleInitialized).not.toHaveBeenCalled();
  });
});

describe('migration state machine', () => {
  it('walks not-migrated -> migrating -> migrated', () => {
    const begun = applyMigrationAction(record(), 'begin', { at: 't1' });
    expect(begun.status).toBe('migrating');

    const done = applyMigrationAction(begun, 'confirm', {
      at: 't2',
      probe: { installed: true, initialized: true, ok: true },
    });
    expect(done.status).toBe('migrated');
    expect(done.updatedAt).toBe('t2');
    expect(isTerminalMigrationStatus(done.status)).toBe(true);
  });

  it('refuses to confirm without a passing probe', () => {
    const begun = applyMigrationAction(record(), 'begin', { at: 't1' });
    expect(() => applyMigrationAction(begun, 'confirm', { at: 't2' })).toThrow(/no probe result/);
    expect(() =>
      applyMigrationAction(begun, 'confirm', {
        at: 't2',
        probe: { installed: true, initialized: false, ok: false, reason: 'silent no-op install' },
      }),
    ).toThrow(/no-op install/);
  });

  it('lands a failed migration in exception, then retries or rolls back', () => {
    const begun = applyMigrationAction(record(), 'begin', { at: 't1' });
    const failed = applyMigrationAction(begun, 'fail', { at: 't2', reason: 'rpc timeout' });
    expect(failed.status).toBe('exception');
    expect(failed.reason).toBe('rpc timeout');

    const retried = applyMigrationAction(failed, 'retry', { at: 't3' });
    expect(retried.status).toBe('migrating');
    expect(retried.reason).toBeUndefined();

    const rolledBack = applyMigrationAction(failed, 'rollback', { at: 't4', reason: 'abandon' });
    expect(rolledBack.status).toBe('not-migrated');
    expect(rolledBack.reason).toBe('abandon');
  });

  it('blocks illegal transitions and terminal actions', () => {
    expect(canApplyMigrationAction('not-migrated', 'confirm')).toBe(false);
    expect(() => applyMigrationAction(record(), 'confirm', { at: 't' })).toThrow(/cannot confirm/);
    expect(() => applyMigrationAction(record({ status: 'migrated' }), 'begin', { at: 't' })).toThrow(
      /is migrated; cannot begin/,
    );
    expect(isTerminalMigrationStatus('migrated')).toBe(true);
    expect(isTerminalMigrationStatus('exception')).toBe(false);
  });
});

describe('migrateSession', () => {
  it('confirms when both probes pass', async () => {
    const migrated = await migrateSession({ record: record(), probe: probe(true, true), probeArgs: { account: '0xaa', module: '0xmm', moduleTypeId: 1n }, at: 't' });
    expect(migrated.status).toBe('migrated');
  });

  it('goes to exception when the probe reports a silent no-op', async () => {
    const migrated = await migrateSession({ record: record(), probe: probe(true, false), probeArgs: { account: '0xaa', module: '0xmm', moduleTypeId: 1n }, at: 't' });
    expect(migrated.status).toBe('exception');
    expect(migrated.reason).toMatch(/silent no-op install/);
  });
});
