// ============================================================================
// ERC-8313 Protocol Interaction Manifest (PIM) — TypeScript model.
//
// A PIM is a machine-readable JSON document describing *how* to interact with a
// smart-contract protocol: not just its ABI, but the ordered workflow that
// fulfils a user intent. This module mirrors the nine mandatory top-level
// objects one-to-one, using the field names of the standard verbatim so a
// serialised `Pim` is valid by construction.
//
// Aligned with the draft of 2026-06-19 (author Paul Angus Bark, PR #1836).
// Field-level citations live next to each interface; where the draft is silent
// or contradictory the comment says so explicitly rather than guessing.
// ============================================================================

/** Ethereum address in lowercase or EIP-55 checksummed `0x` hex. */
export type HexAddress = `0x${string}`;

/** `0x`-prefixed hex string (any even byte length). */
export type Hex = `0x${string}`;

/** Protocol category, closed set per the `metadata.category` enum. */
export type PimCategory =
  | 'dex'
  | 'lending'
  | 'staking'
  | 'bridge'
  | 'vault'
  | 'nft'
  | 'governance'
  | 'other';

/** Functional role of a contract, closed set per the `contracts.*.role` enum. */
export type ContractRole =
  | 'router'
  | 'factory'
  | 'pool'
  | 'quoter'
  | 'registry'
  | 'gateway'
  | 'oracle'
  | 'vault'
  | 'token'
  | 'other';

/** Shape of a named `types` entry, per the "Tuple kinds" table. */
export type TypeKind = 'tuple' | 'array' | 'primitive';

/** `lookups.*.select` — reduction applied to a filtered result set. */
export type SelectMode = 'all' | 'max' | 'min';

/** Operators allowed inside `lookups.*.filter`. */
export type FilterOperator = 'notEqual' | 'greaterThan' | 'lessThan' | 'equals';

/** Operators allowed inside a `lookups.*.validate` assertion. */
export type ValidateOperator = 'notEqual' | 'equals' | 'greaterThan' | 'lessThan';

/** Numeric kind of a `calculations.*` result. */
export type CalculationPrecision = 'float' | 'integer';

/** The three step actions an intent can declare. */
export type StepAction = 'lookup' | 'calculate' | 'buildTransaction';

/** Signature schemes the standard names today ("ecdsa"; fips-204/205 are future). */
export type SignatureType = string;

/**
 * `metadata` — protocol identity, chain scope and validity window.
 *
 * `validFrom`, `validUntil` and `notes` are OPTIONAL at the schema level (the
 * standard RECOMMENDs the two timestamps); every other field is REQUIRED.
 */
export interface PimMetadata {
  protocol: string;
  description: string;
  category: PimCategory;
  website: string;
  author: string;
  chainId: number[];
  pimVersion: string;
  validFrom?: number;
  validUntil?: number;
  notes?: string;
}

/**
 * One entry in `contracts`.
 *
 * Exactly one of `address` / `lookup` MUST be present (the standard forbids
 * having both). `role` and `description` are REQUIRED.
 */
export interface PimContract {
  address?: HexAddress;
  /** Logical name of a `lookups` entry that resolves the contract address. */
  lookup?: string;
  role: ContractRole;
  description: string;
}

/** A field inside a named `types` entry. */
export interface PimField {
  type: string;
  description?: string;
  unit?: string;
}

/** One entry in `types` — a Solidity-struct-shaped tuple or array. */
export interface PimType {
  kind: TypeKind;
  description?: string;
  fields: Record<string, PimField>;
}

/**
 * One field-level assertion inside `lookups.*.validate`.
 *
 * By convention at least one operator MUST be present; operator values MUST be
 * strings.
 */
export interface PimValidateAssertion {
  field: string;
  notEqual?: string;
  equals?: string;
  greaterThan?: string;
  lessThan?: string;
}

/** One entry in `lookups` — a named on-chain read (or simulated write). */
export interface PimLookup {
  description: string;
  /** Logical contract name; MUST match a key in `contracts`. */
  contract: string;
  function: string;
  /** Literal values, `{{template}}` references, or iterate values. */
  args: unknown;
  /** Named type (from `types`) or Solidity base unit type. */
  returns: string;
  iterate?: Record<string, unknown>;
  filter?: Partial<Record<FilterOperator, string>>;
  select?: SelectMode;
  selectCriterion?: string;
  validate?: PimValidateAssertion[];
}

/** One entry in `calculations` — a named off-chain computation. */
export interface PimCalculation {
  description: string;
  /** Instruction object chain; MUST contain a `set` instruction. */
  formula: Record<string, unknown>;
  inputs?: string[];
  outputUnit?: string;
  precision?: CalculationPrecision;
}

/**
 * One step inside an intent's ordering.
 *
 * Fields are shared by all actions except the `buildTransaction`-only ones
 * (`contract`, `function`, `args`, `value`), which are optional on the type and
 * validated contextually.
 */
export interface PimStep {
  /** Unique within the intent; MUST start at 1 and not skip. */
  id: number;
  action: StepAction;
  description?: string;
  condition?: string;
  skipIf?: string;
  storeAs?: string;
  /** `buildTransaction` only — logical contract name from `contracts`. */
  contract?: string;
  /** `buildTransaction` only. */
  function?: string;
  /** `buildTransaction` only — map of parameter name to value/template. */
  args?: Record<string, unknown>;
  /** `buildTransaction` only — wei sent with the call. */
  value?: string;
  /**
   * `lookup` only — the named lookup this step runs.
   *
   * NOTE (unverified): the draft says lookups "are referenced by name in intent
   * steps" but its all-step-types field table does not name the field. We use
   * `lookup` to mirror the action; the validator only warns on a dangling name,
   * it never rejects for it. See the README's "Unverified fields".
   */
  lookup?: string;
}

/** One entry in `intents` — a named, executable workflow. */
export interface PimIntent {
  description: string;
  requiredInputs: string[];
  optionalInputs?: string[];
  notes?: string;
  steps: PimStep[];
}

/**
 * `ui` — display strings for wallets and agent interfaces.
 *
 * `intentDescriptions` is REQUIRED and MUST cover every named intent; `labels`
 * and `iterateLabels` are RECOMMENDED/OPTIONAL.
 */
export interface PimUi {
  labels?: Record<string, string>;
  intentDescriptions: Record<string, string>;
  iterateLabels?: Record<string, unknown>;
}

/** One entry in `signatures`. */
export interface PimSignature {
  /** Ethereum address that produced the signature; MUST be present for ecdsa. */
  signer?: HexAddress;
  /** keccak256 of the public key, for schemes with large keys (future). */
  signerHashed?: Hex;
  type: SignatureType;
  signature: Hex;
  signerLabel?: string;
}

/**
 * One diagnostic emitted by {@link validatePim}. `path` is a dotted/bracketed
 * locator into the document (empty for the root). An `error` MUST block
 * execution; a `warning` MUST be surfaced but does not.
 */
export interface PimIssue {
  path: string;
  message: string;
  severity: 'error' | 'warning';
}

/** A complete ERC-8313 Protocol Interaction Manifest. */
export interface Pim {
  schemaVersion: string;
  metadata: PimMetadata;
  contracts: Record<string, PimContract>;
  types: Record<string, PimType>;
  lookups: Record<string, PimLookup>;
  calculations: Record<string, PimCalculation>;
  intents: Record<string, PimIntent>;
  ui: PimUi;
  signatures: PimSignature[];
}

/** The nine mandatory top-level sections, in the standard's own order. */
export const PIM_SECTIONS = [
  'schemaVersion',
  'metadata',
  'contracts',
  'types',
  'lookups',
  'calculations',
  'intents',
  'ui',
  'signatures',
] as const;

export type PimSection = (typeof PIM_SECTIONS)[number];

/** Allowed values for `metadata.category`. */
export const PIM_CATEGORIES: readonly PimCategory[] = [
  'dex',
  'lending',
  'staking',
  'bridge',
  'vault',
  'nft',
  'governance',
  'other',
];

/** Allowed values for `contracts.*.role`. */
export const CONTRACT_ROLES: readonly ContractRole[] = [
  'router',
  'factory',
  'pool',
  'quoter',
  'registry',
  'gateway',
  'oracle',
  'vault',
  'token',
  'other',
];

/** Allowed values for `types.*.kind`. */
export const TYPE_KINDS: readonly TypeKind[] = ['tuple', 'array', 'primitive'];

/** Allowed values for `lookups.*.select`. */
export const SELECT_MODES: readonly SelectMode[] = ['all', 'max', 'min'];

/** Allowed operators for `lookups.*.filter`. */
export const FILTER_OPERATORS: readonly FilterOperator[] = [
  'notEqual',
  'greaterThan',
  'lessThan',
  'equals',
];

/** Allowed operators for a `lookups.*.validate` assertion. */
export const VALIDATE_OPERATORS: readonly ValidateOperator[] = [
  'notEqual',
  'equals',
  'greaterThan',
  'lessThan',
];

/** Allowed values for `calculations.*.precision`. */
export const CALCULATION_PRECISIONS: readonly CalculationPrecision[] = ['float', 'integer'];

/** Allowed values for a step's `action`. */
export const STEP_ACTIONS: readonly StepAction[] = ['lookup', 'calculate', 'buildTransaction'];
