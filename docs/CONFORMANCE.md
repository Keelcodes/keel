# Conformance

Keel ships a neutral conformance and security suite so any team can check whether
an ERC-7579 account — and the modules installed on it — actually behave the way
the standard says. It is the public-good half of depth **D**; the threat catalogue
it feeds is in [`THREAT_MODEL.md`](./THREAT_MODEL.md).

## Coverage matrix

| Standard | Suite | Status |
|---|---|---|
| **ERC-7579** | `ERC7579_SUITE` — account surface + module install/uninstall lifecycle + type validation | ✅ |
| **ERC-7710** | `ERC7710_SUITE` — delegation hash + domain binding + reference getters | ✅ |
| **ERC-7715** | `ERC7715_SUITE` — wallet capability discovery + granted-permission shape | ✅ |
| **ERC-8004** | `ERC8004_SUITE` — agent identity (ERC-721) + wallet + reputation binding | ✅ |
| **Red-team** | `REDTEAM_SUITE` — `KeelPolicyHook` + `KeelBoundedActions` adversarial cases, mapped to `T-*` threat ids | ✅ |

New standards slot in as additional `Suite`s — the runner, report and check shape
are standard-agnostic.

Each suite is bound to its own port, so a run carries only what the suite needs:

| Suite | Port | Notes |
|---|---|---|
| ERC-7579 | `AccountReader` (+ `account` / `module` / `moduleTypeId`) | on-chain account surface; reads only |
| ERC-7579 (lifecycle) | `ModuleAdminPort` | explicit write port; install/uninstall mutate state |
| ERC-7710 | `DelegationReader` | bound to one `DelegationManager` |
| ERC-7715 | `PermissionsProvider` | a wallet's EIP-1193 `request`, not a chain |
| ERC-8004 | `AgentRegistryReader` | bound to one identity registry + agent |
| Red-team | `RedTeamPort` | a Foundry `testName → passed` table |

## Cross-standard checks

Some checks span standards, which is where the suite earns its keep:

- `erc7715.wallet.delegationManagerBound` — a granted ERC-7715 permission must
  redeem via the ERC-7710 manager under test; if the two disagree, the grant is
  unusable (or points at a hostile manager).
- `erc7710.manager.domainBinding` / `erc7710.manager.delegationHash` — the
  off-chain EIP-712 derivation must equal the manager's own getters. A mismatch is
  a cross-chain / cross-contract replay vector.

## How it runs

The TypeScript suite ([`@keelcodes/conformance`](../packages/conformance)) talks
to small ports, not to a chain directly — an `AccountReader` for ERC-7579, and one
bound reader per other suite. Each ships a viem factory:

- **In-memory fakes** — used by the package's own tests, so the suite is runnable
  in CI with no node and no network.
- **`createViemReader`**, **`createViemDelegationReader`**,
  **`createViemPermissionsProvider`**, **`createViemAgentRegistryReader`** —
  point the same suites at a live chain or wallet. Every read is a `view` call, so
  a read-only client is enough.

```ts
import { createPublicClient, http } from 'viem';
import { ERC7579_SUITE, createViemReader, formatReport, runSuite } from '@keelcodes/conformance';

const report = await runSuite(
  { reader: createViemReader(createPublicClient({ transport: http(RPC) })), account, module, moduleTypeId: 4n },
  ERC7579_SUITE,
);
console.log(formatReport(report));
```

Locally:

```bash
pnpm --filter @keelcodes/conformance test       # suite + runners, no chain needed
pnpm --filter @keelcodes/conformance typecheck
```

## The migration probe (silent AA24)

Installing a module and having it *enforce* something are two different facts.
An install can register a module on the account (so `isModuleInstalled` is true)
while the module's own `onInstall` silently no-ops — a mismatched `initData`
layout, or a value it ignored. The account then looks configured while the module
enforces nothing, and nothing reverts.

The suite therefore asserts **both** halves:

| Check | Reads |
|---|---|
| `erc7579.module.installed` | the **account**: `isModuleInstalled(moduleTypeId, module, 0x)` |
| `erc7579.module.initialized` | the **module**: `isInitialized(account)` |

Either one failing is a critical failure. This is `T-SILENT-01` in the threat
model.

The suite also drives the **round trip** end to end. Because install/uninstall
mutate the account, they are modelled as a separate, explicitly injected write
port (`ModuleAdminPort`) rather than folded into the read-only `AccountReader`:

| Check | Asserts |
|---|---|
| `erc7579.module.installUninstallFlow` | `installModule` → `isModuleInstalled` true → `uninstallModule` → `isModuleInstalled` false |
| `erc7579.module.onInstallOnUninstall` | `onInstall` took effect (`isInitialized` true) and `onUninstall` cleared it |
| `erc7579.module.isModuleType` | `isModuleType` is true for exactly the module's own id and false for the other three (all four ids probed) |

A run with only an `AccountReader` is read-only; the two mutation checks then
fail loudly ("needs reader, moduleAdmin …") instead of silently skipping.

## Red team

The adversarial cases are executable Solidity, not a document — see
[`contracts/test/redteam/`](../contracts/test/redteam). Each case frames a bypass
attempt and asserts it is refused, tagged with the `T-*` id it covers. Two layers
are covered: the per-call policy (`KeelPolicyHook`) and the cross-call aggregate
budget (`KeelBoundedActions`, the ERC-8312 substrate — see
[`BOUNDED_ACTIONS.md`](./BOUNDED_ACTIONS.md)).

```bash
cd contracts && forge test --match-path 'test/redteam/*'
```

Current set: `T-BYPASS-01…06`, `T-CEILING-01/02`, `T-ACCRUAL-01/02`,
`T-WINDOW-01`, `T-LIFECYCLE-01`, `T-ENVELOPE-01…09`.

The cases also run through the **same report machinery** as the standards
suites, via `REDTEAM_SUITE` and an injectable `RedTeamPort`. Each check is mapped
explicitly to its `T-*` id (the two spell ids differently: `T-BYPASS-01` vs
`T_BYPASS_01`), so the report prints one line per threat. A case Foundry did not
run reads as **"not run"** and fails the report — unverified is never green.

```bash
pnpm redteam   # builds the package, runs forge --json, prints the conformance report
```

The script is `packages/conformance/scripts/redteam-report.mjs`; it parses the
nested `forge test --match-path 'test/redteam/*' --json` output (via
`parseForgeRedTeamReport`) and exits non-zero unless every case is
Foundry-verified. `--input <file>` parses a saved JSON, `--contracts-dir <path>`
overrides the checkout.

## Protocol Interaction Manifests (ERC-8313)

A **PIM** is a machine-readable JSON document describing *how* to interact with a
smart-contract protocol: not just its ABI, but the ordered workflow that fulfils
a user intent. It is a **manifest format**, not an on-chain conformance suite —
consuming a PIM parses and validates a client-side artifact, and asserts nothing
about how an account or module behaves on chain. Keel therefore treats it as a
*consumer surface*, separate from the ERC-7579/7710/7715/8004 suites above.

Keel's PIM support lives in [`@keelcodes/manifest`](../packages/manifest):

- **Consume** — `validatePim` checks an untrusted document against the nine
  mandatory top-level sections and their rules (address XOR lookup, role/category
  enums, lookup/contract references, intent step ordering, `ui` coverage of every
  intent), plus the standard's mandatory semantic gates (expired `validUntil`,
  out-of-scope `chainId`). `trustLevelOf` verifies a signature over the keccak256
  hash of the manifest minus its `signatures` section and assigns ERC-8313's four
  trust levels (0 Unverified · 1 Community · 2 Protocol Signed · 3 Wallet
  Verified).
- **Produce** — `buildKeelPim` emits Keel's own manifest describing the on-chain
  interaction surface: the `KeelPolicyHook` (the account's gated execution path)
  and the `KeelBoundedActions` ERC-8312 substrate, with `Envelope`/`Cursor`
  tuple types, `getCursor`/`getStatus`/`isActive` lookups and
  `grantBoundedSession` / `drawBoundedAction` / `readEnvelope` intents. The
  output is asserted to pass `validatePim` in the package's tests.

The same consumption surface is exposed to a model through two ungated,
read-only tools in [`@keelcodes/mcp`](../packages/mcp): `pim_validate` and
`pim_inspect`.

```bash
pnpm --filter @keelcodes/manifest build
node packages/manifest/scripts/pim.mjs validate packages/manifest/scripts/fixtures/valid.pim.json
node packages/manifest/scripts/pim.mjs inspect  packages/manifest/scripts/fixtures/valid.pim.json
```

Honest boundaries: this tracks the **draft of 2026-06-19** (author Paul Angus
Bark, [PR #1836](https://github.com/ethereum/ERCs/pull/1836)). Steps do not yet
pin the field that names the lookup a step runs, so Keel uses `lookup: "<name>"`
and only warns on a dangling reference. The signature payload style (raw digest
vs EIP-191) is not fixed by the draft, so both interpretations are attempted and
a signature is never reported as verified unless it actually recovers to the
declared signer; unsigned manifests are Level 0, and `buildKeelPim` emits no
signatures. These unverified points are annotated in the package README.

## Adding a suite

1. Write `Check`s (`id`, `title`, `spec`, `severity`, `run`) — see the package
   README. Return a pass message, or throw to fail.
2. Bundle them into a `Suite`.
3. Export it from `packages/conformance/src/index.ts`.
4. Add the standard to the coverage matrix above and, if it introduces a new
   attack class, a `T-*` row in `THREAT_MODEL.md` and a red-team case.

## CI

The suite runs on every push: the `build` job runs `pnpm test` (which includes
`@keelcodes/conformance`), and the `contracts` job runs `forge test` followed by
an explicit `Red team` step (`forge test --match-path 'test/redteam/*' -vvv`) so a
red-team regression is visible in the log.

The `sandbox` job validates `infra/docker-compose.yml` with `docker compose config
-q` on every run — a fast, daemon-free parse, guarded by a `command -v docker`
check so a runner without Docker cannot break CI — and brings the full local AA
stack up only on manual dispatch (`workflow_dispatch` with `sandbox: true`),
bounded by a step timeout and a health poll so it can never hang the workflow.
