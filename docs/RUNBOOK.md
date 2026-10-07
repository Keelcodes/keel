# Keel rollout & operations runbook

Operational procedures for the on-chain half of Keel — the three fleet
singletons deployed at the same address on **BSC (56)**, **Base (8453)** and
**Ethereum (1)**. Covers the gray release (⑦ of the plan), what to monitor, and
how to roll back.

The contracts are **immutable and address-pinned**: `DeployDeterministic.s.sol`
routes CREATE2 through the canonical proxy, so an address is a function of
`(factory, salt, initCodeHash)` and there is no upgrade proxy anywhere. That
shapes everything below — there is no `pause()`, no admin key, and "rollback"
means *stop using the path*, not *change the contract*.

## 1. The deployment

| contract | address (all three chains) | runtime | role |
|---|---|---:|---|
| `KeelPolicyHook` | `0x466b5DC3796D44b0B63FdF2d3bC7a8Ea371a891F` | 13411 B | On-chain policy enforcement (module type 4) |
| `OwnerECDSAValidator` | `0x26423D1c7EFf7F21a56DD3065081eB700Cd02f50` | 1907 B | Account owner's ERC-7579 validator |
| `KeelBoundedActions` | `0xBc40bD66859554A6ef2fAcDeB42f88DBe3B21eD1` | 8398 B | ERC-8312 bounded-action substrate |

Fixed dependencies:

| what | address | note |
|---|---|---|
| CREATE2 proxy (Arachnid) | `0x4e59b44847b379578588920cA78FbF26c0B4956C` | Pre-deployed on all three |
| EntryPoint v0.7 (canonical) | `0x0000000071727De22E5E9d8BAf0edAc6f37da032` | UserOps land here |
| `KeelBoundedActions.owner` | `0xfd55F17791B26D7311067b7498cDe7954b9b5865` | Constructor arg — part of the address, no setter |

Monitor from these deploy heights (the first block a Keel event can appear in;
recorded from the timestamps in [`contracts/deployments/`](../contracts/deployments)):

| chain | deploy block | ledger |
|---|---:|---|
| BSC (56) | 126011779 | [56.json](../contracts/deployments/56.json) |
| Base (8453) | 52239325 | [8453.json](../contracts/deployments/8453.json) |
| Ethereum (1) | 26131539 | [1.json](../contracts/deployments/1.json) |

## 2. Preflight (per chain, before any account uses the address)

Run all four checks on each chain. Any mismatch means **do not install** — the
address does not hold the code you think it does.

```bash
RPC=<chain rpc>
for a in 0x466b5DC3796D44b0B63FdF2d3bC7a8Ea371a891F \
         0x26423D1c7EFf7F21a56DD3065081eB700Cd02f50 \
         0xBc40bD66859554A6ef2fAcDeB42f88DBe3B21eD1; do
  cast codesize "$a" --rpc-url "$RPC"
done
```

| # | check | expected |
|---|---|---|
| 1 | `cast codesize` | `13411` / `1907` / `8398` (hook / validator / bounded-actions) |
| 2 | explorer source verification | `Pass - Verified` on the chain's explorer |
| 3 | `KeelPolicyHook.isModuleType(4)` | `true` |
| 4 | `KeelBoundedActions.owner()` | `0xfd55F17791B26D7311067b7498cDe7954b9b5865` |

The reproducible form of this whole runbook is the acceptance harness: it deploys
(or reuses) the hook, drives four independent account implementations through the
same policy, asserts against on-chain state, and writes a ledger that the script
refuses to finish unless every step passed. Reuse it rather than hand-rolling a
first run:

```bash
export KEEL_POLICY_HOOK=0x466b5DC3796D44b0B63FdF2d3bC7a8Ea371a891F
export KEEL_OWNER_VALIDATOR=0x26423D1c7EFf7F21a56DD3065081eB700Cd02f50
# … ACCEPTANCE_* scenario overrides — see contracts/README.md "Mainnet runs"
forge script script/Acceptance.s.sol:Acceptance --rpc-url "$RPC" --broadcast
```

## 3. Gray release

Keel has **no testnet: production is the gray surface** (plan D13). The blast
radius is bounded by making the first install small and revocable, and by rolling
one chain at a time. Order is BSC → Base → ETH.

| step | action | gate to continue |
|---|---|---|
| 0 | §2 preflight on the chain | all four checks pass |
| 1 | Install **one** session on **one** account, with tight limits (small `maxPerTx` and `maxDaily`, short `validUntil`) | `isModuleInstalled` + `isInitialized` both true; `policyCommitmentOf` equals the signed commitment; `sessionIdsOf` has exactly the one id |
| 2 | Send **one** real UserOp, small amount, **under** the cap | UserOp succeeds on-chain; transfer lands; `usageOf` shows `calls = 1`, `spent = amount` |
| 3 | Send a second UserOp that **exceeds** the cap | reverts on-chain with `DailyLimitExceeded()` (`0x194bd314`) — or `ExecutionFailed()` (`0xacfdb444`) for Safe7579, which wraps the reason; accrual unchanged |
| 4 | Soak the chain (see §4) | no unexplained reverts, counters monotonic |
| 5 | Widen: more sessions, larger limits, then the next chain | — |

A session that turns out to be wrong is removed with `onUninstall(bytes32
sessionId)` on the hook — see §5 L0 for the path, which differs by account type.

## 4. Monitoring

Two independent channels, both daily.

**a) Adoption dashboard** — [`.github/workflows/metrics.yml`](../.github/workflows/metrics.yml)
reads the chains once a day and commits [`metrics/`](../metrics). Per chain it
reports Keel accounts, UserOps and session installs. Read it for:

- **Monotonicity.** The counters are cumulative since the deploy block, so they
  may only stay flat or grow. A decrease means the incremental cursor in
  [`tools/metrics/snapshot.json`](../metrics/snapshot.json) was reset or a chain
  was re-indexed wrongly — treat as an incident, not a data blip.
- **`TBD` on one chain only.** The scan keeps the previous counters when an RPC
  fails, so `TBD` means "never read"; it never silently becomes `0`. Investigate
  the RPC (`KEEL_RPC_<id>` secret), not the chain.

**b) Per-account double probe** — `isModuleInstalled` **and** `isInitialized`,
via [`packages/adapters/src/module-probe.ts`](../packages/adapters/src/module-probe.ts).
Both must be true. `isModuleInstalled` alone is the silent-AA24 class of failure
(the module is registered but the account does not actually route through it) —
never accept one probe on its own. Run it per account with
[`packages/adapters/scripts/probe.mjs`](../packages/adapters/scripts/probe.mjs)
(`--chain <id> --account <addr>`), which exits non-zero unless `ok` is true.

**Caveat — Kernel v3.3.** Kernel's `isModuleInstalled` view covers validators /
executors / fallbacks only, so for a hook (module type 4) it returns `false`
**by design** even when the hook is installed and enforcing (fork-verified; see
§9 R5). On a Kernel account the account-side `false` is therefore **not** a
missing install: read the pair, treat the **module side** as authoritative
(`isInitialized` true and `policyCommitmentOf(account, sessionId)` equal to the
signed commitment), and never let the account-side view alone fail the gate.
`probe.mjs` prints a NOTE for exactly this `{ installed:false, initialized:true }`
signature instead of silently reading it as a regression.

Event streams to watch, from the deploy block forward:

```bash
# hook: sessions installed / removed
cast logs --from-block <deployBlock> --to-block latest \
  --address 0x466b5DC3796D44b0B63FdF2d3bC7a8Ea371a891F \
  "SessionInstalled(address,bytes32,bytes32,uint256,uint256,uint256,uint256)" --rpc-url "$RPC"

# EntryPoint: one Keel account's UserOps. The sender is an indexed argument, so
# the middle topic slot must be null — pass the filter as raw JSON, which is
# exactly what tools/metrics/collect.mjs does.
cast rpc eth_getLogs "{\"fromBlock\":\"$(cast to-hex <deployBlock>)\",\"toBlock\":\"latest\",\"address\":\"0x0000000071727De22E5E9d8BAf0edAc6f37da032\",\"topics\":[\"0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f\",null,\"0x000000000000000000000000<account>\"]}" --rpc-url "$RPC"
```

Alert-worthy signals:

| signal | looks like | read it as |
|---|---|---|
| `DailyLimitExceeded` (`0xef664d6a`) | expected, occasional | Policy working as designed |
| `DailyLimitExceeded` on calls that are **under** the cap | recurring | Over-blocking — likely a units or window bug; §6 |
| `UserOperationEvent.success = false` with an unexpected reason | any | The policy refused a legitimate action, or a module does not route through the hook |
| Double probe flips to false after having been true | any | The account's hook coverage regressed |
| A chain's counters go `TBD` and stay there | > 1 day | RPC or indexer failure |
| Counters decrease | any | Cursor/index corruption — stop the migration wave |

Note the asymmetry: the hook is **fail-closed**, so a bug of the enforcement
kind blocks actions loudly (a revert) rather than silently permitting them. Alert
first on reverts of calls that should have succeeded.

## 5. Rollback

There is no contract-level rollback: the code is immutable and the address is
fixed. Rollback is a sequence of increasingly blunt operational levels. Choose
the **lowest** level that contains the problem, and remember that revoking a
session (L0) is cheap and reversible while the others are not.

| level | action | scope | reversible | caveat |
|---|---|---|---|---|
| **L0** | Remove a session: `onUninstall(bytes32 sessionId)` on the hook | One session | Yes — reinstall with a fresh id | Accrual for the removed id is left unreachable, so a reinstall starts a fresh epoch |
| **L1** | Uninstall the hook module from the account (`uninstallModule`, module type 4) | One account | Yes | **Restricted — see below.** On an account whose hook gates module management (Rhinestone MSA), this is refused |
| **L2** | Stop routing new sessions to the fleet; deploy a fixed hook under a **new salt** (new address) and point new installs at it | Fleet-wide | No | Existing accounts keep the old hook; old address stays live. This is the only "upgrade" that exists |
| **L3** | Principal migrates the account: move funds/allowances out, or migrate the account itself | One account | No | The ultimate backstop — the principal always controls the account |

**L0 path:** `onUninstall` is a hook callback, so it is reached through the
account's module-management path — the account calls `uninstallModule(type 4,
hook, abi.encode(sessionId))`. Verify with `sessionIdsOf` (id gone) and
`isInitialized` (false when it was the last session).

**L1 caveat (known limitation, plan R5):** once the hook is installed on an
account, the account's module-management calls are themselves routed through
`preCheck`, which only parses `execute(...)` calldata and rejects everything else
— so `uninstallModule` / `installModule` are refused on hook-gated accounts.
Rolling **back** therefore has to be planned per account type:

- **Rhinestone MSA (`uMSA.advanced/withHook.v0.1`)** — the hook is bound at
  bootstrap and cannot be removed afterwards through the standard path. Treat the
  install as permanent for that account; use L0 for per-session problems and L2
  (route-around) for the fleet.
- **ZeroDev Kernel (`kernel.advanced.v0.3.3`)** — does not gate module management
  this way, so L1 is available.
- **`KeelMinimalAccount`** — the validator and hook are constructor-installed, so
  L1 does not apply; use L0 / L3.

Rehearse before you need it: [`fork-drill.mjs`](../packages/adapters/scripts/fork-drill.mjs)
installs at account creation; [`migration-drill.mjs`](../packages/adapters/scripts/migration-drill.mjs)
hot-installs onto an *existing* account and has already shown the MSA
`uninstallModule` refusal. Both run against a fork with no credentials.

## 6. Incident playbook

| symptom | likely cause | first action | then |
|---|---|---|---|
| UserOps revert with `DailyLimitExceeded` although the amount is under the cap | units / day-window / rule-target mismatch | L0: remove the offending session | Fix the policy, reinstall with a fresh id (L0 is reversible) |
| A call the policy should allow has no matching rule (`NoMatchingRule`) | `target` / selector whitelist wrong | L0 on the session | Correct the rule set; the hook refuses rather than widening |
| Double probe false after a working period | hook coverage regressed on that account | Pause widening; inspect `isModuleInstalled` vs `isInitialized` | If the account cannot route through the hook, do **not** treat the policy as enforced on it |
| Hook itself mis-enforces (allows over the cap) | contract bug | **Stop the migration wave**; L2 for new installs | Immutable code — a fix is a new deployment at a new address; plan the account migration (L3) |
| Preflight check 1/2 fails on a chain | wrong or unverified code at the address | Do not install on that chain | Re-deploy per [contracts/README.md](../contracts/README.md); a new salt yields a new address |
| One chain's metrics go `TBD` | RPC failure | Check `KEEL_RPC_<id>` / the public fallback | Counters resume from the stored cursor — no data is lost |
| Reorg near the tip | normal | None | The scan stops 12 blocks short of the head, so no cursor lands on an orphaned log |

## 7. Review cadence

- **Daily** — metrics workflow runs; skim §4a monotonicity and `TBD`.
- **Per migration wave** — §2 preflight on the chain, then the §3 gate table.
- **Before widening limits** — re-run the §4b double probe on every account in
  the wave.
- **After any incident** — record which level (§5) was used, and whether a
  rehearsal (`fork-drill.mjs` / `migration-drill.mjs`) would have caught it.

## 8. Public mirror (`Keelcodes/keel`)

Two repositories carry the same source; they do **not** share history.

| repo | role | visibility | history |
|---|---|---|---|
| `sftgroup/keel` (`origin`) | development, source of truth | private | full |
| `Keelcodes/keel` (`keelcodes`) | published snapshot, the outward-facing repo | public | one squashed commit |

The mirror is **one-way (dev → public)** and **snapshot-only**: each sync
re-creates a single orphan commit whose tree equals `main`'s tree **minus the
internal-only paths** (`docs/internal/`, see below), then force pushes it. That
keeps the public repo free of internal history (plan D4) and of internal-only
documents, while every other path stays byte-identical. Never develop on the
published branch, and never merge it back into `origin`.

### Internal docs (`docs/internal/`)

Planning and grant material that must stay out of the public repo lives in
`docs/internal/`. It is committed to `main` normally — single source of truth,
reviewed like any other doc — and the snapshot step strips it on the way out.

Rules:

- Anything under `docs/internal/` is **assumed confidential**. Do not link to it
  from public docs, and do not copy its contents into a public path.
- The exclusion is **path-based, not content-based**: if a file must be public,
  it must not live under `docs/internal/`.
- Because the published tree is no longer identical to `main`'s, "the trees are
  byte-identical" holds for **every path except `docs/internal/`**.


### Credentials

`git` resolves the two hosts' tokens from per-org stores (see the machine's
`~/.gitconfig`):

```
credential "https://github.com/Keelcodes"  → store --file=~/.git-credentials.keelcodes
credential "https://github.com/sftgroup"   → store --file=~/.git-credentials.sftgroup
```

So `git push origin …` and `git push keelcodes …` each use the right account
with no token in any URL. The `keelcodes` remote is configured token-free:

```bash
git remote add keelcodes https://github.com/Keelcodes/keel.git
```

### Sync

```bash
cd /path/to/keel
git checkout main && git status --short          # must be clean and pushed to origin
git fetch keelcodes                              # establishes the --force-with-lease baseline

# 1. Build the published tree: main's tree with the internal-only paths removed.
#    A temp index keeps this off the working tree, so the step stays re-runnable.
export GIT_INDEX_FILE=$(mktemp)
git read-tree main^{tree}
git rm -r --cached --ignore-unmatch docs/internal
PUBLIC_TREE=$(git write-tree)
unset GIT_INDEX_FILE

# 2. A fresh root commit whose tree is PUBLIC_TREE — no parent, so its history is
#    unrelated to any prior snapshot. `commit-tree` never touches the working
#    tree or `main`, which makes the step re-runnable (an orphan checkout fails
#    once `public-main` already exists).
NEW=$(git commit-tree "$PUBLIC_TREE" -m "Public snapshot $(date -u +%Y-%m-%d)")
git branch -f public-main "$NEW"

# 3. Invariant: the only difference from main is the excluded path
git diff --name-only "$PUBLIC_TREE" "main^{tree}"          # must list only docs/internal/*
git ls-tree -r --name-only "$PUBLIC_TREE" | grep '^docs/internal/'   # must print nothing

# 4. Publish — histories are unrelated, so this is a force push
git push --force-with-lease keelcodes public-main:main

# 5. Verify
git ls-remote keelcodes refs/heads/main          # == git rev-parse public-main
```

### Pre-publish secret gate

The snapshot is public, so re-run the gate before every push (the commit above
is the last chance to catch a leak):

- `git status --short` shows nothing untracked/staged that should be ignored —
  in particular no `.env*` beyond the committed public
  [`apps/console/.env.production`](../apps/console/.env.production).
- No private keys: `git grep -nE '0x[0-9a-fA-F]{64}' public-main` returns only
  the documented anvil test accounts (`infra/alto-config.json`, harnesses) — see
  §5 L3 for why account-owner keys are the only real ones.
- No credentials embedded in URLs or configs:
  `git grep -niE 'ghp_|gho_|x-access-token|Bearer |mnemonic|seed phrase'`.
- `git ls-tree -r --name-only "$PUBLIC_TREE" | grep '^docs/internal/'` prints
  **nothing** — no internal-only document reached the snapshot (§ *Internal docs*).
- The published tree equals `main`'s tree **except for `docs/internal/`**
  (§ step 3 invariant) — not "identical", by design.

If any check fails, fix it on `main` first, then re-create the snapshot; do not
patch the snapshot commit in place.

## 9. Production migration waves (plan §7.5 steps 2–6)

§3 installs a session on an account; this section migrates the **fleet of
existing accounts** onto it. It is operator-driven, changes no contract, and
runs one chain at a time. The only thing that moves is *which module new
sessions are validated by*.

### Prerequisites — all green before wave 1

| # | prerequisite | owner | gate |
|---|---|---|---|
| P1 | relay `aa_sessions.module_version` column + read routing (`routeSession`) | infraX (private `aa-relay`) | new rows carry a version; reads route by it; rows without one are treated as v0 |
| P2 | double probe wired per account (`isModuleInstalled` + `isInitialized`) | Keel (`packages/adapters/src/module-probe.ts`) | both true on the pilot account |
| P3 | §2 preflight on the chain | ops | all four checks pass |
| P4 | reversals rehearsed on a fork (`migration-drill.mjs`, §5) | ops | drill passes with the §9 R5 expectations |

### Steps (plan §7.5 numbering)

| step | action | gate to continue | rollback |
|---|---|---|---|
| **2** | relay adds `module_version`; pre-existing rows are v0 | backfill dry-run: counts match, no row unversioned | revert the routing flag — reads fall back to v0 |
| **3** | new sessions default to the new module; in-flight records keep their old encoding (lazy backfill of old rows) | new session: both probes true; an in-flight v0 UserOp still validates | flip the default back to v0; new writes resume on v0 |
| **4** | revoke / rotate ⇒ migrate: uninstall old encoding + install new + advance nonce, in one batch | post-migration probes true; `invalidateNonce` confirmed on-chain | account stays on v0 until step 3 is widened to it |
| **5** | wave per chain **BSC → Base → ETH**; the first account per chain is a fresh, tightly-capped session (§3) | §3 gate table, then §4 monitors hold for the soak window | §5 by level: L0 (session) → L2 (fleet route-around) → L3 (principal) |
| **6** | retire the old module address; keep a **read-only** probe | no in-flight v0 sessions remain (version scan over `sessionIdsOf`) | re-enable v0 routing — the read path is never removed |

### Wave plan

| wave | chain | accounts | abort if |
|---|---|---|---|
| W1 | BSC (56) | 1 pilot | any §4 alert-worthy signal, or a probe flips false |
| W2 | BSC | small cohort | counters non-monotonic, or an over-cap call is *allowed* |
| W3 | Base (8453) | mirror W1 → W2 | same |
| W4 | Ethereum (1) | mirror W1 → W2 | same |

Abort always means **stop the wave**, never change the contract (§5). A step is
re-entrant: re-running it after a rollback is the normal path, not an exception.

### R5 — uninstall drill by account type (design)

R5's residual: reversal (uninstall) is refused on hook-gated accounts, so the
operator's *expected* outcome differs per account type. The drill pins that
expectation per type instead of assuming it. It extends
[`migration-drill.mjs`](../packages/adapters/scripts/migration-drill.mjs) and
runs on a fork, no credentials.

| account type | expected on `uninstallModule(type 4, hook)` | reversal path |
|---|---|---|
| Rhinestone MSA (`uMSA.advanced/withHook.v0.1`) | **reverts** — the hook gates module management; `preCheck` only parses `execute(...)` calldata, so it reverts `UnsupportedCallData(bytes4)` = `0xaaea51f9` | treat the install as permanent: **L0** per session, **L2** for the fleet |
| ZeroDev Kernel (`kernel.advanced.v0.3.3`) | **succeeds**; its account-side `isModuleInstalled(4, hook)` is `false` **by design** (view covers validator/executor/fallback only) — evidence is the module side (§4b caveat) | **L1** |
| `KeelMinimalAccount` | n/a — validator and hook are constructor-installed, no module manager (reverts, not `UnsupportedCallData`) | **L0** / **L3** |

Assertions to add to the drill (per account type):

1. **before** install — account has no hook; record the baseline of
   `isModuleInstalled` / `isInitialized`.
2. **after** install — MSA: assert `uninstallModule` **reverts**, and pin the
   revert reason (`UnsupportedCallData(bytes4)` = `0xaaea51f9`) so a silent change
   is caught. Kernel: assert it **succeeds** and that the **module-side** probe
   (`isInitialized`, §4b caveat) flips back to false. `KeelMinimalAccount`:
   assert the call **reverts** (no module manager) and is *not* `UnsupportedCallData`.
3. **emit** the observed selector per account type in the drill output, so a
   regression shows up as a diff rather than a surprise in production.

The drill is the rehearsal P4 refers to; W1 is not started until it passes on
the account types the wave actually contains.

### Wave execution checklist

One pass per wave, top to bottom. A step that fails its gate **stops the wave**
(§5) — never continue to the next step, and never change the contract.

| # | action | command | gate |
|---|---|---|---|
| A | preflight the chain (§2) | `RPC=<rpc>` then the three `cast codesize` calls | `13411 / 1907 / 8398`; source `Pass - Verified`; `isModuleType(4)` true; `owner()` matches |
| B | rehearse the reversal on a fork (§9 R5) | `BSC_RPC_URL=<rpc> node packages/adapters/scripts/migration-drill.mjs` | `RESULT: PASS`, including the R5 matrix |
| C | confirm the pilot account's probe | `node packages/adapters/scripts/probe.mjs --chain <id> --account <pilot>` | `ok: true` — or, on a Kernel account, the §4b caveat reading |
| D | install one tightly-capped session (§3 step 1) | acceptance harness / console | both probes true; `policyCommitmentOf` == signed; `sessionIdsOf` has exactly one id |
| E | one under-cap then one over-cap UserOp (§3 steps 2–3) | — | under-cap lands; over-cap reverts `DailyLimitExceeded(uint256,uint256)` (`0xef664d6a`) and accrual is unchanged |
| F | soak, watch §4 | metrics workflow | counters monotonic; no `TBD`; no unexplained reverts |
| G | widen, then the next chain | — | only once the soak window is clean |

Rollback at any step is §5 by level — **L0** (session) → **L2** (fleet
route-around) → **L3** (principal). `probe.mjs` is the per-account half of step C
and §4b: it exits non-zero when `ok` is false, so it can gate a scripted rollout.
