# Metrics dashboard

Collects the public metrics Keel reports to grant programs and regenerates the
committed dashboard. This exists because §9.5 of the plan asks for a metrics
board and §6 of the grants material asks for one where **every number is
traceable** — so the collector refuses to guess.

- Output: [`../metrics/README.md`](../metrics/README.md) (dashboard page),
  [`../metrics/snapshot.json`](../metrics/snapshot.json) (raw data) and
  [`../metrics/badges/`](../metrics/badges) (self-emitted SVG badges).
- Schedule: [`.github/workflows/metrics.yml`](../../.github/workflows/metrics.yml),
  daily at 03:17 UTC, plus manual dispatch.

## Zero dependencies

The collector uses only Node built-ins (`fetch`, `fs`, `path`) and the SVG
badges are emitted by hand, so the dashboard adds no hosted dependency and no
package to audit. CI already runs the unit tests:

```bash
node --test "tools/metrics/*.test.mjs"
```

## Running it

```bash
node tools/metrics/collect.mjs
```

| Env var | Default | Purpose |
|---|---|---|
| `KEEL_GITHUB_REPO` | `Keelcodes/keel` | Repository to read (`owner/name`). CI sets it from `github.repository`. |
| `GITHUB_TOKEN` | — | Raises the GitHub rate limit and lets a private repo be read. CI uses `secrets.GITHUB_TOKEN`. |
| `KEEL_METRICS_OUT` | `metrics` | Output directory, relative to the repo root. |
| `KEEL_RPC_1` / `KEEL_RPC_56` / `KEEL_RPC_8453` | public RPCs | Per-chain endpoint for the on-chain scan. |
| `KEEL_TELEMETRY_URL` | — | Base URL of a running [`@keelcodes/api`](../../apps/api); its `/telemetry` counters drive settlement intents + conformance runs. Unset → those rows are `TBD`. |
| `KEEL_DOCS_STATS_URL` | — | Endpoint returning `{"visits": <number>}`. Unset → docs visits is `TBD`. |

Integrating projects is read from the committed
[`metrics/adopters.json`](../metrics/adopters.json), maintained by hand — no
network or secret. An empty list is an honest `0`; a missing file reads as `TBD`.

## What it measures

From the GitHub REST API: stars, forks, watchers, contributors (via the `Link`
header), merged pull requests and open issues (via `/search/issues`). From the
npm registry: weekly downloads per published `@keelcodes/*` package, discovered
from the workspace manifests. From the three chains: Keel accounts, UserOps and
session installs, scanned incrementally since each deployment.

**Telemetry-backed:** settlement intents and conformance runs come from a
[`@keelcodes/api`](../../apps/api) instance's `/telemetry` counters; docs visits
come from the configured analytics endpoint; integrating projects come from
`metrics/adopters.json`. Each is shown as `TBD` — never `0` — when its source is
unreachable or unset.

## Two safety rules

1. **Never fabricate.** A down source or an unpublished package yields `TBD`.
2. **Never clobber.** If the GitHub repository read fails and a snapshot already
   exists, the run exits non-zero and leaves the previous snapshot untouched. If
   no snapshot exists yet (bootstrap), it writes an all-`TBD` dashboard so the
   carrier exists from day one.
