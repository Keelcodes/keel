// ============================================================================
// ERC-8313 trust grading.
//
// The standard defines four trust levels and, crucially, *how a signature is
// computed*: "The signature MUST be of the keccak256 hash of the entire PIM
// excluding the signatures section. Any spacing, new lines or hidden characters
// added for human-readability MUST be removed before the hash is generated."
//
// What the draft does NOT define is whether that hash is signed directly
// (`eth_sign`-style raw digest) or wrapped in EIP-191 (`personal_sign`). Both
// are seen in the wild, so we try both and say which one matched — a signature
// is only reported as verified when it *actually* recovers to the declared
// signer under one of the two interpretations. We never fake a pass.
//
// Level assignment beyond the cryptographic check needs out-of-band knowledge
// (is this address on the protocol's website? is it the wallet's pinned
// signer?). That is caller-supplied via {@link TrustOptions}; an address we can
// cryptographically verify but cannot place in any registry is *still* Level 0
// ("signer address is unknown") per the standard's own criteria.
// ============================================================================

import { keccak256, recoverAddress, recoverMessageAddress, toBytes, type Hex } from 'viem';
import type { Pim } from './types.js';

export type TrustLevel = 0 | 1 | 2 | 3;
export type TrustLevelName = 'Unverified' | 'Community' | 'Protocol Signed' | 'Wallet Verified';

/** The four levels, verbatim from the draft's "Trust level assignment" table. */
export interface TrustLevelDefinition {
  level: TrustLevel;
  name: TrustLevelName;
  criteria: string;
}

export const TRUST_LEVELS: readonly TrustLevelDefinition[] = [
  {
    level: 0,
    name: 'Unverified',
    criteria: 'No signature included or signer address is unknown.',
  },
  {
    level: 1,
    name: 'Community',
    criteria: 'Signature from a known community publisher. Hash verified. Signer not the protocol team.',
  },
  {
    level: 2,
    name: 'Protocol Signed',
    criteria: "Signature from an address on a protocol's website, or registered with an ENS domain, or broadcast using ECP.",
  },
  {
    level: 3,
    name: 'Wallet Verified',
    criteria: 'Internally reviewed and pinned by the wallet team. MAY be bundled with the wallet.',
  },
];

/** Which signature payload interpretation recovered the signer. */
export type SignatureRecovery = 'digest' | 'personal';

/** Whether to try raw-digest, EIP-191, or both interpretations. Default `auto`. */
export type SignatureScheme = SignatureRecovery | 'auto';

export interface TrustOptions {
  /** Addresses recognised as a known community publisher → Level 1. */
  knownCommunitySigners?: readonly string[];
  /** Addresses recognised as protocol-controlled (website/ENS/ECP) → Level 2. */
  protocolSigners?: readonly string[];
  /** Addresses reviewed and pinned by the wallet team → Level 3. */
  walletVerifiedSigners?: readonly string[];
  /** Payload interpretation; defaults to trying both. */
  scheme?: SignatureScheme;
}

export interface TrustInfo {
  level: TrustLevel;
  name: TrustLevelName;
  /** True only when a signature recovered to the declared `signer`. */
  verified: boolean;
  signer?: Hex;
  signerLabel?: string;
  /** How the recovered signature was interpreted (only when `verified`). */
  scheme?: SignatureRecovery;
  /** Human-readable explanation, always present. */
  reason: string;
}

/**
 * The canonical byte content a signature commits to: the PIM with the
 * `signatures` section removed, serialised with no whitespace.
 *
 * `JSON.stringify` preserves object key order, which is how the document was
 * parsed — consistent with "remove spacing/newlines" and no key reordering
 * being specified.
 */
export function canonicalPimJson(pim: Pim): string {
  const { signatures: _signatures, ...rest } = pim;
  void _signatures;
  return JSON.stringify(rest);
}

/** keccak256 of the canonical PIM content (the message the spec says is signed). */
export function pimDigest(pim: Pim): Hex {
  return keccak256(toBytes(canonicalPimJson(pim)));
}

/**
 * Assign a trust level to a PIM.
 *
 * This is a *verifier*, not an oracle: without registry options a verifiable
 * signature still grades Level 0 (unknown signer), matching the standard.
 *
 * Async because viem's signer-recovery is async; the rest of the function is pure.
 */
export async function trustLevelOf(pim: Pim, options: TrustOptions = {}): Promise<TrustInfo> {
  const signatures = Array.isArray(pim.signatures) ? pim.signatures : [];
  if (signatures.length === 0) {
    return {
      level: 0,
      name: 'Unverified',
      verified: false,
      reason: 'no signatures present',
    };
  }

  const community = lowerSet(options.knownCommunitySigners);
  const protocol = lowerSet(options.protocolSigners);
  const wallet = lowerSet(options.walletVerifiedSigners);
  const scheme = options.scheme ?? 'auto';

  let sawEcdsa = false;
  for (const signature of signatures) {
    if (signature.type !== 'ecdsa') continue;
    if (typeof signature.signer !== 'string' || typeof signature.signature !== 'string') continue;
    sawEcdsa = true;

    const recovered = await recoverSigners(pim, signature.signature as Hex, scheme);
    const declared = signature.signer.toLowerCase();
    const matched = recovered.get(declared);
    if (matched === undefined) continue;

    const level: TrustLevel = wallet.has(declared)
      ? 3
      : protocol.has(declared)
        ? 2
        : community.has(declared)
          ? 1
          : 0;

    const info: TrustInfo = {
      level,
      name: trustName(level),
      verified: true,
      signer: signature.signer as Hex,
      scheme: matched,
      reason:
        level === 0
          ? 'signature verified, but the signer is not in any known trust registry (unknown signer → Unverified)'
          : `signature verified; signer is a known ${trustName(level).toLowerCase()} publisher`,
    };
    if (signature.signerLabel !== undefined) info.signerLabel = signature.signerLabel;
    return info;
  }

  return {
    level: 0,
    name: 'Unverified',
    verified: false,
    reason: sawEcdsa
      ? 'signature present but it did not recover to the declared signer (payload/canonicalisation mismatch)'
      : 'no supported (ecdsa) signature present',
  };
}

async function recoverSigners(
  pim: Pim,
  signature: Hex,
  scheme: SignatureScheme,
): Promise<Map<string, SignatureRecovery>> {
  const recovered = new Map<string, SignatureRecovery>();
  const canonical = canonicalPimJson(pim);

  if (scheme === 'digest' || scheme === 'auto') {
    try {
      const hash = keccak256(toBytes(canonical));
      recovered.set((await recoverAddress({ hash, signature })).toLowerCase(), 'digest');
    } catch {
      // Not a valid signature under this interpretation; try the next.
    }
  }
  if (scheme === 'personal' || scheme === 'auto') {
    try {
      recovered.set((await recoverMessageAddress({ message: canonical, signature })).toLowerCase(), 'personal');
    } catch {
      // Not a valid signature under this interpretation.
    }
  }
  return recovered;
}

function trustName(level: TrustLevel): TrustLevelName {
  return TRUST_LEVELS[level]?.name ?? 'Unverified';
}

function lowerSet(values: readonly string[] | undefined): Set<string> {
  return new Set((values ?? []).map((value) => value.toLowerCase()));
}
