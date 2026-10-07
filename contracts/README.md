# Keel contracts

On-chain carrier for the Keel policy DSL: **`KeelPolicyHook`**, an account-agnostic
[ERC-7579](https://eips.ethereum.org/EIPS/eip-7579) hook (module type `4`).

The off-chain package [`@keelcodes/policy`](../packages/policy) defines the policy
model, its canonical commitment hash and a pre-check layer. This contract enforces
the **same** rules during execution, so a session key cannot skip the ceilings by
calling the account directly. An account may hold **many concurrent sessions**
(one policy grant each) — the on-chain counterpart of `Session` in
`@keelcodes/policy`.

## Why a hook, not a validator

A validator runs in the ERC-4337 validation phase, where
[ERC-7562](https://eips.ethereum.org/EIPS/eip-7562) forbids touching storage that
is not associated with the sending account. Per-rule daily accounting (nested
mappings keyed by rule and token) cannot satisfy that restriction, so it can only
ever be an off-chain check. A hook runs during **execution**, where reading and
writing its own storage is allowed — per-tx, per-day, per-token and call-count
ceilings are therefore enforced on-chain for real. See [KeelPolicyHook.sol](src/KeelPolicyHook.sol)
for the full rationale.

## Account agnosticism

The account calls `hook.preCheck(...)`, so inside the hook `msg.sender` is the
smart account. Keying storage by `msg.sender` works unchanged for Kernel, Nexus
and Safe7579, and `msgData` is the standard ERC-7579 `execute(bytes32,bytes)` /
`executeFromExecutor(bytes32,bytes)` call — identical across accounts.

This is demonstrated end-to-end by the acceptance harness, which runs the same
policy and UserOps against the Rhinestone MSA, an independent Keel account, the
ZeroDev Kernel and a Rhinestone Safe7579 Safe
(see [On-chain acceptance](#on-chain-acceptance)).

## Install data = `abi.encode(sessionId, encodePolicy(policy))`

`onInstall(data)` decodes a `bytes32 sessionId` followed by exactly the bytes
produced by the TypeScript `encodePolicy(policy)`, i.e.
`abi.encode(version, validAfter, validUntil, rules)`. The package's
`encodeInstallData(sessionId, policy)` builds this payload. The commitment stored
and emitted for a session is `keccak256(policyData)`, which is therefore equal to
`policyCommitment(policy)` off-chain. Both layers are pinned to the same vector by
the test suites:

```
policyCommitment(policy) == keccak256(encodePolicy(policy)) == 0xbd6fc210…c8d5d35c
```

Accrual is keyed by `(account, sessionId)`, so sessions never share counters:
installing the same policy under a new id starts a fresh epoch, while reusing an
id is rejected (`SessionAlreadyInstalled`). `onUninstall(sessionId)` removes just
that session; its accrual is left unreachable.

## Multi-session and union semantics

A hook cannot tell which session a call belongs to — no session identity reaches
`preCheck`. Sessions therefore act as a **union of grants**: a call is admitted if
*any* installed session admits it. Sessions are tried in install order and the
first admitting one is charged; each attempt runs as a self-call that is rolled
back if it reverts, so a rejected attempt leaves no partial accrual behind. When
no session admits the call, the most informative failure is surfaced (a rule that
matched but hit a ceiling, preferred over `NoMatchingRule`).

The union is genuine, not per-session isolation: installing a broad session widens
what the account's other sessions can do too. Isolating sessions from each other
requires enforcing *which* session signed, which is a validator concern and out of
scope for an account-agnostic hook.

## Enforcement (fail-closed)

`preCheck` reverts on anything it cannot validate:

- **Validity window** — per session, `validAfter` / `validUntil` (`0` = unbounded).
- **Framing** — only `execute` / `executeFromExecutor`; `delegatecall`
  (callType `0xff`) and unknown call types revert. Single calls are decoded as
  `abi.encodePacked(target, value, callData)`; batch calls as `Execution[]`.
- **Rule matching** — within the session being tried, the first rule whose
  `target` matches and whose `selectors` whitelist contains the selector (empty
  whitelist = any). No match reverts.
- **Native value** — `maxPerTx`, then `maxDaily` (per day).
- **Call count** — `maxCalls` (lifetime).
- **ERC-20 token limits** — when a limit is declared for the call target:
  `transfer` / `approve` are capped at the token `maxPerTx` / `maxDaily`;
  `transferFrom` is refused; a malformed standard call is refused; any other
  selector is left to the rule's whitelist.

## Layout

```
src/KeelPolicyHook.sol       the hook
src/OwnerECDSAValidator.sol  single-owner ERC-7579 validator used by the acceptance harness
src/KeelMinimalAccount.sol   second ERC-7579 account, used to prove account agnosticism
src/interfaces/IERC7579.sol  minimal ERC-7579 module interfaces (no account deps)
test/KeelPolicyHook.t.sol    43 functional tests, incl. the cross-layer commitment vector
test/redteam/                21 adversarial (red-team) cases, tagged with threat-model ids
script/Deploy.s.sol          deploys the hook (nonce CREATE) and writes a per-chain deployments ledger
script/DeployDeterministic.s.sol  same-address (CREATE2) deployment for real chains
script/Acceptance.s.sol      end-to-end on-chain acceptance (four real accounts + real UserOps)
deployments/                 generated ledgers (deploy + acceptance), committed per run
fixtures/kernel/             pre-built third-party (ZeroDev Kernel) artifacts, see its README
fixtures/safe7579/           pre-built third-party (Rhinestone Safe7579) artifacts, see its README
```

## Build & test

Requires [Foundry](https://book.getfoundry.sh/). The acceptance harness compiles
the Rhinestone **MSA** reference account and the eth-infinitism **EntryPoint**
from `node_modules`, and reads the pre-built **Kernel** and **Safe7579** artifacts
from `fixtures/` (read access granted in `foundry.toml`), so a workspace install
comes first:

```bash
pnpm install        # from the repo root — installs the contracts dependencies
forge fmt --check   # formatting
forge build --sizes # sizes / stack-depth
forge test -vv      # 107 tests (80 functional + 21 red-team + 6 integration)
```

## Deterministic deployments (one address on every chain)

`Deploy.s.sol` uses ordinary `CREATE`, so its address depends on the deployer's
nonce — fine for a throwaway local chain, wrong for a fleet. `DeployDeterministic.s.sol`
routes `CREATE2` through the canonical deterministic deployment proxy at
`0x4e59b44847b379578588920cA78FbF26c0B4956C`, which already lives at that address on
BSC, Base and Ethereum mainnet (verified: 69-byte runtime on each). A CREATE2
address is a function of `(factory, salt, initCodeHash)` alone, so the three fleet
singletons land at the **same address on all three**:

```
BSC  (56)   keelPolicyHook       0x466b5DC3796D44b0B63FdF2d3bC7a8Ea371a891F   13411 bytes
Base (8453) keelPolicyHook       0x466b5DC3796D44b0B63FdF2d3bC7a8Ea371a891F   13411 bytes
ETH  (1)    keelPolicyHook       0x466b5DC3796D44b0B63FdF2d3bC7a8Ea371a891F   13411 bytes

BSC  (56)   ownerECDSAValidator  0x26423D1c7EFf7F21a56DD3065081eB700Cd02f50    1907 bytes
Base (8453) ownerECDSAValidator  0x26423D1c7EFf7F21a56DD3065081eB700Cd02f50    1907 bytes
ETH  (1)    ownerECDSAValidator  0x26423D1c7EFf7F21a56DD3065081eB700Cd02f50    1907 bytes

BSC  (56)   keelBoundedActions   0xBc40bD66859554A6ef2fAcDeB42f88DBe3B21eD1    8398 bytes
Base (8453) keelBoundedActions   0xBc40bD66859554A6ef2fAcDeB42f88DBe3B21eD1    8398 bytes
ETH  (1)    keelBoundedActions   0xBc40bD66859554A6ef2fAcDeB42f88DBe3B21eD1    8398 bytes
```

`KeelMinimalAccount` is deliberately absent from this list: its constructor
installs the validator and the hook on itself, so it is a *per-account*
deployment whose address belongs to the account owner, not a fleet address that
has to match across chains.

`KeelBoundedActions`'s admin is a constructor argument, which puts it in the init
code — and therefore in the address. All three chains were deployed with the same
owner (`0xfd55F17791B26D7311067b7498cDe7954b9b5865`); a different owner on one
chain would move the address on that chain only. `KEEL_BOUNDED_ACTIONS_OWNER` is
required rather than defaulted, because `owner` has no setter.

All three contracts are **source-verified** on all three chains — solc 0.8.24,
optimizer `1_000_000`, `via_ir`, `cancun`; only `KeelBoundedActions` takes
constructor arguments:

| contract | BSC (56) | Base (8453) | ETH (1) |
| --- | --- | --- | --- |
| `KeelPolicyHook` | [bscscan](https://bscscan.com/address/0x466b5dc3796d44b0b63fdf2d3bc7a8ea371a891f#code) | [basescan](https://basescan.org/address/0x466b5dc3796d44b0b63fdf2d3bc7a8ea371a891f#code) | [etherscan](https://etherscan.io/address/0x466b5dc3796d44b0b63fdf2d3bc7a8ea371a891f#code) |
| `OwnerECDSAValidator` | [bscscan](https://bscscan.com/address/0x26423d1c7eff7f21a56dd3065081eb700cd02f50#code) | [basescan](https://basescan.org/address/0x26423d1c7eff7f21a56dd3065081eb700cd02f50#code) | [etherscan](https://etherscan.io/address/0x26423d1c7eff7f21a56dd3065081eb700cd02f50#code) |
| `KeelBoundedActions` | [bscscan](https://bscscan.com/address/0xbc40bd66859554a6ef2facdeb42f88dbe3b21ed1#code) | [basescan](https://basescan.org/address/0xbc40bd66859554a6ef2facdeb42f88dbe3b21ed1#code) | [etherscan](https://etherscan.io/address/0xbc40bd66859554a6ef2facdeb42f88dbe3b21ed1#code) |

```bash
forge verify-contract --chain <1|56|8453> --verifier etherscan --watch \
  --compiler-version 0.8.24 --num-of-optimizations 1000000 --via-ir --evm-version cancun \
  [--constructor-args $(cast abi-encode "f(address)" $KEEL_BOUNDED_ACTIONS_OWNER)] \
  <address> src/<Contract>.sol:<Contract>
```

```bash
export KEEL_BOUNDED_ACTIONS_OWNER=0x...   # required, see above
forge script script/DeployDeterministic.s.sol:DeployDeterministic \
  --rpc-url $RPC --broadcast
```

`PRIVATE_KEY` selects the signer (defaults to anvil account #0 — forks only),
`CREATE2_FACTORY` overrides the proxy, and each contract has its own salt
override (`DEPLOY_SALT`, `DEPLOY_SALT_VALIDATOR`, `DEPLOY_SALT_BOUNDED_ACTIONS`);
rerunning against a chain that already holds a deployment skips just that one.
The ledger (`deployments/<chainId>.json`) records `address`, `salt` and
`initCodeHash` per contract, so cross-chain parity is auditable rather than
asserted.

Two toolchain notes: the broadcasted code cannot be re-read inside the script
(state written in a broadcast block is invisible to the simulating pass), so
presence is confirmed afterwards with `cast codesize <address> --rpc-url <rpc>`;
and the factory's returned address is deliberately not `abi.decode`d, because
that reverts under this `via_ir` setup — the CREATE2 address is `expected` by
construction anyway.

## On-chain acceptance

`script/Acceptance.s.sol` proves on a **real chain** that the policy is enforced
in execution, not just in unit tests. Against a live RPC it deploys (or reuses)
the canonical ERC-4337 EntryPoint and the hook, then drives **four accounts from
four independent codebases** through the **same** policy and the **same** two real
UserOps:

| account | implementation | install path | validator selection |
| --- | --- | --- | --- |
| A | Rhinestone MSA `uMSA.advanced/withHook.v0.1` | proxy + `Bootstrap` | from the ERC-4337 nonce |
| B | `KeelMinimalAccount` `keel.minimal.v0.1` | constructor | stored immutable |
| C | ZeroDev Kernel `kernel.advanced.v0.3.3` | ERC-1967 clone + `KernelFactory` | `rootValidator` (bytes21) |
| D | Rhinestone Safe7579 `rhinestone.safe7579.v1.0.0` | existing Safe + `Safe7579Launchpad.addSafe7579` | from the ERC-4337 nonce |

A and B are compiled from this repo / `node_modules`. **C and D are third-party
accounts shipped as pre-built artifacts** under `fixtures/kernel/` (Kernel v3.3,
solc 0.8.27, `via_ir`) and `fixtures/safe7579/` (Safe7579 v2.0.0, solc 0.8.29)
respectively, deployed with `vm.deployCode` — see their READMEs for provenance
and regeneration. Kernel's EntryPoint is a constructor argument (not hard-coded),
so it reuses the same v0.7 instance, and it runs its hook only through
`executeUserOp`, so its UserOp `callData` is wrapped in `executeUserOp.selector`.
Safe7579 hard-codes the same canonical v0.7 EntryPoint, is installed as a plain
Safe's fallback handler + module, and is driven through the standard
`execute(bytes32,bytes)`.

The policy is one rule (`maxDaily = 1 ether`) installed under the **same
session id** on all four, and each account runs:

1. transfer **0.4 ether** — must **succeed** and accrue (`calls = 1`, `spent = 0.4`);
2. transfer **0.7 ether** — must **fail on-chain** with the policy's
   `DailyLimitExceeded` (0.4 + 0.7 > 1.0), leaving the accrual **unchanged** (no
   partial accounting). Safe7579 surfaces that revert wrapped as its own
   `ExecutionFailed()` (it invokes the hook through
   `Safe.execTransactionFromModuleReturnData` and discards the inner reason), so
   the harness accepts either selector — for the Safe account only — while every
   substantive assertion stays identical.

Identical enforcement on four unrelated account implementations — with independent
per-account accrual under a shared session id — is the account-agnosticism proof.
It asserts against on-chain state (`usageOf`, `policyCommitmentOf`,
`sessionIdsOf`, `accountId`, balances) and writes the result to
`deployments/acceptance-<chainId>.json`; the script reverts unless every step
passed.

```bash
# fresh local chain (the default signer is anvil account #0)
anvil --port 8545 --silent &
forge script script/Deploy.s.sol:Deploy \
  --rpc-url http://127.0.0.1:8545 --broadcast --non-interactive
forge script script/Acceptance.s.sol:Acceptance \
  --rpc-url http://127.0.0.1:8545 --broadcast --non-interactive
```

Any RPC works — on a real network the canonical EntryPoint already exists, so no
local code injection is needed. The account is controlled by `PRIVATE_KEY` when
set, otherwise anvil's first dev key.

### Mainnet runs

The defaults above are tuned for a fork: the signer is a pre-funded anvil account
and gas is free. On a public chain the signer's balance is real money, and —
more binding than the transfer values — the EntryPoint makes each account
pre-fund `(verificationGasLimit + callGasLimit + preVerificationGas) *
maxFeePerGas` **per UserOp**. Both UserOps run on the same account, so
`ACCEPTANCE_FUNDING` must cover at least
`valueOp1 + (verificationGasLimit + callGasLimit + preVerificationGas) *
maxFeePerGas`. Every scenario value is overridable; the defaults reproduce
`acceptance-31337.json` exactly.

| env | meaning | fork default |
| --- | --- | --- |
| `ACCEPTANCE_RECIPIENT` | policy target and transfer destination | `0x…bEEF` |
| `ACCEPTANCE_VALUE_OP1` / `_VALUE_OP2` / `_DAILY_CAP` | the two transfers and the cap | 0.4 / 0.7 / 1 ether |
| `ACCEPTANCE_FUNDING` | ether sent to each account | 3 ether |
| `ACCEPTANCE_MAX_FEE_PER_GAS` / `_MAX_PRIORITY_FEE_PER_GAS` | gas fees carried in the UserOps | 20 / 1 gwei |
| `ACCEPTANCE_VERIFICATION_GAS_LIMIT` / `_CALL_GAS_LIMIT` / `_PRE_VERIFICATION_GAS` | per-UserOp gas limits | 1e6 / 1e6 / 2e5 |

Point `KEEL_POLICY_HOOK` / `KEEL_OWNER_VALIDATOR` at the deterministic fleet
deployments (see "Deterministic deployments" above) so a mainnet run reuses the
shared hook and validator instead of minting a second of each at a different
address.

The four-account scenario has been run to completion on all three mainnets
(2026-10), each with a scaled-down scenario and the shared hook/validator:

| chain | ledger | result |
| --- | --- | --- |
| BSC (56) | `deployments/acceptance-56.json` | PASS |
| Base (8453) | `deployments/acceptance-8453.json` | PASS |
| ETH (1) | `deployments/acceptance-1.json` | PASS |

See the top of `script/Acceptance.s.sol` for the full parameter list.
