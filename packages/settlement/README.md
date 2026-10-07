# @keelcodes/settlement

Settlement core for agent payments: the protocol layer that turns an HTTP 402
handshake into a **receipt**, and a ledger that reconciles receipts against what
was intended.

Two protocols, one shape — *challenge → credential → receipt*:

| Protocol | Wire format | Status |
|---|---|---|
| **x402 v2** | `PAYMENT-REQUIRED` / `PAYMENT-SIGNATURE` / `PAYMENT-RESPONSE` headers | ✅ codec, selection, verification, receipts |
| **MPP** (IETF `draft-httpauth-payment`) | `WWW-Authenticate: Payment …` / `Authorization: Payment …` / `Payment-Receipt` | ✅ challenge, credential, status semantics |
| **A2A x402 extension v0.1** | `x402.payment.*` message metadata | ✅ status machine, data structures, receipts |
| **ERC-8183** (Agentic Commerce) | job lifecycle + escrow | ✅ state machine, role guards, dispute/arbitration, escrow receipt |
| **Rail routing** (fiat / stablecoin) | rail catalogue + intent | ✅ deterministic `selectRail`, decimal helpers, fiat checkout handles |

The reconciliation ledger (intents, receipts, entries, derived balances and an
`ok`/`unsettled`/`orphans`/`doubleSettled` report) is ✅ today.

**Zero runtime dependencies.** Base64 and UTF-8 are hand-rolled against plain
ES2022, so the package runs in Node, browsers and edge workers alike with no
`Buffer`, no polyfills and no Keel-internal coupling.

> **Boundary: settlement ≠ billing.** This package orchestrates open payment
> protocols and keeps an audit ledger. It does *not* price anything, hold
> platform keys, or move a balance on a settled payment — whether a payment
> debits a balance is a billing concern and lives outside Keel (see the
> consumer repo's plan, §6.3).

## x402

```ts
import {
  X402_HEADERS,
  parsePaymentRequired,
  selectRequirement,
  verifyRequirement,
  intentFromRequirement,
  receiptFromX402,
} from '@keelcodes/settlement';

// 1. You asked for a resource and got a 402 back.
const required = parsePaymentRequired(response.headers[X402_HEADERS.required]);

// 2. Pick the cheapest offer you can actually pay.
const accepted = selectRequirement(required.accepts, {
  scheme: 'exact',
  network: 'eip155:84532',
  maxAmount: 10_000n, // 0.01 USDC at 6 decimals
});

// 3. Anchor the intent, then make the server prove the terms match it.
const intent = intentFromRequirement(accepted, { id: 'intent-1', payer: account, now: new Date() });
verifyRequirement(accepted, intent); // throws if payTo/asset/amount/network drifted

// 4. Sign a scheme-specific payload (your scheme module builds this) and retry
//    with X402_HEADERS.signature. On success you get X402_HEADERS.response:
const receipt = receiptFromX402({
  intent,
  requirement: accepted,
  response: parseSettlementResponse(retry.headers[X402_HEADERS.response]),
  settledAt: new Date().toISOString(),
});
```

`verifyRequirement` is the point of the whole flow: a server may ask for any
`payTo` it likes, and the intent is the only thing that catches it.

## MPP

```ts
import {
  parseWwwAuthenticate,
  decodeMppRequest,
  mppIntent,
  classifyMppResponse,
  formatCredential,
} from '@keelcodes/settlement';

const challenge = parseWwwAuthenticate(res.headers['www-authenticate']);
const terms = decodeMppRequest<MyMethodRequest>(challenge); // your method spec

const intent = mppIntent(challenge, {
  payer: account,
  payee: terms.payee,
  network: terms.network,
  asset: terms.asset,
  amount: BigInt(terms.amount),
});

// Fulfil the challenge, then retry with the credential:
const retry = await fetch(url, { headers: { authorization: formatCredential(token) } });

switch (classifyMppResponse(retry.status)) {
  case 'granted': /* read Payment-Receipt */ break;
  case 'challenge': /* 402: fresh challenge or a problem code */ break;
  case 'policy-denied': /* 403: payment was accepted — do NOT pay again */ break;
  case 'other': /* 401 etc. is not a payment problem */ break;
}
```

The 402/403 distinction is deliberate: 403 means the payment *succeeded* and
policy denied access, so retrying with payment spends money for nothing.

## A2A (agent-to-agent)

A2A carries payment state in `Message.metadata` under `x402.payment.*` keys and
runs a six-state machine (`payment-required → payment-submitted →
payment-verified → payment-completed | payment-failed`, plus `payment-rejected`).

```ts
import {
  A2A_METADATA_KEYS,
  parsePaymentMetadata,
  assertA2ATransition,
  a2aIntent,
  verifyA2ARequirement,
  receiptFromA2A,
} from '@keelcodes/settlement';

// Merchant task metadata -> typed payment state.
const payment = parsePaymentMetadata(task.status.message.metadata);
assertA2ATransition('payment-required', 'payment-submitted');

const accepted = payment.required!.accepts[0]!;
const intent = a2aIntent(accepted, { id: 'intent-1', payer: account, now: new Date() });
verifyA2ARequirement(accepted, intent); // merchant may ask for any payTo

const receipt = receiptFromA2A({
  intent,
  requirement: accepted,
  response: { success: true, network: accepted.network, transaction: '0xtx' },
  settledAt: new Date().toISOString(),
});
```

`X-A2A-Extensions: https://github.com/google-a2a/a2a-x402/v0.1` declares support.
Keel requires a CAIP-2 `network` even though the v0.1 examples spell it as a bare
name (`"base"`). The scheme-specific `PaymentPayload.payload` stays opaque.

## ERC-8183 (escrow)

Agentic Commerce: a client escrows a budget, a provider submits work, and a
single evaluator attests it. `applyJobAction` is a pure reducer that enforces
both the transition table and *who* may trigger each action.

```ts
import { applyJobAction, escrowOutcome, receiptFromEscrow } from '@keelcodes/settlement';

let job = { id, client, provider, evaluator, description, budget: 0n, expiredAt, status: 'Open' };
job = applyJobAction(job, 'setBudget', { actor: client, amount: 5_000_000n });
job = applyJobAction(job, 'fund', { actor: client, expectedBudget: 5_000_000n }); // -> Funded
job = applyJobAction(job, 'submit', { actor: provider, deliverable: '0x…' });      // -> Submitted
job = applyJobAction(job, 'complete', { actor: evaluator, reason: '0x…' });        // -> Completed

escrowOutcome(job.status); // 'release' | 'refund' | 'none'
const receipt = receiptFromEscrow(job, { network, asset, settledAt });
```

`reject` moves between roles — the client while `Open`, the evaluator once
`Funded`/`Submitted` — and `claimRefund` is permissionless after `expiredAt`.

### Disputes and arbitration

A funded (or submitted) job can be disputed by any party and is then frozen
until an arbiter resolves it. The detour composes with the same reducer:

```
Funded | Submitted --raiseDispute--> Disputed --resolveDispute--> Completed (release)
                                                             \--> Rejected  (refund)
```

```ts
import { applyJobAction, isArbiterSet, escrowOutcome } from '@keelcodes/settlement';

// arbiter is configured on the job up front.
const disputed = applyJobAction(job, 'raiseDispute', { actor: provider, reason: '0x…' });
// -> status 'Disputed', disputeReason recorded

const resolved = applyJobAction(disputed, 'resolveDispute', {
  actor: arbiter,
  outcome: 'release', // or 'refund'
  reason: '0x…',
});
// release -> status 'Completed'; refund -> status 'Rejected'
escrowOutcome(resolved.status); // 'release' | 'refund'
```

- `raiseDispute` is allowed for `client`, `provider` or `evaluator`, requires an
  arbiter to be configured and a non-empty reason.
- `resolveDispute` is allowed **only** for the `arbiter`; `outcome` must be
  `release` (escrow to the provider) or `refund` (escrow to the client).
- A `Disputed` job has no path to `complete`, `reject`, `claimRefund` or a second
  `raiseDispute` — arbitration cannot be bypassed.
- `receiptFromEscrow` attests a dispute resolved to `release`, recording
  `proof.resolution` and `proof.disputeReason`; a resolution to `refund` yields
  no release receipt (the client is made whole instead).

## Rail selection (fiat / stablecoin)

x402 and MPP fix *how* a payment travels; a **rail** fixes *where* it can travel.
`selectRail` filters a catalogue of `PaymentRail` descriptors against a
`PaymentIntent` and a set of constraints, then picks one deterministically.

```ts
import { selectRail, resolveRailAsset, parseUnits, formatUnits } from '@keelcodes/settlement';

const plan = selectRail(rails, intent, {
  kinds: ['chain', 'fiat'],          // optional allowlists
  networks: ['eip155:8453', 'iso4217:USD'],
  assets: ['USDC', 'usd'],
  maxAmount: parseUnits('5', 6),     // cap on amount + cost
});

plan.amountDecimal; // amount rendered against the asset's decimals
plan.total;         // amount + rail cost
plan.checkoutHandle; // opaque, present only for fiat rails
```

- Rail kinds: `x402`, `mpp`, `chain` (direct on-chain stablecoin transfer) and
  `fiat` (hosted checkout). Each rail carries its networks (CAIP-2), accepted
  assets (`address`, `symbol`, `decimals`), an opaque `payTo`, a `cost` and a
  `priority` hint.
- Selection order is **deterministic**: cheapest `cost`, then lowest `priority`,
  then a fixed kind order (`RAIL_KIND_ORDER`), then rail `id`.
- Constraints (`kinds`, `networks`, `assets`, `maxAmount`) must all be
  satisfiable; otherwise `selectRail` throws
  `SettlementError('no-acceptable-requirement')` rather than silently routing.
- `parseUnits` / `formatUnits` are hand-rolled bigint helpers. They round-trip
  exactly and reject more precision than the asset supports — unlike viem's
  `parseUnits`, which rounds. `rails.units.viem.test.ts` is a differential test
  pinning both the agreement on the accepted domain and that divergence.
  `resolveRailAsset` proves an asset is accepted on the requested network.

> **Fiat is host-side.** A `fiat` rail only carries an opaque `checkout` handle
> that `selectRail` copies into `plan.checkoutHandle` verbatim. Keel does not
> integrate a payment service provider, create checkout sessions, or inspect the
> handle — the hosted-checkout specifics live entirely in the host.

## What is deliberately opaque

Both protocols delegate the payment-method specifics to separate specs, and this
package does not guess at them:

- **x402** — the `PAYMENT-SIGNATURE` payload (EIP-3009 authorization, permit, …)
  is built by your scheme module and carried verbatim.
- **MPP** — the challenge's `request` blob is method-specific; decode it with
  your method spec via `decodeMppRequest`.

What Keel fixes is the part the core specs actually define: headers, the
requirements object, selection, the intent match, and the receipt.

## Reconciliation

```ts
import { Ledger } from '@keelcodes/settlement';

const ledger = new Ledger();
ledger.append({ kind: 'intent', at: t0, intent });
ledger.append({ kind: 'receipt', at: t1, receipt });

ledger.statusOf(intent.id); // 'pending' | 'settled' | 'failed'
ledger.balanceOf(account, { network, asset }); // signed sum of `entry` movements
ledger.reconcile(); // { unsettled, orphans, doubleSettled, ok }
```

The ledger is append-only and nothing is stored mutably — status and balances are
folded from the log, so it can be replayed or shipped anywhere. Receipt ids are
deduplicated on append: a replayed settlement raises `duplicate-receipt` rather
than counting twice.

## Webhooks

Every rail folds into the same ledger event log, so outbound notifications need
one normalised shape. `WebhookDispatcher` matches events to subscriptions and
delivers them with retries and a per-delivery audit trail.

```ts
import { WebhookDispatcher, webhookEventFromLedgerEvent } from '@keelcodes/settlement';

const dispatcher = new WebhookDispatcher({
  transport: async ({ url, body, headers }) => {
    const res = await fetch(url, { method: 'POST', body, headers });
    return { status: res.status };
  },
  signer: ({ secret, timestamp, body }) => hmacSha256Hex(secret, `${timestamp}.${body}`),
});

for (const event of ledger.events) {
  await dispatcher.dispatch(subscriptions, webhookEventFromLedgerEvent(event));
}
```

Event types: `intent.created`, `settlement.succeeded`, `settlement.failed`,
`ledger.entry`. A subscription may filter by event type and by rail
(`protocols`), and a delivery is retried on a non-2xx or thrown request (default
3 tries, exponential backoff). Signing is a **port** — the core carries no crypto
dependency, so the host wires its own HMAC; a delivery is signed only when the
subscription has a `secret` and a signer is configured.

## Develop

```bash
pnpm --filter @keelcodes/settlement test
pnpm --filter @keelcodes/settlement typecheck
```

## Sources

- x402 v2: <https://docs.x402.org/core-concepts/http-402> and the
  [x402 specification v2](https://github.com/coinbase/x402/blob/main/specs/x402-specification-v2.md)
- MPP: IETF [`draft-httpauth-payment-00`](https://www.ietf.org/archive/id/draft-httpauth-payment-00.html)
  ("The *Payment* HTTP Authentication Scheme", Tempo Labs / Stripe)
- A2A x402 payments extension v0.1:
  [a2a-x402](https://github.com/google-agentic-commerce/a2a-x402)
- ERC-8183 Agentic Commerce: [eips.ethereum.org/EIPS/eip-8183](https://eips.ethereum.org/EIPS/eip-8183)
