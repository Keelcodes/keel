# @keelcodes/adapters

Thin adapters that expose different smart-account implementations behind a
single interface.

## Principle

Keel does **not** implement account modules. Every supported account already
speaks **ERC-7579**:

- Safe7579 is itself an adapter that makes Safe ERC-7579 compatible.
- Kernel (ZeroDev) and Nexus (Biconomy) are ERC-7579 compatible.

So supporting three accounts is **one interface plus thin per-account install
glue**, not three separate stacks.

```
            keel policy (account-agnostic)
                       ▲
              ERC-7579 (unified interface)
        ┌──────────────┼──────────────┐
      Kernel         Nexus         Safe7579
```

## Adapters

| kind | account | notes |
|---|---|---|
| `kernel` | Kernel (ZeroDev) | version-branched validator `initData` (`0.3.0-beta` / `0.3.1`) |
| `nexus` | Nexus (Biconomy) | standards-faithful, no install-time quirk |
| `safe7579` | Safe7579 | account must already have Safe7579 enabled |

Every adapter shares one ERC-7579 base (`ERC7579AccountAdapter`) and exposes:

- `isModuleInstalled({ account, module, moduleType? })` — on-chain probe; returns
  `false` for an undeployed account
- `encodeInstallModule({ moduleType, module, initData? })`
- `encodeUninstallModule({ moduleType, module, deInitData? })`

Use `createAdapter(kind, { client })` when the account kind is only known at
runtime, or instantiate a concrete adapter when it is known statically.

```ts
import { createPublicClient, http } from 'viem';
import { bsc } from 'viem/chains';
import { KernelAdapter, MODULE_TYPE } from '@keelcodes/adapters';

const client = createPublicClient({ chain: bsc, transport: http() });
const kernel = new KernelAdapter({ client }); // defaults to Kernel 0.3.1

await kernel.isModuleInstalled({ account, module });

const initData = kernel.encodeValidatorInstallData(enableData); // Kernel layout
const call = kernel.encodeInstallModule({
  moduleType: MODULE_TYPE.VALIDATOR,
  module,
  initData,
});
// → wrap `call` in the account's execute() inside a UserOp
```

## Module probe

`createViemModuleProbe(client)` returns the two-sided ERC-7579 probe that
`@keelcodes/migrate` consumes: `isModuleInstalled` asks the **account** whether a
module is registered, and `isModuleInitialized` asks the **module** whether it
stored state for the account. Modules that do not implement `isInitialized`
revert, so the probe catches that and returns `false` — a silent no-op install
surfaces as data instead of an exception. The return value is structurally
compatible with migrate's `ModuleProbe`; the packages stay decoupled (no import
either way).

```ts
import { createPublicClient, http } from 'viem';
import { bsc } from 'viem/chains';
import { createViemModuleProbe } from '@keelcodes/adapters';

const probe = createViemModuleProbe(createPublicClient({ chain: bsc, transport: http() }));
await probe.isModuleInstalled({ account, module, moduleTypeId: 4n });
await probe.isModuleInitialized(module, account); // false on revert, never throws
```

### Fork drill

`pnpm --filter @keelcodes/adapters fork-drill` forks BSC with anvil (port 8546),
validates the real address book, deploys Keel's own validator, hook and minimal
account to the fork, and runs the probe positive and negative — no credentials,
no real transactions. Override the fork source with `BSC_RPC_URL`; the drill
always tears the fork down and exits non-zero on any failed assertion.

### Migration drill

`pnpm --filter @keelcodes/adapters migration-drill` forks BSC with anvil (port
8547) and rehearses the path the fork drill does **not** cover: installing Keel
onto an account that **already exists**, rather than at creation. It creates a
Rhinestone MSA without the hook, drives the real `@keelcodes/migrate` state
machine (`routeSession` → `migrateSession`) with the real two-sided probe, then
hot-installs the hook in a **separate** transaction from the account itself
(`installModule(4, hook, initData)`), asserts the account address is unchanged,
and confirms the cut-over only once both probe halves hold. It exits non-zero on
any failed assertion. (Requires this package and `packages/migrate` built.)

Two findings it reports rather than hides:

- **The state machine refuses to confirm a migration on absent evidence** —
  `migrateSession` before the install lands in `exception`, never `migrated`.
- **On accounts that gate module management with their hook** (the MSA's
  `withHook` passes `uninstallModule` calldata to `preCheck`, which only parses
  `execute(...)`), the on-chain **reverse is refused**: the drill attempts it and
  asserts the migrated state is left intact. Kernel does not gate module
  management this way, so a reverse there needs its own rehearsal.

## Bundler & paymaster

Bundlers and paymaster services are both addressed **per chain** — ERC-7677 states
that paymaster service URLs are "not typically multichain" — so adapters resolve an
endpoint per chain rather than assuming one multichain URL.

```ts
import { createBundlerAdapter, createPaymasterAdapter, BUNDLER_RPC, PAYMASTER_RPC } from '@keelcodes/adapters';

const bundler = createBundlerAdapter('pimlico', { apiKey: process.env.PIMLICO_KEY! });
bundler.endpoint({ chainId: 56 }).url; // https://api.pimlico.io/v2/56/rpc?apikey=...
BUNDLER_RPC.sendUserOperation;         // 'eth_sendUserOperation'

const paymaster = createPaymasterAdapter('alchemy', { urls: { 8453: 'https://…/paymaster' } });
paymaster.endpoint({ chainId: 8453 }).url;
PAYMASTER_RPC.getPaymasterStubData;    // 'pm_getPaymasterStubData'
```

Endpoint precedence is `urls[chainId]` → `url` → provider builder, and a missing
endpoint throws rather than dialling the wrong host.

Keel hardcodes a URL builder **only for Pimlico** (a stable, public layout); every
other provider's endpoint is caller-supplied, so a provider re-sharding its URL can
never silently break a consumer. Adapters resolve endpoints only — they do **not**
implement the JSON-RPC calls.

## Chains

`chains.ts` is the single source of truth for which chains Keel ships defaults
for and which account kinds run on them. The per-chain `accountKinds` are
derived from the per-account chain sets, so the two can never drift.

`DEFAULT_CHAIN_ID` is **BSC mainnet** — the primary launch chain, and the chain
the fleet is deployed on. Testnets remain in the per-account chain sets but are
no longer the default.

```ts
import { DEFAULT_CHAIN_ID, accountsFor, getChain } from '@keelcodes/adapters';

getChain(DEFAULT_CHAIN_ID); // { chainId: 56, name: 'BNB Smart Chain', testnet: false, accountKinds: ['kernel', 'safe7579'] }
accountsFor(8453);          // ['kernel', 'nexus', 'safe7579']
```

`getChain` / `accountsFor` throw on an unknown chain rather than returning a
partial default, so a typo surfaces as a config error.

## Status

- ✅ Account adapters (Kernel / Nexus / Safe7579)
- ✅ Bundler endpoint adapters (Pimlico, Alchemy, CDP, Skandha, Rundler, MegaFuel)
- ✅ Paymaster endpoint adapters (ERC-7677: Pimlico, Alchemy, CDP, MegaFuel)
- ✅ Multi-chain configuration helper (`CHAINS` / `getChain` / `accountsFor`)

Pre-alpha. The public API is not stable yet.

## Out of scope

- Account module implementations
- Bundler or paymaster implementations
- Custody, billing, multi-tenancy

