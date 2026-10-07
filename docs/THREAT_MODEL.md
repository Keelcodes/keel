# Keel threat model

Scope: the authorization path Keel is responsible for — an agent operating a
smart account through a bounded session grant, enforced by
[`KeelPolicyHook`](../contracts/src/KeelPolicyHook.sol) on-chain with the
[`@keelcodes/policy`](../packages/policy) DSL as its off-chain mirror.

Threat ids (`T-*`) are referenced from the red-team suite
([`contracts/test/redteam/`](../contracts/test/redteam)) and the conformance
checks ([`@keelcodes/conformance`](../packages/conformance)).

## 1. Assets

| # | Asset | Why it matters |
|---|---|---|
| A1 | The account's funds and token allowances | What an attacker is after |
| A2 | The principal's authority | Only intended actions should execute |
| A3 | Session budgets (per-tx / per-day / call count) | The blast radius of a leaked session key |
| A4 | Policy integrity | Limits must be the ones that were signed, not whatever is installed |
| A5 | Audit trail | Usage must be attributable after the fact |

## 2. Adversaries

| # | Adversary | Capability |
|---|---|---|
| P1 | Compromised agent / leaked session key | Can submit arbitrary calldata to the account |
| P2 | Malicious executor or fallback module on the account | Runs inside the account's execution path |
| P3 | Third-party caller | Can call public entrypoints, replay, or grief |
| P4 | Malicious module vendor | Ships modules that misreport their own state |
| P5 | Operator error (non-adversarial) | Misconfigured install that silently does nothing |

## 3. Trust assumptions

1. **The account is honest toward its own principal.** The principal (not the
   agent, not a third party) controls install/uninstall. Threats that require the
   principal to attack itself are listed as accepted risks (§7), not mitigations.
2. **The account actually invokes the hook on the path used.** A hook is only as
   complete as the account's hook coverage — see `T-COVERAGE-01`.
3. **`block.timestamp` is honest** to within normal validator drift. Per-day
   windows are coarse (whole days), so drift is not security-relevant.
4. **The policy commitment is verified out of band.** The hook stores
   `keccak256(policyData)`; a client must compare it to the commitment it signed
   (`policyCommitment`) *before* trusting that what is installed is what was
   agreed. The hook enforces what is installed; it cannot know what was intended.

## 4. Threat catalogue

| id | Threat | Impact | Mitigation | Covered by |
|---|---|---|---|---|
| `T-BYPASS-01` | Route execution through `delegatecall` (callType `0xff`) so the policy never applies to the real call | Full bypass | Reject any callType other than single/batch (`UnsupportedCallType`) | red-team `T_BYPASS_01` |
| `T-BYPASS-02` | Reach the account with a dispatch selector the hook does not police | Full bypass | `preCheck` accepts only `execute` / `executeFromExecutor` (`UnsupportedCallData`) | red-team `T_BYPASS_02` |
| `T-BYPASS-03` | Drain a token-limited rule with `transferFrom` (pull from an arbitrary owner) | Fund loss | `transferFrom` is refused on a token-limited rule (`TokenTransferFromBlocked`) | red-team `T_BYPASS_03` |
| `T-BYPASS-04` | Short/ill-formed ERC-20 calldata so the amount reads as `0` | Cap evasion | Standard selectors below 68 bytes are refused (`TokenAmountUnparsable`) | red-team `T_BYPASS_04` |
| `T-BYPASS-05` | Widen a rule's selector whitelist from the call site (`approve` where only `transfer` is allowed) | Cap evasion | Selector whitelist is enforced (`NoMatchingRule`) | red-team `T_BYPASS_05` |
| `T-BYPASS-06` | Call a target no rule authorises | Unbounded spend | Unmatched target reverts (`NoMatchingRule`) | red-team `T_BYPASS_06` |
| `T-CEILING-01` | Split a native transfer across a batch to stay under `maxDaily` per call | Cap evasion | The batch accrues call-by-call; the whole attempt reverts (`DailyLimitExceeded`) | red-team `T_CEILING_01` |
| `T-CEILING-02` | Split token transfers across a batch to stay under the token daily cap | Cap evasion | Token daily accrual is per batch (`TokenDailyLimitExceeded`) | red-team `T_CEILING_02` |
| `T-ACCRUAL-01` | Re-install the same session to reset its counters | Cap evasion | Reusing an installed session id reverts (`SessionAlreadyInstalled`) | red-team `T_ACCRUAL_01` |
| `T-ACCRUAL-02` | Call the hook's session-charging entrypoint directly to charge or wipe another account's accrual | DoS / false attribution | `applySession` is self-call-only (`Unauthorized`) | red-team `T_ACCRUAL_02` |
| `T-WINDOW-01` | Keep using a session after its validity window | Unlimited use | Per-session `validAfter` / `validUntil` (`NotYetValid` / `Expired`) | red-team `T_WINDOW_01` |
| `T-LIFECYCLE-01` | Use a session after it was uninstalled | Revoked authority still works | Sessions are removed on uninstall (`NotInitialized`) | red-team `T_LIFECYCLE_01` |
| `T-SILENT-01` | A module is *registered* on the account while its `onInstall` silently no-ops (bad `initData` layout), so nothing is enforced | Account looks configured but is unprotected; a silent AA24-class failure | Conformance asserts the **double probe**: `isModuleInstalled` **and** the module's own `isInitialized(account)` | conformance `erc7579.module.initialized` |
| `T-COVERAGE-01` | Execute via an account path that does not invoke the hook (e.g. a native function that bypasses `execute`) | Policy not applied on that path | Out of the hook's control: rely on the account routing value through `execute`. Documented rather than mitigated | residual risk (§6) |
| `T-INTEGRITY-01` | Install a policy different from the one that was signed | Limits differ from intent | Session commitment `keccak256(policyData)` is readable (`policyCommitmentOf`) and must be checked against `policyCommitment` before use | `@keelcodes/policy` (`policyCommitment`, `encodeInstallData`) |
| `T-ENVELOPE-01` | Draw an amount past the envelope's cap to escape the aggregate budget | Fund loss / budget evasion | `advanceCursor` enforces `spent + amount <= cap` (`CapExceeded`); the hook charges it on the atomic execution path | red-team `T_ENVELOPE_01` |
| `T-ENVELOPE-02` | An already-attenuated node delegates again, re-widening authority the aggregate profile flattened | Privilege escalation | A child whose `delegate` is `true` is refused (`AttenuationViolated`) | red-team `T_ENVELOPE_02` |
| `T-ENVELOPE-03` | Child allocations sum past the root cap, conjuring headroom the root was never granted | Unbounded spend | Root-keyed conservation meter: `Σ child.cap <= parent.cap` (`ConservationViolated`) | red-team `T_ENVELOPE_03` |
| `T-ENVELOPE-04` | Advance a revoked or expired envelope whose authority no longer exists | Revoked authority still works | Effective status must be `Active`; otherwise `NotActive` | red-team `T_ENVELOPE_04` |
| `T-ENVELOPE-05` | A stranger advances a cursor, or drives a status transition it is not authorized for | False attribution / DoS | `advanceCursor` requires principal-or-gate (`UnauthorizedAdvance`); status changes are role-gated (`UnauthorizedStatus`) | red-team `T_ENVELOPE_05` |
| `T-ENVELOPE-06` | Register a capability whose committed data does not hash to the `capabilityRoot` it claims | Capability substitution | `keccak256(capabilityData) == capabilityRoot` is enforced (`CapabilityRootMismatch`) | red-team `T_ENVELOPE_06` |
| `T-ENVELOPE-07` | Replay / re-register the same `(principal, capabilityRoot, salt)` to reset a spent cursor | Cap evasion | Ids are unique and never reused, including by terminal envelopes (`EnvelopeExists`) | red-team `T_ENVELOPE_07` |
| `T-ENVELOPE-08` | Bind a session to a **stranger's** envelope, so every quoted execution charges (or zero-cost corrupts) another principal's budget and `cursorRoot` | Unauthorized spend / attribution corruption on a third party | `bindEnvelope` reads the envelope and requires `principal == account` (`EnvelopeNotOwned`) | red-team `T_ENVELOPE_08` |
| `T-ENVELOPE-09` | An attenuated child swaps in its own **approver set** (same threshold, different identities), replacing the principal's gate | Privilege escalation / approval-gate bypass | Attenuation requires `child.approvers ⊆ parent.approvers` (`AttenuationViolated`), on-chain and in `@keelcodes/policy` | red-team `T_ENVELOPE_09` |

## 5. Out of scope

- Billing, pricing, platform keys and multi-tenant stores — deliberately kept in
  infraX, never in Keel (see the consumer repo's plan, §6.3).
- The account implementation itself (Kernel / Nexus / Safe7579), the bundler and
  the paymaster. Keel adapts them; it does not audit them.
- Economic threats (MEV, fee manipulation) except where they enable a bypass above.

## 6. Residual risks

| id | Residual risk | Why it is accepted / what to do |
|---|---|---|
| `T-SIGNER-01` | A hook cannot see *which* session signed, so installed sessions act as a **union of grants**: a broad session widens what a narrow one can reach | Inherent to the hook module type. Mitigate by keeping one account per trust domain, or move signer attribution into a validator |
| `T-RESET-01` | Uninstalling and reinstalling a **new** session id starts fresh counters, wiping accumulated usage | The account is the principal. Keep `installModule` / `uninstallModule` on the hook out of any session's policy whitelist |
| `T-POST-01` | `postCheck` is a no-op: no post-execution invariant is asserted | Ceilings are enforced and accrued up front; nothing is deferred |
| `T-SCOPE-01` | ERC-7710 / 7715 / 8004 conformance is not yet implemented | Tracked as the next conformance slice — see [`CONFORMANCE.md`](./CONFORMANCE.md) |

## 7. Reporting

Please do not open public issues for vulnerabilities — see
[`SECURITY.md`](../SECURITY.md).
