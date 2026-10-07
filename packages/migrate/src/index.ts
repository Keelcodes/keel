/**
 * @keelcodes/migrate
 *
 * Lazy migration tooling for ERC-7579 session validators.
 *
 * The account is already ERC-7579 — only the *module* changes. That means no
 * account migration, no key rotation, no asset movement: the account address,
 * owner and balances are untouched. What the operator needs is three things,
 * and this package is exactly those three:
 *
 * - **Version routing** — session records carry a `module_version`; new sessions
 *   go to the new module while in-flight ones keep their old encoding.
 * - **A migration state machine** — `not-migrated → migrating → migrated`, with
 *   `exception` for a failed probe and explicit `retry` / `rollback`.
 * - **The probe** — the two on-chain assertions that catch a silent, AA24-class
 *   no-op install before traffic is cut over.
 */

export { MigrationError } from './errors.js';
export type { MigrationErrorCode } from './errors.js';

export { createModuleRegistry, routeSession } from './routing.js';
export type {
  CreateModuleRegistryOptions,
  ModuleDescriptor,
  ModuleRegistry,
  ModuleVersion,
  SessionRecord,
  ValidationEncoding,
} from './routing.js';

export { probeModule } from './probe.js';
export type { ModuleProbe, ProbeArgs, ProbeResult } from './probe.js';

export {
  applyMigrationAction,
  canApplyMigrationAction,
  isTerminalMigrationStatus,
  migrateSession,
} from './migration.js';
export type {
  MigrateSessionArgs,
  MigrationAction,
  MigrationActionInput,
  MigrationRecord,
  MigrationStatus,
} from './migration.js';
