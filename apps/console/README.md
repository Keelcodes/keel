# @keelcodes/console

The multi-chain **Keel** site — React + Vite + wagmi, targeting Base, BSC and
Ethereum (the three chains the funding and deployment plan names).

One bundle serves two roles: the landing page at `/` and the working console at
`/console`. Both share the wallet picker, so "Connect wallet" behaves the same
wherever it is clicked.

## Run

```bash
pnpm --filter @keelcodes/console dev      # http://localhost:5173
pnpm --filter @keelcodes/console build    # typecheck + production bundle
pnpm --filter @keelcodes/console test     # unit tests (pure helpers)
```

Copy `.env.example` to `.env` to override anything; every value is optional and
a fresh clone runs with no configuration.

`vite build` additionally reads the committed [`.env.production`](./.env.production),
which carries the public WalletConnect (Reown) project id used on
`console.keel.codes` — it is a client-side identifier that ships in the bundle
anyway, so committing it keeps the production build reproducible.

## What works today

- **Landing page** (`/`) — hero, capability bento, architecture, deployments and
  footer. Every address shown is the real deployed one.
- **Console** (`/console`) — wallet card plus sessions, conformance and
  settlement panels.
- **Wallet** — browser-extension wallets are discovered through EIP-6963, so the
  picker lists them by real name and icon (MetaMask, OKX, Rabby, Coinbase…).
  WalletConnect is registered **only** when `VITE_WC_PROJECT_ID` is set; blank,
  the QR / mobile fallback is absent entirely rather than half-configured.
- **Sessions** — read live off `KeelPolicyHook` (see [Wiring](#wiring)); status
  is derived from the validity window at read time.
- **Chain set** — Base, Ethereum and BSC, with explorer links and short-address
  formatting ([`src/chains.ts`](./src/chains.ts), unit-tested).

## Wiring

| Panel | Source | Call |
|---|---|---|
| Sessions | `KeelPolicyHook` (on-chain) | `sessionIdsOf` → `policyOf` / `policyCommitmentOf` |
| Conformance | `@keelcodes/conformance` | `runSuite(ERC7579_SUITE)` + `formatReport` |
| Settlement | `@keelcodes/api` (self-hosted) | `GET /settlement/ledger` |

Conformance is live: the account is the connected wallet and the module defaults
to the deployed `KeelPolicyHook` with module type `4` (hook); set
`VITE_CONFORMANCE_MODULE` / `VITE_CONFORMANCE_MODULE_TYPE` to point elsewhere —
see [`.env.example`](./.env.example).

Session rows come straight off the hook via [`src/hook.ts`](./src/hook.ts): the
hook is deployed at the same CREATE2 address on all three chains, so there is no
backend to fetch from. The commitment shown is `keccak256(policyData)`, the same
bytes `@keelcodes/policy` signs off-chain.

**Settlement comes from the self-hosted backend.** Set `VITE_API_URL` to an
[`@keelcodes/api`](../../apps/api) instance and the panel reads that account's
ledger (`GET /settlement/ledger`); leave it unset and the panel reports that no
settlement service is running rather than rendering sample rows.

Because the packages expose types only from `dist`, the console's typecheck must
run after their build (CI builds before typechecking for exactly this reason).

## Structure

```
src/
├── chains.ts              pure chain + address helpers (tested)
├── hook.ts                KeelPolicyHook read ABI + session reader
├── router.ts              `/` and `/console` routing (no dependency)
├── wagmi.ts               wagmi config: BSC / Base / Ethereum + discovered wallets
├── data.ts                conformance adapter over @keelcodes/conformance
├── wallet.ts              connector → display descriptor (name, icon, kind)
├── App.tsx                layout: header, route, footer, wallet modal
├── main.tsx               providers: WagmiProvider + QueryClientProvider
├── pages/
│   ├── LandingPage.tsx
│   └── ConsolePage.tsx
├── components/
│   ├── SiteHeader.tsx
│   ├── SiteFooter.tsx
│   ├── ConnectWalletModal.tsx
│   ├── WalletPanel.tsx
│   ├── SessionsPanel.tsx
│   ├── SettlementPanel.tsx
│   ├── ConformancePanel.tsx
│   └── icons.tsx
└── styles.css
```
