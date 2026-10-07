# @keelcodes/migrate

Lazy, **dual-module migration** tooling for ERC-7579 session validators.

The account is already an ERC-7579 account — only the *module* changes. That means
no account migration, no key rotation and no asset movement: the account address,
its owner and its balances are untouched. The operator needs exactly three things,
and this package is those three:

- **Version routing** — session records carry a `module_version`; new sessions go
  to the new module while in-flight ones keep their old encoding.
- **A migration state machine** — `not-migrated → migrating → migrated`, with
  `exception` for a failed probe and explicit `retry` / `rollback`.
- **The probe** — the two on-chain assertions that catch a silent, AA24-class
  no-op install *before* traffic is cut over.

It has **no runtime dependencies** (only `vitest` for its own tests), so it can be
dropped into a relay, a migration script or a CI job.

## Why lazy

Rewriting every session record up front means a flag day, a maintenance window and
a rollback plan you will probably never test. Instead:

- A record written **before** the version column existed has no `moduleVersion`.
  It routes to the registry's **default** generation and keeps working until it
  expires or is revoked — no backfill required.
- A record that **does** carry a version routes to that exact generation, so old
  encodings keep validating while the fleet moves over.
- The cut-over, when it happens, is on the session-rotation path: *revoke or
  rotate is the migration*.

## Routing

```ts
import { createModuleRegistry, routeSession } from '@keelcodes/migrate';

const registry = createModuleRegistry([
  // oldest first — the last descriptor becomes the default
  { version: 'v1', address: '0x…', encoding: 'payload', multiSession: false, enforcedLimits: false },
  { version: 'v2', address: '0x…', encoding: 'onchain', multiSession: true,  enforcedLimits: true  },
]);

routeSession(registry, { id: 's-1' });                       // → v2 (default, legacy record)
routeSession(registry, { id: 's-2', moduleVersion: 'v1' });  // → v1 (in-flight)
routeSession(registry, { id: 's-3', moduleVersion: 'v9' });  // throws unknown-module-version
```

`ModuleDescriptor` records what the router must know about one generation: its
`encoding` (`onchain` on OxaChain, `payload` elsewhere), whether it allows more
than one session per account (`multiSession`) and whether spend limits are
enforced **on-chain** rather than off-chain only (`enforcedLimits`).

## The probe (silent AA24)

Installing a module and having it *enforce* something are two different facts. An
install can register a module on the account (`isModuleInstalled == true`) while
the module's own `onInstall` silently no-ops — a mismatched `initData` layout, or
a value it ignored. Nothing reverts, the account looks configured, and the module
enforces nothing.

The probe therefore asserts **both** halves:

| Half | Reads |
|---|---|
| `isModuleInstalled` | the **account**: `isModuleInstalled(moduleTypeId, module, 0x)` |
| `isModuleInitialized` | the **module**: `IModule.isInitialized(account)` |

```ts
import { probeModule } from '@keelcodes/migrate';

const result = await probeModule(probe, { account, module, moduleTypeId: 4n });
// { installed: true, initialized: false, ok: false,
//   reason: 'module is installed but isInitialized() is false — silent no-op install (AA24-class)' }
```

`ok` is only true when **both** hold. `ModuleProbe` is a port — back it with viem
in production and a fake in tests.

## Rehearsal on a fork

Rehearse the probe against a real chain **before** pointing it at production,
with no credentials and no real transactions. `@keelcodes/adapters` ships a
viem-backed `ModuleProbe` whose shape matches this package's port, so the two
compose without migrate taking on a viem dependency:

```ts
import { createPublicClient, http } from 'viem';
import { bsc } from 'viem/chains';
import { createViemModuleProbe } from '@keelcodes/adapters';
import { probeModule } from '@keelcodes/migrate';

const client = createPublicClient({ chain: bsc, transport: http() });
const probe = createViemModuleProbe(client); // structurally a ModuleProbe

await probeModule(probe, { account, module, moduleTypeId: 4n });
```

`createViemModuleProbe` reads `isModuleInstalled` from the **account** and
`isInitialized` from the **module**; a module that does not implement
`isInitialized` resolves to `false` rather than throwing, so the probe returns the
AA24 reason above instead of crashing.

The adapters package also ships a drill that forks BSC, validates the real address
book and runs both the positive and negative probe paths against a freshly
deployed hook — writing only to the fork:

```bash
pnpm --filter @keelcodes/adapters build      # the drill loads the built package
pnpm --filter @keelcodes/adapters fork-drill
```

`BSC_RPC_URL` overrides the default fork source
(`https://bsc-dataseed.bnbchain.org`); anvil listens on port 8546. The drill exits
non-zero if any real address has lost its code or an assertion fails, and always
tears the fork down.

## The state machine

```
not-migrated --begin--> migrating --confirm--> migrated
                             |  ^
                           fail |  | retry
                             v  |
                         exception --rollback--> not-migrated
```

- Only `begin` is reachable from `not-migrated`.
- `migrated` is **terminal**: once both probes pass, the cut-over is one-way.
- A failed probe lands in `exception`, never in `migrated` — the account keeps
  running the old module until an operator `retry`s or `rollback`s.
- `confirm` **requires** a passing probe result; confirming without one throws
  `probe-failed`.

`applyMigrationAction` is a pure reducer (never mutates); `migrateSession` runs one
whole step — `begin`, probe, then `confirm` on success or `fail` into `exception`:

```ts
import { migrateSession } from '@keelcodes/migrate';

const next = await migrateSession({
  record: { account, sessionId, fromVersion: 'v1', toVersion: 'v2', status: 'not-migrated', updatedAt },
  probe,
  probeArgs: { account, module: v2Module, moduleTypeId: 4n },
  at: new Date().toISOString(),
});
// status: 'migrated' on a clean probe, 'exception' otherwise
```

## Errors

Every failure is a `MigrationError` with a stable `code`:

| code | when |
|---|---|
| `unknown-module-version` | a session references a version the registry does not know |
| `duplicate-module-version` | two descriptors share a version |
| `no-default-version` | the registry is empty, or its default is unregistered |
| `invalid-transition` | the action is not reachable from the current status |
| `probe-failed` | `confirm` was called with a missing or failing probe |

## Develop

```bash
pnpm --filter @keelcodes/migrate test
pnpm --filter @keelcodes/migrate typecheck
```

The migration plan itself (dual-module, grey release, rollback) is in the
consumer repo's plan (§7, kept outside this repository).
