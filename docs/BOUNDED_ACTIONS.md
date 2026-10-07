# Bounded Agent Actions (ERC-8312)

Keel's on-chain substrate for **ERC-8312 — Bounded Agent Actions**, plus the
Keel accounting profile layered on top of it and its integration with
[`KeelPolicyHook`](../contracts/src/KeelPolicyHook.sol).

The off-chain mirror is [`@keelcodes/policy`](../packages/policy/src/bounded.ts)
(`bounded.ts`); the on-chain half is
[`KeelBoundedActions`](../contracts/src/KeelBoundedActions.sol). Both recompute
the same commitments from the same canonical encodings, so the two layers cannot
disagree about what a capability means.

## Aligned revision (and honest boundaries)

This implementation is aligned with **ERC-8312 draft of 2026-05-09**, which
`requires: 165`; the draft is authored by **Matthias Hauser** and **Simon
Brown** (**PR #1833**). ERC-8312 is still evolving, so Keel tracks a *revision*
rather than claiming standards conformance.

ERC-8312 deliberately treats `capabilityRoot` as **opaque** — the interface does
*accounting, not enforcement* ("counting ≠ enforcing"). Everything **inside** the
capability below is therefore Keel's **own profile**, not a standard:

- `trustTier` — an ordered consumer-side label (who a target requires a minimum of);
- `notBefore` — a release gate;
- `threshold` / `approvers` — an M-of-N approval gate;
- `cap` / `asset` — the budget the aggregate profile meters.

What *is* taken from the draft: the envelope shape, the cursor, the budget
profile (`spent <= cap`), the aggregate profile's conservation/attenuation rules
and the status state machine.

## Canonical encodings

These match `packages/policy/src/bounded.ts` field-for-field:

```text
capabilityData = abi.encode(
    uint256 version, address asset, uint256 cap, uint8 trustTier,
    uint256 notBefore, bool delegate, uint256 threshold, address[] approvers)
capabilityRoot = keccak256(capabilityData)

cursorData     = abi.encode(uint256 spent, uint256 draws, uint256 lastAdvance)
cursorRoot     = keccak256(cursorData)

id             = keccak256(abi.encode(address registry, address principal,
                                      bytes32 capabilityRoot, bytes32 salt))
```

`CAPABILITY_VERSION = 1`. The zero cursor (`spent = draws = lastAdvance = 0`)
is the state of a freshly registered envelope.

### `initData` (registration)

```text
initData = abi.encode(bytes32 salt, bytes capabilityData)
```

`registerEnvelope` requires `keccak256(capabilityData) == capabilityRoot`,
rejects any `version != CAPABILITY_VERSION`, and rejects a non-zero `expiresAt`
that is not strictly in the future (`0` means "no expiry"). The initial
`cursorRoot` is the zero cursor and is readable immediately. The resulting id is
deterministic and exposeable ahead of time via `precomputeId`.

### `witness` (draws)

```text
witness = abi.encode(uint256 amount, address[] approvals)
```

`advanceCursor` runs the gates in the same order as `canDraw` off-chain:
**status → notBefore → approvals → cap**. `trustTier` is a *consumer-side*
minimum, so the substrate does not enforce it (a target that requires `tier >= n`
checks it itself). On success the cursor advances (`spent += amount`, `draws += 1`,
`lastAdvance = block.timestamp`) and `EnvelopeAdvanced` is emitted.

## Profiles

### Budget

`spent + amount <= cap`, where `spent` is the cumulative cursor. `remainingOf`
exposes `cap - spent` (never negative).

### Aggregate (conservation + attenuation)

A root envelope may derive children with `registerAttenuated`:

- **Conservation** — the leaf allocations may not sum to more than the root cap
  (`Σ child.cap <= parent.cap`), metered per `capabilityRoot` in `_allocated`. A
  tree can never conjure headroom it was not granted.
- **Attenuation** — a child must be no wider than its parent: same `asset`,
  `cap <=`, `trustTier <=`, `notBefore >=`, `threshold >=`. An attenuated node
  **may not delegate again** (`child.delegate` must be `false`), which is what
  stops widening from being re-introduced transitively. The child inherits the
  parent's principal and expiry (a child may not outlive its parent).

Only a parent with `delegate == true` and `attenuated == false` may derive a
child; the caller must be the parent's principal or a registered gate.

### Contest / lifecycle

```text
Active    -> {Completed, Contested, Revoked, Expired}
Contested -> {Active (dismissed), Revoked (upheld)}
Completed / Revoked / Expired  terminal;  None = unknown id
```

`getStatus` returns the **effective** status (an Active envelope past its expiry
reads as `Expired`). `isActive` is true only while Active and not expired.

Authorization:

| Transition | Who |
|---|---|
| `Active -> {Completed, Contested, Revoked}` | principal |
| `Contested -> {Active, Revoked}` | principal |
| `Active -> Expired` (only once actually expired) | anyone |
| `Contested -> Active` (only after the window lapses) | anyone |

Entering `Contested` opens a `contestWindow` (default `3 days`, owner-tunable).
Once the window lapses any caller may resolve the contest back to `Active` — the
documented default — so an accused party cannot run out the clock to foreclose a
verdict.

### Registration / advance authorization

The principal may always act for itself. A registered **gate**
(`setGate`, owner-only) may register on a principal's behalf and advance its
cursor; a gate is trusted to have obtained upstream authorization (EIP-712 /
ERC-1271 / upstream delegation is a documented future extension, not yet
implemented).

## Two-layer enforcement with `KeelPolicyHook`

The substrate owns budgets; the hook owns the account's only execution path.
Binding them makes the aggregate budget non-bypassable:

- `bindEnvelope(sessionId, registry, envelopeId)` / `unbindEnvelope(sessionId)`
  (called by the account) attach an envelope to one installed session.
- At the end of `applySession` — after every per-call policy check, inside the
  same atomic trial — the binding charges the envelope with the batch's total
  native `value`: `advanceCursor(envelopeId, abi.encode(amount, new address[](0)))`.
- A `CapExceeded` (or any envelope revert) rolls the whole session attempt back;
  if no other session admits the call, `preCheck` surfaces it.

This is **additive and backward-compatible**: a session with no binding (registry
`address(0)`) behaves exactly as before.

Metering note: the hook charges native `value`, which corresponds to an envelope
denominated in the native asset. An **ERC-20** budget is charged by the gateway /
principal calling `advanceCursor` directly with token amounts.

## Reconciliation helpers

`capabilityOf`, `rawCursorOf`, `allocatedOf` and `remainingOf` expose the raw
state for tests and off-chain reconciliation. The standard's invariant
`getCursor(id) == getEnvelope(id).cursorRoot` holds within a block.

## Tests

- `contracts/test/KeelBoundedActions.t.sol` — functional suite, including the
  cross-layer commitment consistency check against hand-built `bounded.ts` bytes.
- `contracts/test/redteam/KeelBoundedActions.redteam.t.sol` — `T-ENVELOPE-01…07`.
- `contracts/test/KeelEnvelopeIntegration.t.sol` — the hook two-layer integration.
