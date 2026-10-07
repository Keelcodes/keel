# Keel examples

Small, runnable programs that use the Keel packages the way an integrator would:
the same public entry points (`@keelcodes/adapters`, `@keelcodes/policy`,
`@keelcodes/settlement`), just imported from the built `dist/` so they run
straight from a checkout.

| Example | Package | Shows |
|---|---|---|
| [`minimal-account/`](minimal-account/index.mjs) | `@keelcodes/adapters` | Encode standard ERC-7579 `installModule` / `uninstallModule` for every supported account, plus Kernel's install-data quirk |
| [`session-policy/`](session-policy/index.mjs) | `@keelcodes/policy` | Issue a scoped session, dry-run a batch before signing, rotate it |
| [`settlement-intent/`](settlement-intent/index.mjs) | `@keelcodes/settlement` | Record an intent, settle it, reconcile the ledger |

Each example is a single `index.mjs` with no build step of its own and no chain
access — an RPC or bundler is only needed for the live probes noted in the code
comments.

## Prerequisites

The examples import the packages' compiled entry points, so build the workspace
once first (Node >= 20):

```bash
pnpm install
pnpm build
```

## Run

From the repo root:

```bash
node examples/minimal-account/index.mjs
node examples/session-policy/index.mjs
node examples/settlement-intent/index.mjs
```

In your own project, drop the `../../packages/*/dist/index.js` path and import
the package name directly, e.g. `import { Ledger } from '@keelcodes/settlement'`.
