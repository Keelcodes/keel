// ============================================================================
// Keel's own ERC-8313 Protocol Interaction Manifest.
//
// This is the *producer* half of the package: a description of Keel's on-chain
// interaction surface, emitted by code so it can never drift from the packages
// it documents. The output is asserted to pass `validatePim` in the tests.
//
// Honesty boundaries baked in here:
//  * Contract addresses are NEVER defaulted or hard-coded. The caller must
//    supply the deployed `KeelPolicyHook` and `KeelBoundedActions` addresses;
//    a missing/invalid address is a hard build error, not a placeholder.
//  * `signatures` is `[]`. Keel does not sign its own PIM here, so the manifest
//    is Level 0 (Unverified) by construction — the manifest must not pretend
//    otherwise. Signing is a deployment/release-time step, not library logic.
// ============================================================================

import { isAddress } from 'viem';
import { PimBuildError } from './errors.js';
import type { HexAddress, Pim, PimLookup, PimType } from './types.js';

export interface BuildKeelPimOptions {
  /** Deployed `KeelPolicyHook` address (ERC-7579 hook module). Required. */
  policyHook: string;
  /** Deployed `KeelBoundedActions` address (ERC-8312 substrate). Required. */
  boundedActions: string;
  /** Chains the addresses are valid on. Defaults to `[1, 56, 8453]`. */
  chainId?: number[];
  /** Semantic version of the manifest document. Defaults to `"1.0.0"`. */
  pimVersion?: string;
  /** Author website. Defaults to `"https://keel.codes"`. */
  website?: string;
  /** Optional validity window (unix seconds). */
  validFrom?: number;
  validUntil?: number;
}

const DEFAULT_CHAIN_IDS: readonly number[] = [1, 56, 8453];
const DEFAULT_PIM_VERSION = '1.0.0';
const DEFAULT_WEBSITE = 'https://keel.codes';

/**
 * Build Keel's PIM from the caller's deployed addresses.
 *
 * @throws {PimBuildError} when an address is missing or not a valid hex address.
 */
export function buildKeelPim(options: BuildKeelPimOptions): Pim {
  const policyHook = assertAddress(options.policyHook, 'policyHook');
  const boundedActions = assertAddress(options.boundedActions, 'boundedActions');
  const chainId = options.chainId ?? [...DEFAULT_CHAIN_IDS];

  const metadata: Pim['metadata'] = {
    protocol: 'Keel',
    description:
      'Keel is an ERC-7579 account-abstraction stack for autonomous agents: policy-bounded sessions enforced by an on-chain hook, escrowed by ERC-8312 bounded-action envelopes.',
    category: 'other',
    website: options.website ?? DEFAULT_WEBSITE,
    author: 'Keel',
    chainId,
    pimVersion: options.pimVersion ?? DEFAULT_PIM_VERSION,
  };
  if (options.validFrom !== undefined) metadata.validFrom = options.validFrom;
  if (options.validUntil !== undefined) metadata.validUntil = options.validUntil;

  return {
    schemaVersion: '1.0.0',
    metadata,
    contracts: {
      // The hook is where the account's only execution path is gated; the
      // substrate owns the cross-call aggregate budget.
      policyHook: {
        address: policyHook,
        role: 'other',
        description:
          'KeelPolicyHook (ERC-7579 hook, module type 4): enforces the Keel policy DSL on the account and charges the bound ERC-8312 envelope.',
      },
      boundedActions: {
        address: boundedActions,
        role: 'registry',
        description:
          'KeelBoundedActions (ERC-8312 substrate): the envelope registry and cursor the account draws against.',
      },
    },
    types: {
      // Field-for-field mirror of IERC8312.Envelope.
      Envelope: tuple('An ERC-8312 envelope: an immutable capability commitment plus a mutable aggregate-state commitment.', {
        id: { type: 'bytes32', description: 'Deterministic envelope id.' },
        principal: { type: 'address', description: 'Account the envelope is bound to.' },
        capabilityRoot: { type: 'bytes32', description: 'keccak256 of the canonical capability encoding.' },
        cursorRoot: { type: 'bytes32', description: 'keccak256 of the current cursor encoding.' },
        createdAt: { type: 'uint64', unit: 'seconds', description: 'Registration timestamp.' },
        expiresAt: { type: 'uint64', unit: 'seconds', description: 'Expiry timestamp; 0 means no expiry.' },
        status: { type: 'uint8', description: 'IERC-8312 Status enum: 0 None, 1 Active, 2 Completed, 3 Contested, 4 Revoked, 5 Expired.' },
      }),
      // Field-for-field mirror of KeelBoundedActions.Cursor.
      Cursor: tuple('The running aggregate state behind an envelope cursorRoot.', {
        spent: { type: 'uint256', description: 'Total amount drawn so far.' },
        draws: { type: 'uint256', description: 'Number of accepted draws.' },
        lastAdvance: { type: 'uint256', unit: 'seconds', description: 'Timestamp of the last accepted draw.' },
      }),
    },
    lookups: {
      getCursor: lookup('Read the cursorRoot of an envelope.', 'boundedActions', 'getCursor', 'bytes32'),
      getStatus: lookup('Read the effective lifecycle status of an envelope.', 'boundedActions', 'getStatus', 'uint8'),
      isActive: lookup('Whether an envelope is Active and not expired.', 'boundedActions', 'isActive', 'bool'),
    },
    calculations: {},
    intents: {
      grantBoundedSession: {
        description:
          'Register a bounded-action envelope for the principal and bind it to the account session so the hook charges its aggregate budget.',
        requiredInputs: ['principal', 'capabilityRoot', 'expiresAt', 'initData', 'sessionId'],
        steps: [
          {
            id: 1,
            action: 'buildTransaction',
            description: 'Register the ERC-8312 envelope on the substrate.',
            storeAs: 'envelopeId',
            contract: 'boundedActions',
            function: 'registerEnvelope',
            args: {
              principal: '{{principal}}',
              capabilityRoot: '{{capabilityRoot}}',
              expiresAt: '{{expiresAt}}',
              initData: '{{initData}}',
            },
          },
          {
            id: 2,
            action: 'buildTransaction',
            description: 'Bind the envelope to the session so the hook charges it on the execution path.',
            contract: 'policyHook',
            function: 'bindEnvelope',
            args: { sessionId: '{{sessionId}}', registry: '{{contracts.boundedActions.address}}', envelopeId: '{{envelopeId}}' },
          },
        ],
      },
      drawBoundedAction: {
        description: 'Draw once against an active envelope, advancing its cursor by the requested amount.',
        requiredInputs: ['envelopeId', 'amount', 'witness'],
        steps: [
          {
            id: 1,
            action: 'lookup',
            lookup: 'isActive',
            description: 'Fail fast unless the envelope is Active and unexpired.',
            storeAs: 'active',
          },
          {
            id: 2,
            action: 'buildTransaction',
            description: 'Advance the cursor by one accepted draw against the witness.',
            contract: 'boundedActions',
            function: 'advanceCursor',
            args: { id: '{{envelopeId}}', witness: '{{witness}}' },
          },
        ],
      },
      readEnvelope: {
        description: 'Read an envelope: its lifecycle status, cursor commitment and whether it is currently active.',
        requiredInputs: ['envelopeId'],
        steps: [
          { id: 1, action: 'lookup', lookup: 'getStatus', description: 'Read the effective status.', storeAs: 'status' },
          { id: 2, action: 'lookup', lookup: 'getCursor', description: 'Read the cursor commitment.', storeAs: 'cursor' },
          { id: 3, action: 'lookup', lookup: 'isActive', description: 'Read whether the envelope is active.', storeAs: 'active' },
        ],
      },
    },
    ui: {
      labels: {
        principal: 'Principal',
        capabilityRoot: 'Capability root',
        expiresAt: 'Expires at',
        envelopeId: 'Envelope',
        amount: 'Draw amount',
        status: 'Status',
        cursor: 'Cursor',
        active: 'Active',
      },
      intentDescriptions: {
        grantBoundedSession: 'Grant a bounded session for {{principal}} until {{expiresAt}}.',
        drawBoundedAction: 'Draw {{amount}} from envelope {{envelopeId}}.',
        readEnvelope: 'Read envelope {{envelopeId}}.',
      },
    },
    // Keel does not sign its own PIM: unsigned = Level 0 by construction.
    signatures: [],
  };
}

function tuple(description: string, fields: PimType['fields']): PimType {
  return { kind: 'tuple', description, fields };
}

function lookup(
  description: string,
  contract: string,
  fn: string,
  returns: string,
): PimLookup {
  return { description, contract, function: fn, args: { id: '{{envelopeId}}' }, returns };
}

function assertAddress(value: string, name: string): HexAddress {
  if (typeof value !== 'string' || !isAddress(value)) {
    throw new PimBuildError(`"${name}" must be a valid 20-byte hex address, got ${JSON.stringify(value)}`);
  }
  return value as HexAddress;
}
