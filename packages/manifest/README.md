# @keelcodes/manifest

Consume and produce **[ERC-8313 Protocol Interaction Manifests][erc8313]** (PIM).

A PIM is a machine-readable JSON document describing *how* to interact with a
smart-contract protocol — not just its ABI, but the ordered workflow that
fulfils a user intent. It is an **untrusted input**: it arrives from a dApp, a
registry or a peer agent, so it must be validated and graded before anything is
executed.

This package is the Keel side of that:

- **consume** — `validatePim` checks an untrusted document against the standard;
  `trustLevelOf` verifies signatures and assigns a trust level.
- **produce** — `buildKeelPim` emits Keel's own manifest, describing the Keel
  policy hook and the ERC-8312 bounded-action substrate.

Everything is a pure function (no I/O; `trustLevelOf` is async only because
signer recovery is). The same code runs in a wallet, an agent, an MCP server or
the bundled CLI.

## What it validates

The nine mandatory top-level objects are always required:

`schemaVersion`, `metadata`, `contracts`, `types`, `lookups`, `calculations`,
`intents`, `ui`, `signatures`.

`validatePim` returns `{ valid, errors, warnings }`; `valid` is `true` only when
there are no `errors`. Key rules:

- `metadata`: all required fields, the `category` enum, a semver `pimVersion`,
  and a non-empty `chainId`.
- `contracts.*`: exactly one of `address` / `lookup` (both or neither is an
  error), the `role` enum, and a required `description`. A `lookup` must name an
  entry in `lookups`.
- `lookups.*`: `contract` must resolve to `contracts`; `function`/`args`/
  `returns` are required; `validate` assertions need at least one operator;
  `selectCriterion` is only allowed alongside `select`.
- `types.*`: the `kind` enum and a required `fields` map.
- `calculations.*`: required `description`/`formula` (with a `set` instruction)
  and the `precision` enum.
- `intents.*`: at least one intent, each with `description` / `requiredInputs` /
  `steps`; step ids must start at 1 and not skip; `buildTransaction` steps need
  a declared `contract`, a `function` and a `description`.
- `ui.intentDescriptions` must cover every named intent.
- Semantic gates: pass `{ now }` to reject an expired (or not-yet-valid) PIM, and
  `{ chainId }` to reject one that does not scope the current network — both are
  "execution engines MUST reject" rules in the standard.

## Usage

```ts
import { validatePim, trustLevelOf, buildKeelPim } from '@keelcodes/manifest';

const result = validatePim(untrusted, { now: Math.floor(Date.now() / 1000), chainId: 8453 });
if (!result.valid) throw new Error(JSON.stringify(result.errors));

const trust = await trustLevelOf(untrusted, {
  protocolSigners: ['0x…'], // addresses on the protocol's website / ENS
  knownCommunitySigners: ['0x…'],
  walletVerifiedSigners: ['0x…'],
});

const keel = buildKeelPim({
  policyHook: '0x…', // required, never defaulted
  boundedActions: '0x…', // required, never defaulted
  chainId: [8453],
});
```

Keel's `buildKeelPim` output is asserted to pass `validatePim` in this package's
tests, so the manifest and the validator can never silently drift apart.

## CLI

The consumer CLI reads the built package (`pnpm build` first) and needs no
third-party argument parser (`node:util` `parseArgs` only):

```bash
pnpm --filter @keelcodes/manifest build

node scripts/pim.mjs validate scripts/fixtures/valid.pim.json   # exits non-zero on any error
node scripts/pim.mjs validate /path/to/manifest.json --chain-id 8453 --now 1800000000
node scripts/pim.mjs inspect  scripts/fixtures/valid.pim.json   # protocol/chains/intents/trust/contracts
node scripts/pim.mjs keel --chain-id 8453 \
  --policy-hook 0x1234567890abcdef1234567890abcdef12345678 \
  --bounded-actions 0xabcdefabcdefabcdefabcdefabcdefabcdefabcd
```

`validate` prints one `[severity] path: message` line per issue and exits `1`
when any error is present — suitable for CI or a wallet's pre-flight gate.

## Trust levels

ERC-8313 defines four levels. This package assigns them from the `signatures`
section:

| Level | Name | Assigned when |
|---|---|---|
| 0 | Unverified | no signature, an unverifiable signature, or a verified signer that is in no known registry |
| 1 | Community | verified signature from a `knownCommunitySigners` address |
| 2 | Protocol Signed | verified signature from a `protocolSigners` address |
| 3 | Wallet Verified | verified signature from a `walletVerifiedSigners` address |

Registry membership is deliberately caller-supplied: a library cannot know which
address is "on the protocol's website" or "pinned by the wallet team". A
cryptographically valid signature that is in no registry still grades Level 0,
exactly as the standard's "signer address is unknown" criterion requires.

### How a signature is verified

The standard says the signature is "of the keccak256 hash of the entire PIM
excluding the signatures section", with whitespace removed. It does **not** say
whether that hash is signed directly (raw digest) or wrapped in EIP-191. This
package tries both interpretations (`recoverAddress` and
`recoverMessageAddress`) and reports which one matched. It never reports a
signature as verified unless it actually recovers to the declared `signer`.

## Unverified fields and honest boundaries

- Aligned with the **draft of 2026-06-19** (author Paul Angus Bark, [PR
  #1836][pr]). Drafts change; treat this as a point-in-time implementation.
- **Step-level lookup reference is not pinned by the draft.** The standard says
  lookups "are referenced by name in intent steps" but its all-step-types field
  table does not name the field. Keel's own manifest uses `lookup: "<name>"` and
  the validator only *warns* on a dangling reference — it never rejects a
  manifest for using a different, spec-valid field name.
- **Signature payload style is ambiguous** (raw digest vs EIP-191), as described
  above. Both are attempted; unverifiable signatures are reported as such.
- **Level 3 (Wallet Verified) is not derivable from the document.** The standard
  defines it as an internal wallet decision; it can only be assigned when the
  caller supplies the wallet's pinned signers.
- `buildKeelPim` **never fabricates addresses or signatures**: the hook/substrate
  addresses are required arguments, and `signatures` is `[]` (Level 0 by
  construction). Signing the manifest is a release-time step, not library logic.

[erc8313]: https://eips.ethereum.org/EIPS/eip-8313
[pr]: https://github.com/ethereum/ERCs/pull/1836
