# Kernel account fixtures

Compiled artifacts of ZeroDev's [Kernel](https://github.com/zerodevapp/kernel)
ERC-7579 smart account, used by `script/Acceptance.s.sol` to run a **third-party**
account through the same Keel policy as the Rhinestone MSA and `KeelMinimalAccount`.

Kernel v3.x is compiled in its own project and committed here as artifacts rather
than added as a Foundry dependency: its `lib/` (solady, forge-std,
ExcessivelySafeCall) and compiler settings do not co-exist with this project's
`node_modules`-based dependency graph, and it only needs to be built once.

## Provenance

| field | value |
| --- | --- |
| repository | `https://github.com/zerodevapp/kernel` |
| tag | `v3.3` |
| commit | `cd697c7e21715d015e0643af22310a99aa17433b` |
| EntryPoint | **v0.7** (Kernel's `entrypoint` is a constructor arg, not hard-coded) |
| solc | `0.8.27` |
| profile | `deploy` (`via_ir = true`, `optimizer_runs = 1_000_000`, `evm_version = cancun`, `bytecode_hash = none`, `cbor_metadata = false`) |
| submodules | solady `3f2f5345261904463f5429c9031c3d2185c0f4fe`, forge-std `d3db4ef90a72b7d24aa5a2e5c649593eaef7801d`, ExcessivelySafeCall (pinned by the tag) |

via-ir is required: the default profile compiles `Kernel` to a 29,738-byte runtime,
over the EIP-170 limit; the `deploy` profile brings it to **24,469 bytes**.

## Artifacts

Trimmed to `{ abi, bytecode, deployedBytecode }` from `out/`:

| file | contract | runtime size |
| --- | --- | --- |
| `Kernel.json` | `Kernel` implementation (`constructor(IEntryPoint)`) | 24,469 B |
| `KernelFactory.json` | `KernelFactory` (`constructor(address impl)`) | 950 B |
| `ECDSAValidator.json` | `ECDSAValidator` (root validator module) | 1,694 B |

## Regenerating

```bash
git clone --depth 1 --branch v3.3 https://github.com/zerodevapp/kernel /tmp/kernel-src
cd /tmp/kernel-src
git submodule update --init --recursive
FOUNDRY_PROFILE=deploy forge build

node -e '
const fs = require("fs");
const dest = "<repo>/contracts/fixtures/kernel/";
for (const [name, p] of [
  ["Kernel", "out/Kernel.sol/Kernel.json"],
  ["KernelFactory", "out/KernelFactory.sol/KernelFactory.json"],
  ["ECDSAValidator", "out/ECDSAValidator.sol/ECDSAValidator.json"],
]) {
  const a = JSON.parse(fs.readFileSync(p, "utf8"));
  fs.writeFileSync(dest + name + ".json",
    JSON.stringify({ abi: a.abi, bytecode: a.bytecode, deployedBytecode: a.deployedBytecode }, null, 2) + "\n");
}
'
```

## How the acceptance harness uses them

1. `vm.deployCode("fixtures/kernel/Kernel.json", abi.encode(entryPoint))` -> implementation.
2. `vm.deployCode("fixtures/kernel/KernelFactory.json", abi.encode(impl))` -> factory.
3. `vm.deployCode("fixtures/kernel/ECDSAValidator.json")` -> root validator.
4. `factory.createAccount(initData, salt)` with
   `initData = initialize(validatorToIdentifier(ecdsaValidator), keelHook, abi.encodePacked(owner), hookData, [])`
   and `hookData = 0x00 ++ abi.encode(sessionId, policyData)`.
5. The UserOp's `callData` is `executeUserOp.selector ++ execute(mode, executionCalldata)`:
   Kernel only runs its hook through `executeUserOp` (a plain `execute(...)` call
   skips it), and it passes `callData[4:]` -- the standard `execute(bytes32,bytes)`
   calldata -- to `IHook.preCheck`, exactly what `KeelPolicyHook` parses.
