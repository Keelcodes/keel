import { MigrationError } from './errors.js';
import { probeModule, type ModuleProbe, type ProbeArgs, type ProbeResult } from './probe.js';
import type { ModuleVersion } from './routing.js';

/**
 * The lazy-migration state machine.
 *
 * ```
 * not-migrated --begin--> migrating --confirm--> migrated
 *                              |  ^                
 *                            fail |  | retry       
 *                              v  |                
 *                          exception --rollback--> not-migrated
 * ```
 *
 * Only `begin` is reachable from `not-migrated`, and `migrated` is terminal: a
 * migration is a one-way cut-over once both probes pass. A failed probe lands in
 * `exception`, never in `migrated` — the account keeps running the old module
 * until an operator retries or rolls back.
 */
export type MigrationStatus = 'not-migrated' | 'migrating' | 'migrated' | 'exception';

export type MigrationAction = 'begin' | 'confirm' | 'fail' | 'retry' | 'rollback';

const TRANSITIONS: Readonly<Record<MigrationStatus, readonly MigrationAction[]>> = {
  'not-migrated': ['begin'],
  migrating: ['confirm', 'fail'],
  exception: ['retry', 'rollback'],
  migrated: [],
};

export interface MigrationRecord {
  account: string;
  sessionId: string;
  fromVersion: ModuleVersion;
  toVersion: ModuleVersion;
  status: MigrationStatus;
  /** ISO-8601 timestamp of the last transition. */
  updatedAt: string;
  reason?: string;
}

export function isTerminalMigrationStatus(status: MigrationStatus): boolean {
  return TRANSITIONS[status].length === 0;
}

export function canApplyMigrationAction(status: MigrationStatus, action: MigrationAction): boolean {
  return TRANSITIONS[status].includes(action);
}

export interface MigrationActionInput {
  /** ISO-8601 timestamp of this transition. */
  at: string;
  /** Required by `confirm` — the double-probe outcome. */
  probe?: ProbeResult;
  /** Recorded by `fail` / `rollback`. */
  reason?: string;
}

/** Applies one action, returning the next record. Pure — never mutates. */
export function applyMigrationAction(
  record: MigrationRecord,
  action: MigrationAction,
  input: MigrationActionInput,
): MigrationRecord {
  if (!TRANSITIONS[record.status].includes(action)) {
    throw new MigrationError(
      'invalid-transition',
      `migration ${record.account}/${record.sessionId} is ${record.status}; cannot ${action}`,
    );
  }

  switch (action) {
    case 'begin':
    case 'retry':
      return { ...record, status: 'migrating', updatedAt: input.at, reason: undefined };
    case 'confirm': {
      if (input.probe === undefined || !input.probe.ok) {
        const reason = input.probe === undefined ? 'no probe result supplied' : input.probe.reason;
        throw new MigrationError('probe-failed', `cannot confirm migration: ${reason ?? 'probe failed'}`);
      }
      return { ...record, status: 'migrated', updatedAt: input.at, reason: undefined };
    }
    case 'fail':
      return {
        ...record,
        status: 'exception',
        updatedAt: input.at,
        reason: input.reason ?? 'migration failed',
      };
    case 'rollback':
      return { ...record, status: 'not-migrated', updatedAt: input.at, reason: input.reason };
  }
}

export interface MigrateSessionArgs {
  record: MigrationRecord;
  probe: ModuleProbe;
  /** Passed straight to the probe: the account + module that must be live. */
  probeArgs: ProbeArgs;
  /** ISO-8601 timestamp for every transition in this run. */
  at: string;
}

/**
 * One lazy migration step: `begin`, run the double probe, then `confirm` on
 * success or `fail` into `exception`.
 *
 * This is the "revoke or rotate *is* the migration" path — invoked when a session
 * is rotated or revoked, so nothing is paid for until a legacy session is touched.
 */
export async function migrateSession(args: MigrateSessionArgs): Promise<MigrationRecord> {
  const migrating = applyMigrationAction(args.record, 'begin', { at: args.at });
  const result = await probeModule(args.probe, args.probeArgs);

  return result.ok
    ? applyMigrationAction(migrating, 'confirm', { at: args.at, probe: result })
    : applyMigrationAction(migrating, 'fail', { at: args.at, reason: result.reason });
}
