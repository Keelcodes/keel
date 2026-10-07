# Keel

**Open infrastructure for onchain agent accounts, authorization and payments.**

Keel is a composable, self-hostable toolkit that lets any team give AI agents a
wallet — with policy-bounded permissions and multi-rail settlement — without
locking into a hosted provider.

- Website: https://keel.codes
- License: Apache-2.0
- Status: **early development** (pre-alpha)

## Why Keel

The ecosystem already has excellent account modules (ERC-7579), delegation
primitives (ERC-7710 / ERC-7715) and payment protocols (x402 / MPP). What is
missing is a **self-hostable, chain-agnostic layer that composes them** and adds
the hard parts:

- **Policy engine** — declarative spend policies with **on-chain enforced**
  limits, multi-session support, and pre-signature simulation.
- **Settlement** — orchestrate x402 / MPP / fiat / stablecoin rails, agent-to-agent
  settlement, reconciliation and receipts.
- **Conformance & security suite** — cross-ecosystem conformance tests and a
  threat model for agent authorization.
- **Bounded agent actions** — an on-chain ERC-8312 substrate
  (`KeelBoundedActions`) plus a TypeScript envelope model for budgets, aggregate
  conservation and the contest/revocation lifecycle, wired into the policy hook.
- **Protocol interaction manifests** — an ERC-8313 PIM consumer for validating,
  trust-rating and emitting manifests.
- **Migration tooling** — safely move between session validators without
  migrating accounts.

Keel does **not** reinvent account modules, bundlers or paymasters. It adapts
them behind a single interface.

## Architecture

```
Thick depth layer (original)   policy engine · bounded actions · settlement · conformance suite · PIM consumer
─────────────────────────────────────────────────────────────────────────────
On-chain substrate (Keel)      KeelPolicyHook · KeelBoundedActions (ERC-8312)
─────────────────────────────────────────────────────────────────────────────
Thin adapter layer (reuse)     Kernel/Nexus/Safe7579 · ERC-7710/7715 · x402 · MPP · ERC-8004 · ERC-8183
─────────────────────────────────────────────────────────────────────────────
Standards & protocols          ERC-4337 · 7579 · 7710 · 7715 · 8004 · 8312 · 8313 · x402 · MPP
─────────────────────────────────────────────────────────────────────────────
Chain infrastructure (sourced) Rundler/Skandha/Pimlico · Pimlico/CDP/MegaFuel
```

## Repository layout

```
packages/
  adapters/      @keelcodes/adapters      account / bundler / paymaster adapters
  policy/        @keelcodes/policy        depth A — authorization policy engine
  settlement/    @keelcodes/settlement    depth B — settlement & reconciliation
  conformance/   @keelcodes/conformance   depth D — conformance & security suite
  manifest/      @keelcodes/manifest      ERC-8313 PIM consumer (validate / trust / emit)
  migrate/       @keelcodes/migrate       migration tooling (dual-module routing)
  mcp/           @keelcodes/mcp           policy-aware MCP server
  self-host/     @keelcodes/self-host     self-hosted reference stack
apps/console/    @keelcodes/console       React + Vite + wagmi console
cli/             @keelcodes/cli           command line interface
contracts/       @keelcodes/contracts     KeelPolicyHook · KeelBoundedActions (ERC-8312) · on-chain acceptance
```

## Development

Requires Node.js >= 20 and pnpm >= 9.

```bash
pnpm install
pnpm build       # build first — packages resolve each other through `dist`
pnpm typecheck
pnpm test
```

Packages that depend on a sibling (`@keelcodes/mcp`, `@keelcodes/cli`) resolve
its types from `dist`, so `pnpm build` must run before `pnpm typecheck` on a
clean checkout.

## Docs

- [Conformance](./docs/CONFORMANCE.md) — what the suite covers and how to run it
- [Threat model](./docs/THREAT_MODEL.md) — assets, adversaries and the threat catalogue
- [Bounded actions](./docs/BOUNDED_ACTIONS.md) — the ERC-8312 substrate, encoding and honest boundaries
- [Metrics](./metrics/README.md) — the public metrics dashboard (auto-generated)

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## Security

See [SECURITY.md](./SECURITY.md). Please do not open public issues for
vulnerabilities.

## Trademarks

See [TRADEMARK.md](./TRADEMARK.md).

## License

Apache License 2.0 — see [LICENSE](./LICENSE).
