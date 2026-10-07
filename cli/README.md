# @keelcodes/cli

The `keel` command line — the operator-facing side of Keel, built so the checks
you would run by hand are scriptable.

```bash
pnpm --filter @keelcodes/cli build
node cli/dist/bin.js help
```

Installed as a dependency it publishes two equivalent binaries, `keel` and `kc`
(the short alias avoids a collision with the unrelated `teamkeel` CLI):

```bash
keel version
kc version
```

## Commands

### `keel version`

Print the CLI's own name and version, read from `package.json` so it cannot
drift. `--json` for machine-readable output.

### `keel policy check`

Normalise an authored policy, print its canonical commitment hash, and — when a
target is given — dry-run a call against it with the **same** `evaluateCall` the
MCP server and the on-chain hook use.

```bash
keel policy check --policy policy.json
# policy 0x9f…  (rules…)

keel policy check --policy policy.json --target 0xToken… --value 500
# commitment 0x9f…
# call target=0xtoken… value=500 selector=0x
# allow rule=0
```

Exit codes compose with a shell: **0** when the policy normalises (and the call,
if any, is allowed), **1** when a call is denied or the policy is malformed, **2**
on a usage error.

The policy file is the authored `PolicyInput` shape, with wei amounts as decimal
strings because JSON has no bigint:

```json
{
  "validAfter": "0",
  "validUntil": "0",
  "rules": [
    {
      "target": "0x0000000000000000000000000000000000000001",
      "selectors": ["0xa9059cbb"],
      "maxPerTx": "1000000000000000000",
      "maxDaily": "5000000000000000000",
      "maxCalls": 20,
      "tokenLimits": [{ "token": "0x…", "maxPerTx": "0", "maxDaily": "0" }]
    }
  ]
}
```

Use `-` as the path to read the policy from stdin.

### `keel migrate route`

Route a session record to its module generation, using the same
`createModuleRegistry` / `routeSession` the relay uses.

```bash
keel migrate route --registry registry.json --id s-1
# session s-1 (no moduleVersion)
#   → v2 encoding=onchain multiSession=true enforcedLimits=true

keel migrate route --registry registry.json --id s-2 --module-version v1 --json
```

The registry file is either an array of module descriptors or an object with a
`defaultVersion` and a `modules` array:

```json
{
  "defaultVersion": "v2",
  "modules": [
    { "version": "v1", "encoding": "payload", "multiSession": false, "enforcedLimits": false },
    { "version": "v2", "encoding": "onchain", "multiSession": true, "enforcedLimits": true }
  ]
}
```

A session with no `module-version` routes to the default generation — the lazy
half of lazy migration. An unregistered version exits **1** with
`unknown-module-version`.

### `keel conformance list` / `keel conformance run`

`list` prints the bundled suites; `run` executes one against a live chain and
prints a per-assertion report. Exit code **1** when any check fails.

```bash
keel conformance list
# ERC-7579 · ERC-7579 (Modular Smart Accounts) · 6 checks
# ERC-7710 · ERC-7710 (Smart Contract Delegation) · 7 checks
# ERC-7715 · ERC-7715 (Request Permissions from Wallets) · 4 checks
# ERC-8004 · ERC-8004 (Trustless Agents) · 6 checks

keel conformance run --rpc http://localhost:8545 --account 0x… --module 0x… --type 4
keel conformance run --suite erc7710 --rpc http://localhost:8545 --manager 0x…
keel conformance run --suite erc8004 --rpc http://localhost:8545 --identity-registry 0x… --agent-id 1
```

- **erc7579** (default): `--account`, `--module`, `--type` (module type id, default
  `1`).
- **erc7710**: `--manager`.
- **erc8004**: `--identity-registry`, `--agent-id`, optional `--reputation-registry`.
- **erc7715** needs a wallet (EIP-1193) provider, which a CLI cannot construct —
  run it through the SDK.

`--rpc` falls back to `KEEL_RPC_URL`. Add `--json` to emit the raw report.

## Global options

Options may be written `--name value`, `--name=value` or `-n value`; `--` ends
option parsing. `--json` is supported by every command; `--help` (or `keel help`)
prints usage.

## Develop

```bash
pnpm --filter @keelcodes/cli build
pnpm --filter @keelcodes/cli typecheck
pnpm --filter @keelcodes/cli test
```

Commands are written against a small `CliIo` port (`out`, `err`, `readText`,
`readStdin`, `env`), so the whole surface is tested in memory — see
[`src/cli.test.ts`](src/cli.test.ts). The design intent is in the internal Keel
plan ([`docs/internal/KEEL_PLAN.md`](../docs/internal/KEEL_PLAN.md) §4.4 ⑥).
