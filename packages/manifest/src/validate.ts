// ============================================================================
// ERC-8313 PIM validator.
//
// A structural + semantic check of an untrusted JSON document against the
// draft of 2026-06-19. It is deliberately a *pure function of the input*: no
// network, no clock unless the caller passes `options.now`, so a wallet can run
// it on a manifest fetched from anywhere before touching an account.
//
// The result separates `errors` (the manifest MUST be rejected) from
// `warnings` (the manifest is usable but suspicious). `valid` is true only when
// there are no errors. Where the draft is silent we do NOT invent a rule: those
// fields get existence/type checks at most, so the validator never false-
// positives on a spec-compliant manifest.
// ============================================================================

import {
  CALCULATION_PRECISIONS,
  CONTRACT_ROLES,
  FILTER_OPERATORS,
  PIM_CATEGORIES,
  PIM_SECTIONS,
  SELECT_MODES,
  STEP_ACTIONS,
  TYPE_KINDS,
  VALIDATE_OPERATORS,
  type PimIssue,
} from './types.js';

export type { PimIssue } from './types.js';

/** The spec revision this validator was written against. */
export const PIM_DRAFT = '2026-06-19';

export interface PimValidationOptions {
  /**
   * Current unix time (seconds). When provided, an expired `validUntil` or a
   * not-yet-reached `validFrom` is an error — the standard says execution
   * engines MUST reject such manifests.
   */
  now?: number;
  /**
   * The network the execution engine is on. When provided and absent from
   * `metadata.chainId`, it is an error (chain mismatch).
   */
  chainId?: number;
}

export interface PimValidationResult {
  valid: boolean;
  /** Issues that MUST block execution. */
  errors: PimIssue[];
  /** Issues that do not block execution but should be surfaced. */
  warnings: PimIssue[];
}

class Issues {
  readonly errors: PimIssue[] = [];
  readonly warnings: PimIssue[] = [];

  error(path: string, message: string): void {
    this.errors.push({ path, message, severity: 'error' });
  }

  warn(path: string, message: string): void {
    this.warnings.push({ path, message, severity: 'warning' });
  }
}

/**
 * Validate an untrusted value as an ERC-8313 PIM.
 *
 * @param input - parsed JSON (or any value) to check.
 * @param options - optional execution context (clock, chain).
 */
export function validatePim(input: unknown, options: PimValidationOptions = {}): PimValidationResult {
  const issues = new Issues();

  if (!isObject(input)) {
    issues.error('', 'PIM must be a JSON object');
    return finish(issues);
  }

  const root = input as Record<string, unknown>;

  checkTopLevelSections(root, issues);
  if (!isObject(root.metadata)) {
    // Without metadata almost nothing else can be resolved; report and stop.
    return finish(issues);
  }

  const contractNames = namesOf(root.contracts);
  const lookupNames = namesOf(root.lookups);
  const typeNames = namesOf(root.types);
  const intentNames = namesOf(root.intents);

  const metadata = checkMetadata(root.metadata, issues);
  checkContracts(root.contracts, lookupNames, issues);
  checkTypes(root.types, typeNames, issues);
  checkLookups(root.lookups, contractNames, issues);
  checkCalculations(root.calculations, issues);
  checkIntents(root.intents, contractNames, lookupNames, issues);
  checkUi(root.ui, intentNames, issues);
  checkSignatures(root.signatures, issues);
  checkSemantics(metadata, options, issues);

  return finish(issues);
}

function finish(issues: Issues): PimValidationResult {
  return { valid: issues.errors.length === 0, errors: issues.errors, warnings: issues.warnings };
}

// ---------------------------------------------------------------------------
// top-level sections
// ---------------------------------------------------------------------------

function checkTopLevelSections(root: Record<string, unknown>, issues: Issues): void {
  const expectedKind: Record<string, 'string' | 'object' | 'array'> = {
    schemaVersion: 'string',
    metadata: 'object',
    contracts: 'object',
    types: 'object',
    lookups: 'object',
    calculations: 'object',
    intents: 'object',
    ui: 'object',
    signatures: 'array',
  };

  for (const section of PIM_SECTIONS) {
    const value = root[section];
    if (value === undefined) {
      issues.error(section, `missing required top-level section "${section}"`);
      continue;
    }
    const kind = expectedKind[section];
    if (kind === 'string' && typeof value !== 'string') {
      issues.error(section, `"${section}" must be a string`);
    } else if (kind === 'array' && !Array.isArray(value)) {
      issues.error(section, `"${section}" must be an array`);
    } else if (kind === 'object' && !isObject(value)) {
      issues.error(section, `"${section}" must be an object`);
    }
  }
}

// ---------------------------------------------------------------------------
// metadata
// ---------------------------------------------------------------------------

function checkMetadata(value: Record<string, unknown>, issues: Issues): Record<string, unknown> {
  const path = 'metadata';
  requireString(value, 'protocol', path, issues);
  requireString(value, 'description', path, issues);
  requireString(value, 'website', path, issues);
  requireString(value, 'author', path, issues);

  if (typeof value.category !== 'string') {
    issues.error(`${path}.category`, 'category is required and must be a string');
  } else if (!(PIM_CATEGORIES as readonly string[]).includes(value.category)) {
    issues.error(`${path}.category`, `category must be one of ${PIM_CATEGORIES.join(', ')}`);
  }

  if (typeof value.pimVersion !== 'string') {
    issues.error(`${path}.pimVersion`, 'pimVersion is required and must be a string');
  } else if (!isSemver(value.pimVersion)) {
    issues.error(`${path}.pimVersion`, `pimVersion must be semver (major.minor.patch), got "${value.pimVersion}"`);
  }

  if (!Array.isArray(value.chainId)) {
    issues.error(`${path}.chainId`, 'chainId is required and must be an array of numbers');
  } else if (value.chainId.length === 0) {
    issues.error(`${path}.chainId`, 'chainId must not be empty');
  } else {
    value.chainId.forEach((id, i) => {
      if (!isInteger(id) || id <= 0) issues.error(`${path}.chainId[${i}]`, 'chainId entries must be positive integers');
    });
  }

  for (const ts of ['validFrom', 'validUntil'] as const) {
    const v = value[ts];
    if (v !== undefined && typeof v !== 'number') issues.error(`${path}.${ts}`, `${ts} must be a number`);
  }
  if (value.notes !== undefined && typeof value.notes !== 'string') {
    issues.error(`${path}.notes`, 'notes must be a string');
  }
  if (
    typeof value.validFrom === 'number' &&
    typeof value.validUntil === 'number' &&
    value.validFrom > value.validUntil
  ) {
    issues.error(`${path}.validUntil`, 'validUntil must not precede validFrom');
  }

  return value;
}

// ---------------------------------------------------------------------------
// contracts
// ---------------------------------------------------------------------------

function checkContracts(value: unknown, lookupNames: Set<string>, issues: Issues): void {
  if (!isObject(value)) return;
  for (const [name, entry] of Object.entries(value)) {
    const path = `contracts.${name}`;
    if (!isObject(entry)) {
      issues.error(path, 'contract entry must be an object');
      continue;
    }

    const hasAddress = entry.address !== undefined;
    const hasLookup = entry.lookup !== undefined;
    if (hasAddress && hasLookup) {
      issues.error(path, 'a contract MUST NOT declare both "address" and "lookup"');
    } else if (!hasAddress && !hasLookup) {
      issues.error(path, 'a contract MUST declare either "address" or "lookup"');
    }

    if (hasAddress && !isHexAddress(entry.address)) {
      issues.error(`${path}.address`, 'address must be a 20-byte 0x-prefixed hex string');
    }
    if (hasLookup) {
      if (typeof entry.lookup !== 'string') {
        issues.error(`${path}.lookup`, 'lookup must be a string');
      } else if (!lookupNames.has(entry.lookup)) {
        issues.error(`${path}.lookup`, `lookup "${entry.lookup}" does not match any entry in the lookups section`);
      }
    }

    if (typeof entry.role !== 'string') {
      issues.error(`${path}.role`, 'role is required and must be a string');
    } else if (!(CONTRACT_ROLES as readonly string[]).includes(entry.role)) {
      issues.error(`${path}.role`, `role must be one of ${CONTRACT_ROLES.join(', ')}`);
    }
    requireString(entry, 'description', path, issues);
  }
}

// ---------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------

function checkTypes(value: unknown, typeNames: Set<string>, issues: Issues): void {
  if (!isObject(value)) return;
  void typeNames;
  for (const [name, entry] of Object.entries(value)) {
    const path = `types.${name}`;
    if (!isObject(entry)) {
      issues.error(path, 'type entry must be an object');
      continue;
    }
    if (typeof entry.kind !== 'string') {
      issues.error(`${path}.kind`, 'kind is required and must be a string');
    } else if (!(TYPE_KINDS as readonly string[]).includes(entry.kind)) {
      issues.error(`${path}.kind`, `kind must be one of ${TYPE_KINDS.join(', ')}`);
    }
    if (entry.description !== undefined && typeof entry.description !== 'string') {
      issues.error(`${path}.description`, 'description must be a string');
    }
    if (!isObject(entry.fields)) {
      issues.error(`${path}.fields`, 'fields is required and must be an object');
      continue;
    }
    for (const [fieldName, field] of Object.entries(entry.fields)) {
      const fieldPath = `${path}.fields.${fieldName}`;
      if (!isObject(field)) {
        issues.error(fieldPath, 'field definition must be an object');
        continue;
      }
      if (typeof field.type !== 'string') issues.error(`${fieldPath}.type`, 'field "type" is required');
      if (field.description !== undefined && typeof field.description !== 'string') {
        issues.error(`${fieldPath}.description`, 'description must be a string');
      }
      if (field.unit !== undefined && typeof field.unit !== 'string') {
        issues.error(`${fieldPath}.unit`, 'unit must be a string');
      }
    }
  }
}

// ---------------------------------------------------------------------------
// lookups
// ---------------------------------------------------------------------------

function checkLookups(value: unknown, contractNames: Set<string>, issues: Issues): void {
  if (!isObject(value)) return;
  for (const [name, entry] of Object.entries(value)) {
    const path = `lookups.${name}`;
    if (!isObject(entry)) {
      issues.error(path, 'lookup entry must be an object');
      continue;
    }

    requireString(entry, 'description', path, issues);
    if (typeof entry.contract !== 'string') {
      issues.error(`${path}.contract`, 'contract is required and must be a string');
    } else if (!contractNames.has(entry.contract)) {
      issues.error(`${path}.contract`, `contract "${entry.contract}" does not match any entry in the contracts section`);
    }
    requireString(entry, 'function', path, issues);
    if (!('args' in entry)) {
      issues.error(`${path}.args`, 'args is required (array or object)');
    } else if (!Array.isArray(entry.args) && !isObject(entry.args)) {
      issues.error(`${path}.args`, 'args must be an array or an object');
    }
    requireString(entry, 'returns', path, issues);

    if (entry.iterate !== undefined && !isObject(entry.iterate)) {
      issues.error(`${path}.iterate`, 'iterate must be an object');
    }

    if (entry.filter !== undefined) {
      if (!isObject(entry.filter)) {
        issues.error(`${path}.filter`, 'filter must be an object');
      } else {
        for (const [op, operand] of Object.entries(entry.filter)) {
          if (!(FILTER_OPERATORS as readonly string[]).includes(op)) {
            issues.error(`${path}.filter.${op}`, `filter operator must be one of ${FILTER_OPERATORS.join(', ')}`);
          }
          if (typeof operand !== 'string') issues.error(`${path}.filter.${op}`, 'filter operands must be strings');
        }
      }
    }

    if (entry.select !== undefined) {
      if (typeof entry.select !== 'string' || !(SELECT_MODES as readonly string[]).includes(entry.select)) {
        issues.error(`${path}.select`, `select must be one of ${SELECT_MODES.join(', ')}`);
      }
    }
    if (entry.selectCriterion !== undefined) {
      if (typeof entry.selectCriterion !== 'string') {
        issues.error(`${path}.selectCriterion`, 'selectCriterion must be a string');
      }
      if (entry.select === undefined) {
        issues.error(`${path}.selectCriterion`, 'selectCriterion MUST NOT be used when select is absent');
      }
    }

    if (entry.validate !== undefined) checkLookupValidate(entry.validate, `${path}.validate`, issues);
  }
}

function checkLookupValidate(value: unknown, path: string, issues: Issues): void {
  if (!Array.isArray(value)) {
    issues.error(path, 'validate must be an array');
    return;
  }
  value.forEach((assertion, i) => {
    const p = `${path}[${i}]`;
    if (!isObject(assertion)) {
      issues.error(p, 'validate assertion must be an object');
      return;
    }
    if (typeof assertion.field !== 'string') issues.error(`${p}.field`, 'field is required and must be a string');

    const present = VALIDATE_OPERATORS.filter((op) => assertion[op] !== undefined);
    if (present.length === 0) {
      issues.error(p, `validate assertion MUST include at least one of ${VALIDATE_OPERATORS.join(', ')}`);
    }
    for (const op of present) {
      if (typeof assertion[op] !== 'string') issues.error(`${p}.${op}`, `validate operand "${op}" must be a string`);
    }
  });
}

// ---------------------------------------------------------------------------
// calculations
// ---------------------------------------------------------------------------

function checkCalculations(value: unknown, issues: Issues): void {
  if (!isObject(value)) return;
  for (const [name, entry] of Object.entries(value)) {
    const path = `calculations.${name}`;
    if (!isObject(entry)) {
      issues.error(path, 'calculation entry must be an object');
      continue;
    }
    requireString(entry, 'description', path, issues);

    if (!isObject(entry.formula)) {
      issues.error(`${path}.formula`, 'formula is required and must be an instruction object');
    } else if (!('set' in entry.formula)) {
      issues.error(`${path}.formula`, 'formula MUST include a "set" instruction');
    }

    if (entry.inputs !== undefined) {
      if (!Array.isArray(entry.inputs) || entry.inputs.some((v) => typeof v !== 'string')) {
        issues.error(`${path}.inputs`, 'inputs must be an array of strings');
      }
    }
    if (entry.outputUnit !== undefined && typeof entry.outputUnit !== 'string') {
      issues.error(`${path}.outputUnit`, 'outputUnit must be a string');
    }
    if (entry.precision !== undefined) {
      if (
        typeof entry.precision !== 'string' ||
        !(CALCULATION_PRECISIONS as readonly string[]).includes(entry.precision)
      ) {
        issues.error(`${path}.precision`, `precision must be one of ${CALCULATION_PRECISIONS.join(', ')}`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// intents
// ---------------------------------------------------------------------------

function checkIntents(
  value: unknown,
  contractNames: Set<string>,
  lookupNames: Set<string>,
  issues: Issues,
): void {
  if (!isObject(value)) return;
  const names = Object.keys(value);
  if (names.length === 0) {
    issues.error('intents', 'a PIM MUST contain at least one intent');
    return;
  }

  for (const [name, entry] of Object.entries(value)) {
    const path = `intents.${name}`;
    if (!isObject(entry)) {
      issues.error(path, 'intent entry must be an object');
      continue;
    }
    requireString(entry, 'description', path, issues);

    if (!Array.isArray(entry.requiredInputs) || entry.requiredInputs.some((v) => typeof v !== 'string')) {
      issues.error(`${path}.requiredInputs`, 'requiredInputs is required and must be an array of strings');
    }
    if (entry.optionalInputs !== undefined) {
      if (!Array.isArray(entry.optionalInputs) || entry.optionalInputs.some((v) => typeof v !== 'string')) {
        issues.error(`${path}.optionalInputs`, 'optionalInputs must be an array of strings');
      }
    }
    if (entry.notes !== undefined && typeof entry.notes !== 'string') {
      issues.error(`${path}.notes`, 'notes must be a string');
    }

    checkSteps(entry.steps, `${path}.steps`, contractNames, lookupNames, issues);
  }
}

function checkSteps(
  value: unknown,
  path: string,
  contractNames: Set<string>,
  lookupNames: Set<string>,
  issues: Issues,
): void {
  const entries = stepEntries(value);
  if (entries === undefined) {
    issues.error(path, 'steps is required and must be an array or an object keyed by step id');
    return;
  }
  if (entries.length === 0) {
    issues.error(path, 'an intent MUST declare at least one step');
    return;
  }

  const ids: number[] = [];
  entries.forEach((step, i) => {
    const p = `${path}[${i}]`;
    if (!isObject(step)) {
      issues.error(p, 'step must be an object');
      return;
    }

    if (!isInteger(step.id) || step.id < 1) {
      issues.error(`${p}.id`, 'step id is required and must be an integer starting at 1');
    } else {
      ids.push(step.id);
    }

    const action = step.action;
    if (typeof action !== 'string' || !(STEP_ACTIONS as readonly string[]).includes(action)) {
      issues.error(`${p}.action`, `action must be one of ${STEP_ACTIONS.join(', ')}`);
      return;
    }

    for (const field of ['description', 'condition', 'skipIf', 'storeAs'] as const) {
      if (step[field] !== undefined && typeof step[field] !== 'string') {
        issues.error(`${p}.${field}`, `${field} must be a string`);
      }
    }

    if (action === 'buildTransaction') {
      if (typeof step.contract !== 'string') {
        issues.error(`${p}.contract`, 'buildTransaction requires "contract"');
      } else if (!contractNames.has(step.contract)) {
        issues.error(`${p}.contract`, `contract "${step.contract}" does not match any entry in the contracts section`);
      }
      if (typeof step.function !== 'string') issues.error(`${p}.function`, 'buildTransaction requires "function"');
      if (typeof step.description !== 'string') {
        issues.error(`${p}.description`, 'buildTransaction steps MUST include a description');
      }
      if (step.args !== undefined && !isObject(step.args)) {
        issues.error(`${p}.args`, 'buildTransaction args must be an object');
      }
      if (step.value !== undefined && typeof step.value !== 'string') {
        issues.error(`${p}.value`, 'value must be a string');
      }
    }

    // The draft says lookup steps reference a lookup "by name" but does not fix
    // the field. We accept a `lookup` string and only warn when it dangles, so a
    // differently-named (but spec-compliant) field is never a false error.
    if (action === 'lookup' && step.lookup !== undefined) {
      if (typeof step.lookup !== 'string') {
        issues.error(`${p}.lookup`, 'lookup reference must be a string');
      } else if (!lookupNames.has(step.lookup)) {
        issues.warn(`${p}.lookup`, `lookup "${step.lookup}" does not match any entry in the lookups section`);
      }
    }
  });

  const unique = new Set(ids);
  if (unique.size !== ids.length) {
    issues.error(path, 'step ids MUST be unique within an intent');
  }
  const sorted = [...unique].sort((a, b) => a - b);
  const contiguous = sorted.every((id, i) => id === i + 1);
  if (sorted.length > 0 && !contiguous) {
    issues.error(path, `step ids MUST begin at 1 and MUST NOT skip numbers (got ${sorted.join(', ')})`);
  }
}

function stepEntries(value: unknown): unknown[] | undefined {
  if (Array.isArray(value)) return [...value];
  if (isObject(value)) return Object.values(value);
  return undefined;
}

// ---------------------------------------------------------------------------
// ui
// ---------------------------------------------------------------------------

function checkUi(value: unknown, intentNames: Set<string>, issues: Issues): void {
  if (!isObject(value)) return;
  const path = 'ui';

  if (!isObject(value.intentDescriptions)) {
    issues.error(`${path}.intentDescriptions`, 'intentDescriptions is required and must be an object');
  } else {
    for (const [name, text] of Object.entries(value.intentDescriptions)) {
      if (typeof text !== 'string') issues.error(`${path}.intentDescriptions.${name}`, 'description must be a string');
    }
    for (const intent of intentNames) {
      if (!(intent in value.intentDescriptions)) {
        issues.error(`${path}.intentDescriptions`, `missing a description for intent "${intent}"`);
      }
    }
  }

  if (value.labels !== undefined) {
    if (!isObject(value.labels) || Object.values(value.labels).some((v) => typeof v !== 'string')) {
      issues.error(`${path}.labels`, 'labels must be an object of strings');
    }
  }
  if (value.iterateLabels !== undefined && !isObject(value.iterateLabels)) {
    issues.error(`${path}.iterateLabels`, 'iterateLabels must be an object');
  }
}

// ---------------------------------------------------------------------------
// signatures
// ---------------------------------------------------------------------------

function checkSignatures(value: unknown, issues: Issues): void {
  if (!Array.isArray(value)) return;
  value.forEach((entry, i) => {
    const path = `signatures[${i}]`;
    if (!isObject(entry)) {
      issues.error(path, 'signature entry must be an object');
      return;
    }

    if (typeof entry.type !== 'string') {
      issues.error(`${path}.type`, 'type is required and must be a string');
    } else if (entry.type !== 'ecdsa') {
      issues.warn(`${path}.type`, `unrecognised signature scheme "${entry.type}"; the trust resolver will treat it as unverified`);
    }

    if (!isHexBytes(entry.signature)) {
      issues.error(`${path}.signature`, 'signature is required and must be 0x-prefixed hex bytes');
    }

    if (entry.signer === undefined && entry.signerHashed === undefined) {
      issues.error(path, 'a signature entry MUST include either "signer" or "signerHashed"');
    }
    if (entry.signer !== undefined) {
      if (!isHexAddress(entry.signer)) {
        issues.error(`${path}.signer`, 'signer must be a 20-byte 0x-prefixed hex address');
      }
    } else if (entry.type === 'ecdsa') {
      issues.error(`${path}.signer`, 'an ecdsa signature MUST include "signer"');
    }
    if (entry.signerHashed !== undefined && !isBytes32(entry.signerHashed)) {
      issues.error(`${path}.signerHashed`, 'signerHashed must be a 32-byte 0x-prefixed hex string');
    }
    if (entry.signerLabel !== undefined && typeof entry.signerLabel !== 'string') {
      issues.error(`${path}.signerLabel`, 'signerLabel must be a string');
    }
  });
}

// ---------------------------------------------------------------------------
// semantic gates (clock / chain)
// ---------------------------------------------------------------------------

function checkSemantics(
  metadata: Record<string, unknown>,
  options: PimValidationOptions,
  issues: Issues,
): void {
  if (options.now !== undefined) {
    if (typeof metadata.validUntil === 'number' && metadata.validUntil < options.now) {
      issues.error('metadata.validUntil', `PIM expired at ${metadata.validUntil} (now ${options.now})`);
    }
    if (typeof metadata.validFrom === 'number' && metadata.validFrom > options.now) {
      issues.error('metadata.validFrom', `PIM is not valid until ${metadata.validFrom} (now ${options.now})`);
    }
  }

  if (options.chainId !== undefined) {
    const chains = Array.isArray(metadata.chainId) ? metadata.chainId : [];
    if (!chains.includes(options.chainId)) {
      issues.error(
        'metadata.chainId',
        `chainId ${options.chainId} is not in the PIM's chain scope [${chains.join(', ')}]`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

function requireString(
  holder: Record<string, unknown>,
  field: string,
  path: string,
  issues: Issues,
): void {
  if (typeof holder[field] !== 'string' || holder[field] === '') {
    issues.error(`${path}.${field}`, `${field} is required and must be a non-empty string`);
  }
}

function namesOf(value: unknown): Set<string> {
  return isObject(value) ? new Set(Object.keys(value)) : new Set();
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

function isHexAddress(value: unknown): boolean {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value);
}

function isHexBytes(value: unknown): boolean {
  return typeof value === 'string' && /^0x(?:[0-9a-fA-F]{2})*$/.test(value) && value.length > 2;
}

function isBytes32(value: unknown): boolean {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);
}

function isSemver(value: string): boolean {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value);
}
