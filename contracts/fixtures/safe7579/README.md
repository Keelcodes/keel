# Safe7579 account fixtures

Compiled artifacts of Rhinestone's [Safe7579](https://github.com/rhinestonewtf/safe7579)
adapter, used by `script/Acceptance.s.sol` to run a **fourth** account — a plain
Safe with the Safe7579 ERC-7579 adapter installed — through the same Keel policy
as the Rhinestone MSA, `KeelMinimalAccount` and ZeroDev Kernel.

Safe7579 is compiled in its own project and committed here as artifacts rather
than added as a Foundry dependency: it pins `@safe-global/safe-contracts`,
`@ERC4337/account-abstraction`, `sentinellist`, `solady` and a pnpm
`node_modules`-based dependency graph that does not co-exist with this project's
`lib/`, and it only needs to be built once.

## Provenance

| field | value |
| --- | --- |
| repository | `https://github.com/rhinestonewtf/safe7579` |
| tag | `v2.0.0` |
| commit | `40d92beeb423ec6a94d5667350086148df8b170c` |
| EntryPoint | **v0.7** (hard-coded canonical `0x0000000071727De22E5E9d8BAf0edAc6f37da032` in `AccessControl.entryPoint()`) |
| solc | `0.8.29` |
| profile | `release` (`optimizer = true`, `optimizer_runs = 3000`, `bytecode_hash = none`, `evm_version = cancun`) |
| registry | `IERC7484(address(0))` — registry checks are compiled out in v2.0.0 |

## Artifacts

Trimmed to `{ abi, bytecode, deployedBytecode }` from `out/`:

| file | contract | runtime size |
| --- | --- | --- |
| `Safe.json` | Safe singleton / implementation (no constructor args) | 13,756 B |
| `SafeProxyFactory.json` | `SafeProxyFactory` (no constructor args) | 2,118 B |
| `Safe7579.json` | Safe7579 fallback handler + module (constructor deploys its `Safe7579DCUtil`) | 24,470 B |
| `Safe7579Launchpad.json` | `Safe7579Launchpad` (`constructor(address entryPoint, IERC7484 registry)`) | 11,726 B |

All four are below the EIP-170 24,576-byte runtime limit.

## Regenerating

```bash
git clone --depth 1 --branch v2.0.0 https://github.com/rhinestonewtf/safe7579 /tmp/safe7579-src
cd /tmp/safe7579-src
pnpm install --ignore-scripts   # git dep build scripts are not needed for solc sources
FOUNDRY_PROFILE=release forge build

node -e '
const fs = require("fs");
const dest = "<repo>/contracts/fixtures/safe7579/";
const g = o => (typeof o === "string" ? o : o.object);
for (const [name, p] of [
  ["Safe", "out/Safe.sol/Safe.json"],
  ["SafeProxyFactory", "out/SafeProxyFactory.sol/SafeProxyFactory.json"],
  ["Safe7579", "out/Safe7579.sol/Safe7579.json"],
  ["Safe7579Launchpad", "out/Safe7579Launchpad.sol/Safe7579Launchpad.json"],
]) {
  const a = JSON.parse(fs.readFileSync(p, "utf8"));
  const out = { abi: a.abi, bytecode: g(a.bytecode), deployedBytecode: g(a.deployedBytecode) };
  fs.writeFileSync(dest + name + ".json", JSON.stringify(out, null, 2) + "\n");
}
'
```

The trailing `solar` lint error emitted by `forge build` (`file src/lib/Initializable.sol
not found`, from a `node_modules`-only import in `erc7579`) is non-fatal: `out/` is
fully populated and the sizes above are read from it.

## How the acceptance harness uses them

`Safe7579` is Safe's **fallback handler** (not a standalone account): the Safe
singleton forwards unknown calldata to it with an ERC-2771-style trailing
`caller()` appended, so inside the adapter `msg.sender` is the Safe and
`_msgSender()` is the real caller. The harness therefore creates an ordinary
Safe (Existing-Safe path, mirroring upstream `test/flavors/ExistingSafe.t.sol`):

1. `vm.deployCode("fixtures/safe7579/Safe.json")` -> Safe singleton.
2. `vm.deployCode("fixtures/safe7579/SafeProxyFactory.json")` -> proxy factory.
3. `vm.deployCode("fixtures/safe7579/Safe7579.json")` -> fallback handler + module.
4. `vm.deployCode("fixtures/safe7579/Safe7579Launchpad.json", abi.encode(entryPoint, address(0)))`
   -> launchpad.
5. `factory.createProxyWithNonce(singleton, setupInitializer, salt)` where
   `setupInitializer = Safe.setup([deployer], 1, 0, "", 0, 0, 0, 0)`.
6. The owner signs a Safe transaction that **delegatecalls** the launchpad:
   `addSafe7579(safe7579, modules, [], 0)` with
   `modules = [{module: OwnerECDSAValidator, initData: abi.encode(owner), type: 1},
               {module: KeelPolicyHook, initData: abi.encode(sessionId, policyData), type: 4}]`.
   The adapter enables itself as a Safe module, installs it as the fallback
   handler, and runs `initializeAccount` -> `_initModules`, which installs each
   module through the Safe (`UTIL.installModule` -> `module.onInstall`) so the
   Keel hook, like on every other account, observes `msg.sender ==` the account.
7. The UserOp's `callData` is the plain ERC-7579 `execute(bytes32,bytes)` — no
   `executeUserOp` wrapper — and the validator is selected from the ERC-4337
   nonce (`shr(96, nonce)`), exactly as with MSA and `KeelMinimalAccount`.
