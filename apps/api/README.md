# `@keelcodes/api`

The console's backend, for the two things the browser cannot get from a chain:
the **session index** (which module version a session belongs to, §7.5 of the
plan) and the **settlement ledger**. It is also where the console's own
**telemetry** lands.

It is the reference `SessionStore` the plan calls for (§6.3): no tenant
dimension and no private keys — unlike infraX's multi-tenant store, which stays
private. Zero dependencies, so the runtime is just `node`.

## Run

```bash
pnpm --filter @keelcodes/api start     # http://127.0.0.1:8080
pnpm --filter @keelcodes/api test      # node:test
```

Or as part of the self-host stack — see [`infra/docker-compose.yml`](../../infra/docker-compose.yml),
which brings up `anvil · deployer · bundler · paymaster · api`.

## Endpoints

| method | path | body / query | returns |
|---|---|---|---|
| `GET` | `/health` | — | `{ ok: true }` |
| `GET` | `/sessions` | `?account=` | `{ sessions }` |
| `POST` | `/sessions` | `{ account, sessionId, moduleVersion, … }` | `{ session }` |
| `GET` | `/settlement/ledger` | `?account=` | `{ entries }` (newest first) |
| `POST` | `/settlement/intents` | `{ account, protocol, amount, … }` | `{ entry }` |
| `GET` | `/telemetry` | — | `{ counters }` |
| `POST` | `/telemetry` | `{ kind, by? }` | `{ counters }` |

`protocol` is one of `x402 · mpp · erc8183 · a2a`. `kind` is one of
`conformance.run · settlement.intent · docs.visit`. `settlement.intent` is
**derived from the ledger**, so recording an intent is the only way to move it —
there is no second counter to drift.

## Configuration

| variable | default | meaning |
|---|---|---|
| `KEEL_API_PORT` | `8080` | listen port |
| `KEEL_API_STORE` | — (in memory) | JSON file the store persists to |
| `KEEL_API_TOKEN` | — | when set, `POST`s require the `x-keel-token` header (**reads stay open**) |
| `KEEL_API_ORIGIN` | `*` | value for `access-control-allow-origin` |

Reads are open on purpose: everything the console reads is already public — the
session index mirrors on-chain state, and the ledger carries no private keys.

## Not here

Billing, multi-tenant store and KMS stay in infraX (plan D10 / §6.3). This
service records settlement *intents and their protocol*, not what a platform
charges for them.
