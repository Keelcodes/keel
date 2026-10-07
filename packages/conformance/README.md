# @keelcodes/conformance

Cross-ecosystem **conformance and security suite** for agent accounts — the
neutral, spec-anchored layer that answers one question: *does this ERC-7579
account (and the modules installed on it) actually behave the way the standard
says?*

It is deliberately free of Keel-specific dependencies: a check talks to a small
`AccountReader` port, so the same suite runs against an in-memory fake in tests or
a live chain via `createViemReader`. Any team can point it at their own account.

## Status

| Suite | Coverage |
|---|---|
| **ERC-7579** | ✅ core account surface + module install/uninstall lifecycle + type validation |
| **ERC-7710** | ✅ delegation hash / domain binding / reference getters |
| **ERC-7715** | ✅ wallet capability discovery + granted-permission shape |
| **ERC-8004** | ✅ identity (ERC-721) + agent wallet + reputation binding |
| **Red-team** | ✅ `KeelPolicyHook` adversarial cases, mapped to `T-*` threat ids |

See [`docs/CONFORMANCE.md`](../../docs/CONFORMANCE.md) for the full matrix and
[`docs/THREAT_MODEL.md`](../../docs/THREAT_MODEL.md) for the threat catalogue.

## Usage

```ts
import { createPublicClient, http } from 'viem';
import { ERC7579_SUITE, createViemReader, formatReport, runSuite } from '@keelcodes/conformance';

const client = createPublicClient({ transport: http('https://bsc-testnet-rpc.publicnode.com') });

const report = await runSuite(
  {
    reader: createViemReader(client),
    account: '0x…',       // the smart account under test
    module: '0x…',        // the module you expect to be installed
    moduleTypeId: 4n,     // ERC-7579 module type (4 = hook)
  },
  ERC7579_SUITE,
);

console.log(formatReport(report));
// FAIL · ERC-7579 · 9 checks · account 0x… · module 0x… · type 4
//   ✓ !! erc7579.account.deployed — account has bytecode
//   ✗ !! erc7579.module.initialized — module is installed but reports isInitialized == false …
// 8 passed · 1 failed (1 critical) · 3ms
```

Every read is a `view` call, so a read-only client is enough. The two module
**lifecycle** checks mutate state (install/uninstall), so they need a second,
explicitly injected `moduleAdmin` port; without it they fail with a clear
"needs reader, moduleAdmin …" message rather than silently skipping — a run is
read-only unless you opt in. `erc7579.module.isModuleType` is a plain read and
needs no extra port.

Other suites bind their own port instead of the account fields:

```ts
import { ERC7710_SUITE, createViemDelegationReader } from '@keelcodes/conformance';

const delegation = await runSuite(
  { delegation: createViemDelegationReader(client, manager) },
  ERC7710_SUITE,
);
```

## The checks

| id | severity | asserts |
|---|---|---|
| `erc7579.account.deployed` | critical | the account has bytecode |
| `erc7579.account.supportsSingleMode` | high | `supportsExecutionMode` for callType `0x00` |
| `erc7579.account.supportsBatchMode` | high | `supportsExecutionMode` for callType `0x01` |
| `erc7579.account.accountId` | medium | `accountId()` is non-empty |
| `erc7579.module.installed` | critical | `isModuleInstalled(moduleTypeId, module, 0x)` is true |
| `erc7579.module.initialized` | critical | the module's own `isInitialized(account)` is true |
| `erc7579.module.installUninstallFlow` | critical | `installModule` registers the module, `uninstallModule` removes it |
| `erc7579.module.onInstallOnUninstall` | high | `onInstall` / `onUninstall` took effect (`isInitialized` tracks the lifecycle) |
| `erc7579.module.isModuleType` | high | `isModuleType` is true only for the module's own type (all four ids probed) |

`erc7579.module.installed` + `erc7579.module.initialized` are the two halves of the
**migration probe**: an install can register a module on the account while the
module's `onInstall` silently no-ops (e.g. a mismatched `initData` layout). Both
assertions must hold, otherwise the account looks configured while the module
enforces nothing — a silent AA24-class failure.

### ERC-7710 — delegation

| id | severity | asserts |
|---|---|---|
| `erc7710.manager.deployed` | critical | the `DelegationManager` has bytecode |
| `erc7710.manager.domainBinding` | high | `getDomainHash()` equals the EIP-712 preimage for **this** chain + manager |
| `erc7710.manager.delegationHash` | critical | `getDelegationHash()` equals our off-chain derivation |
| `erc7710.manager.signatureIgnored` | high | changing `signature` does not change the hash |
| `erc7710.manager.rootAuthority` | medium | `ROOT_AUTHORITY()` is the all-ones sentinel |
| `erc7710.manager.anyDelegate` | medium | `ANY_DELEGATE()` is the reference wildcard |
| `erc7710.manager.notDisabledByDefault` | high | a fresh delegation reads as enabled |

The EIP body fixes only `redeemDelegations`; the getters probed here are the
MetaMask delegation-framework reference the EIP names. The suite's core value is
**off-chain / on-chain agreement** on the hash and domain separator — a mismatch
is a cross-chain or cross-contract replay vector.

### ERC-7715 — permissions

| id | severity | asserts |
|---|---|---|
| `erc7715.wallet.capabilityDiscovery` | high | `wallet_getSupportedExecutionPermissions` advertises at least one type |
| `erc7715.wallet.chainIdFormat` | medium | advertised chain ids are `0x` hex |
| `erc7715.wallet.grantedResponseShape` | high | `wallet_getGrantedExecutionPermissions` matches `PermissionResponse` |
| `erc7715.wallet.delegationManagerBound` | high | a granted permission redeems via the expected manager (cross-checked with ERC-7710) |

ERC-7715 is a **wallet JSON-RPC** standard (EIP-1193 `request`), not on-chain;
execution lands on ERC-7710's `redeemDelegations`.

### ERC-8004 — agent registry

| id | severity | asserts |
|---|---|---|
| `erc8004.identity.deployed` | critical | the identity registry has bytecode |
| `erc8004.identity.erc721` | high | `supportsInterface(ERC-721)` is true |
| `erc8004.identity.agentRegistered` | critical | `ownerOf(agentId)` is non-zero |
| `erc8004.identity.agentURI` | medium | `tokenURI(agentId)` resolves to something |
| `erc8004.identity.agentWallet` | high | `getAgentWallet(agentId)` is non-zero |
| `erc8004.reputation.bound` | high | the reputation registry points at the identity registry |

### Red-team — adversarial cases

The Foundry red-team suite (`contracts/test/redteam/KeelPolicyHook.redteam.t.sol`)
is surfaced through the *same* report machinery. Each case is mapped explicitly
to a `T-*` threat id from [`THREAT_MODEL.md`](../../docs/THREAT_MODEL.md) §4, via
an injectable `RedTeamPort` (a `testName → passed` table):

| id | severity | asserts (Foundry case) |
|---|---|---|
| `redteam.t-bypass-01…06` | critical | delegatecall / unknown selector / `transferFrom` / short calldata / widened whitelist / unauthorised target are all refused |
| `redteam.t-ceiling-01/02` | high | a batch cannot split around a native or token daily cap |
| `redteam.t-accrual-01/02` | high | a session cannot be re-installed to reset counters, nor charged by a foreign caller |
| `redteam.t-window-01` | high | an expired session is refused |
| `redteam.t-lifecycle-01` | critical | an uninstalled session cannot be used |

A case whose result is **absent** reads as **"not run"** and fails the report —
an unverified threat is never silently green. Run it against Foundry:

```bash
pnpm redteam        # builds the package, runs forge, prints the report + threat map
```

The script (`packages/conformance/scripts/redteam-report.mjs`) shells out to
`forge test --match-path 'test/redteam/*' --json`, parses the nested result
shape, and renders a normal `formatReport` (exit code `0` only if every case was
Foundry-verified). `--input <file>` parses a saved JSON instead, and
`--contracts-dir <path>` overrides the checkout location.

## Writing a suite

A check returns a short pass message or throws to fail. ERC-7579 checks narrow the
target with `accountTarget`; other suites read their own bound port:

```ts
import { accountTarget, type Check } from '@keelcodes/conformance';

const myCheck: Check = {
  id: 'ercXXXX.thing.holds',
  title: 'Thing holds',
  spec: 'ERC-XXXX §1.2',
  severity: 'high',
  async run(target) {
    const { reader, account } = accountTarget(target);
    if (!(await reader.hasCode(account))) throw new Error('not deployed');
    return 'ok';
  },
};
```

`runChecks` / `runSuite` never throw: a throwing check is recorded as a failure
with its message, so one broken probe cannot abort a run.

## Develop

```bash
pnpm --filter @keelcodes/conformance test
pnpm --filter @keelcodes/conformance typecheck
pnpm redteam     # Foundry red-team cases → conformance report (needs forge)
pnpm sandbox     # docker compose -f infra/docker-compose.yml up
```
