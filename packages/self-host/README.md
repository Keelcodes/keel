# @keelcodes/self-host

The **reference self-host stack** for Keel: a complete ERC-4337 environment with
no hosted provider in the loop — the OxaChain path, and the local sandbox every
other chain can be developed against.

The deployable artifact is [`infra/docker-compose.yml`](../../infra/docker-compose.yml).
This package is its typed companion — the service model, the endpoint derivation
and the readiness probes — and it has **no runtime dependencies**.

## The stack

| Service | Image | Role | Port |
|---|---|---|---|
| `anvil` | `ghcr.io/foundry-rs/foundry` | local EVM node, chain `31337` | `8545` |
| `contract-deployer` | `ghcr.io/pimlicolabs/mock-contract-deployer` | one-shot: EntryPoint + account factories | — |
| `bundler` | `ghcr.io/pimlicolabs/alto` | ERC-4337 bundler | `4337` |
| `paymaster` | `ghcr.io/pimlicolabs/mock-verifying-paymaster` | ERC-7677 paymaster service | `3000` |

```bash
docker compose -f infra/docker-compose.yml up
```

Then:

```ts
import { localEndpoints, stackRpc, waitForStack, type FetchLike } from '@keelcodes/self-host';

const endpoints = localEndpoints();          // { chainId: 31337, rpcUrl, bundlerUrl, paymasterUrl }
const fetchImpl = fetch as unknown as FetchLike;
const { chain, bundler, paymaster } = stackRpc(endpoints, fetchImpl);

const readiness = await waitForStack({ chain, bundler, chainId: endpoints.chainId });
// { chain: true, bundler: true, ready: true, timedOut: false, elapsedMs: … }
```

Point the rest of Keel at the same endpoints:

```ts
import { createBundlerAdapter, createPaymasterAdapter } from '@keelcodes/adapters';

const bundlerAdapter = createBundlerAdapter('skandha', { url: endpoints.bundlerUrl });
const paymasterAdapter = createPaymasterAdapter('pimlico', { url: endpoints.paymasterUrl });
```

The `kind` is only used for a provider's built-in URL layout; a self-hosted
endpoint always supplies an explicit `url`, so any kind works.

## Why these services

- **anvil** — a deterministic local chain; its dev accounts and mnemonic
  ([`ANVIL_MNEMONIC`](./src/stack.ts)) are public and funded on a local chain only.
- **contract-deployer** — deploys the canonical EntryPoint (v0.6 / v0.7 / v0.8)
  and the Kernel / Nexus / Safe7579 account factories, so a fresh stack is usable
  with no manual deploy step.
- **bundler (Alto)** — Pimlico's open-source bundler, driven by
  [`infra/alto-config.json`](../../infra/alto-config.json).
- **paymaster** — the mock ERC-7677 service forwards every bundler method to the
  bundler, so it doubles as a drop-in bundler URL, exactly how a hosted provider
  exposes one URL for both.

## Model

`SELF_HOST_SERVICES` is the machine-readable mirror of the compose file: the same
names, images, ports and dependencies. `localEndpoints()` derives the three URLs
from a host and port set, and the probes talk to injected `RpcCall` ports so they
run in CI with no chain and no network:

- `checkChain(rpc, chainId)` — `eth_chainId` matches.
- `checkBundler(rpc)` — `eth_supported_entryPoints` is non-empty.
- `waitForStack({ chain, bundler, ... })` — polls until both hold or the timeout
  elapses. A probe that throws counts as "not ready yet", so a booting stack
  never surfaces as an error. The paymaster is not polled: it forwards to the
  bundler, so bundler readiness is the last thing to arrive.

## Images and licensing

This compose file pulls **third-party images**; they are not built or distributed
by Keel. Alto and the two mock services are published by Pimlico (Alto is
GPL-3.0). Pin every image to a digest before running this anywhere but a sandbox,
and swap the mock paymaster for a real verifying paymaster service in production.

## Develop

```bash
pnpm --filter @keelcodes/self-host test
pnpm --filter @keelcodes/self-host typecheck
```
