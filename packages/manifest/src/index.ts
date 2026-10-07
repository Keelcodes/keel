/**
 * @keelcodes/manifest
 *
 * ERC-8313 Protocol Interaction Manifest (PIM) — the consumer side (validate an
 * untrusted manifest, grade its trust) and the producer side (emit Keel's own
 * PIM). Pure functions, no I/O: the same code runs in a wallet, an agent, an MCP
 * server or a CLI.
 *
 * Aligned with the draft of 2026-06-19 (author Paul Angus Bark, PR #1836). Where
 * the draft does not pin a field, this package says so rather than guessing —
 * see the README's "Unverified fields".
 *
 * @packageDocumentation
 */

export {
  CALCULATION_PRECISIONS,
  CONTRACT_ROLES,
  FILTER_OPERATORS,
  PIM_CATEGORIES,
  PIM_SECTIONS,
  SELECT_MODES,
  STEP_ACTIONS,
  TYPE_KINDS,
  VALIDATE_OPERATORS,
} from './types.js';
export type {
  CalculationPrecision,
  ContractRole,
  FilterOperator,
  Hex,
  HexAddress,
  Pim,
  PimCalculation,
  PimCategory,
  PimContract,
  PimField,
  PimIntent,
  PimIssue,
  PimLookup,
  PimMetadata,
  PimSection,
  PimSignature,
  PimStep,
  PimType,
  PimUi,
  PimValidateAssertion,
  SelectMode,
  SignatureType,
  StepAction,
  TypeKind,
  ValidateOperator,
} from './types.js';

export { PIM_DRAFT, validatePim } from './validate.js';
export type { PimValidationOptions, PimValidationResult } from './validate.js';

export { TRUST_LEVELS, canonicalPimJson, pimDigest, trustLevelOf } from './trust.js';
export type {
  SignatureRecovery,
  SignatureScheme,
  TrustInfo,
  TrustLevel,
  TrustLevelDefinition,
  TrustLevelName,
  TrustOptions,
} from './trust.js';

export { buildKeelPim } from './build.js';
export type { BuildKeelPimOptions } from './build.js';

export { PimBuildError } from './errors.js';
