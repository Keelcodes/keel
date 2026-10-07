# @keelcodes/policy

Account-agnostic authorization policy for agent accounts.

A policy declares **what an agent may do** with an account: which target
contracts it may call, which methods on them, and the value / frequency
ceilings. The model contains no account-specific encoding, so the same `Policy`
works across Kernel, Nexus and Safe7579.

This package is the **off-chain core**: the DSL, a canonical commitment hash, a
pre-check / simulation layer, and multi-session lifecycle management. The
on-chain carrier for enforcement is a **Keel ERC-7579 hook module**
(account-agnostic: a hook sees the execution of any 7579 account without parsing
account-specific call data). The hook recomputes the same commitment, so the two
layers cannot disagree about what a policy means.

## Policy DSL

```ts
import { normalizePolicy, policyCommitment } from '@keelcodes/policy';

const policy = normalizePolicy({
  validAfter: 0n,          // unix seconds; 0 = immediately
  validUntil: 1_800_000_000n, // 0 = never
  rules: [{
    target: USDC, selectors: ['0xa9059cbb'],
    maxPerTx: 10n ** 6n, maxDaily: 10n ** 7n, maxCalls: 50,   // native value / count
    tokenLimits: [{ token: USDC, maxPerTx: 10n ** 6n, maxDaily: 10n ** 7n }], // ERC-20 amount
  }],
});

policyCommitment(policy); // keccak256(abi.encode(version, validAfter, validUntil, rules))
```

Each rule scopes to one `target` with optional `selectors` (empty = any method)
and ceilings: `maxPerTx` (native value per call), `maxDaily` (native value per
day), `maxCalls` (call count). `0` / omitted means unlimited.

`normalizePolicy` fills every optional with its zero default and lower-cases
addresses, so `{ maxPerTx: 0n }` and `{}` produce the **same** commitment. A
malformed policy throws `PolicyError` at definition time.

## ERC-20 token limits

`tokenLimits` adds per-token amount ceilings (`maxPerTx` / `maxDaily`) on top
of the native-value caps. The token must equal the rule's `target` — a cap can
only be enforced on calls made **directly** to the token, so a limit for any
other address is rejected as dead config.

Amounts are read from the standard `transfer` / `approve` / `transferFrom` call
data (the amount is the final `uint256` word). While a limit is configured:

- `transfer` / `approve` are capped by the token ceilings;
- `transferFrom` is **refused** (`token-transfer-from-blocked`) — bounding a
  pull from an arbitrary address is ambiguous, so the conservative choice is to
  reject it;
- a malformed standard call is refused (`token-amount-unparsable`);
- any other selector is left to the rule's `selectors` whitelist.

Token caps apply to the immediate call target only; a token moved *inside* a
router call is not covered by this rule (use a rule on the token itself).

## Pre-check & simulation

`evaluateCall` applies validity, rule matching (first match in declared order)
and the ceilings. `simulateCalls` dry-runs a batch, accumulating usage so a
batch that only breaches a cap together is caught, and returns the first denial
with a machine-readable reason — before a bundler round-trip that would end in
a validation failure.

```ts
import { evaluateCall, simulateCalls, toCall } from '@keelcodes/policy';

const call = toCall({ target: USDC, value: 0n, data: transferCalldata });
evaluateCall(policy, { now: 1_700_000_000n, usage: [] }, call);
// → { allowed: true, ruleIndex: 0 }
```

`PolicyState.usage` is aligned to `policy.rules` by index; callers reset
`dailySpent` / `tokenSpent` when the day window rolls over.

## Hook install payload

The on-chain hook installs one session at a time. `encodeInstallData(sessionId,
policy)` builds the exact payload it decodes — `abi.encode(bytes32 sessionId,
bytes policyData)` with `policyData = encodePolicy(policy)`. The session's
on-chain commitment is therefore `keccak256(policyData) === policyCommitment(policy)`,
so an installed session can be verified against what was signed.

```ts
import { encodeInstallData } from '@keelcodes/policy';

encodeInstallData(session.id, session.policy); // → onInstall bytes
```

## Multi-session lifecycle

An account may hold **many concurrent sessions** — one policy grant each — which
fixes the old "one account, one session" limitation. A session is an immutable
record carrying the policy, its commitment and lifecycle metadata, and it holds
**no key material**: it references a policy, not a private key, so key custody
stays with the caller (KMS or the client).

```ts
import { InMemorySessionStore, issueSession, revokeSession, rotateSession } from '@keelcodes/policy';

const store = new InMemorySessionStore();
const session = await issueSession(store, { account, policy, now });
await revokeSession(store, session.id, now);
const { previous, next } = await rotateSession(store, session.id, { policy, now });
```

`sessionStatus(session, now)` derives `pending` / `active` / `expired` /
`revoked` from the record, and `listSessions(store, account, now)` returns an
account's sessions with their status. Revocation is append-only (the record is
kept with `revokedAt`, so it stays auditable), and a rotation cross-links the
predecessor and successor (`rotatedFrom` / `rotatedTo`) — the off-chain half of
the migration "uninstall old module + install new" (the consumer repo's
plan, §7.5).
Persistence goes through the async `SessionStore` port, so a database-backed
store drops in; `InMemorySessionStore` is the minimal reference (no tenancy —
one Keel stack per product, see the consumer repo's plan §6.3).

## Scope

- ✅ Declarative DSL + normalisation + validation
- ✅ Canonical commitment hash (ABI encoding shared with the on-chain carrier)
- ✅ Off-chain pre-check + batch simulation
- ✅ ERC-20 token limits (`maxPerTx` / `maxDaily` per token)
- ✅ ERC-7579 hook module (`KeelPolicyHook`, Solidity) enforcing the same rules on-chain, many sessions per account (see `contracts/`)
- ✅ Multi-session lifecycle (issue / revoke / rotate) + pluggable `SessionStore`

Pre-alpha. The public API is not stable yet.

## Out of scope

- Account implementations (see `@keelcodes/adapters`)
- Billing and multi-tenancy
