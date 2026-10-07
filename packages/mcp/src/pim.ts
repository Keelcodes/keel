import { trustLevelOf, validatePim, type Pim } from '@keelcodes/manifest';
import { jsonResult, type JsonSchema, type McpTool, type ToolArgs } from './tools.js';

/**
 * ERC-8313 Protocol Interaction Manifest tools.
 *
 * A manifest is an *untrusted input*: it arrives as JSON from a dApp, a
 * registry or a peer agent. These tools let a model validate and summarise one
 * before it is ever acted on. Both are read-only and therefore ungated —
 * refusing to validate a manifest would only push the model to guess at its
 * shape, which is exactly the failure mode the PIM standard exists to remove.
 *
 * `pim` is passed inline as a parsed object (not a path): this package
 * deliberately has no `@types/node` dependency, so it never touches the
 * filesystem. A host that wants path input reads the file itself.
 */
export function createPimTools(): McpTool[] {
  const validate: McpTool = {
    name: 'pim_validate',
    title: 'Validate an ERC-8313 manifest',
    description:
      'Validate a Protocol Interaction Manifest (ERC-8313) against the nine mandatory sections and their rules. Returns { valid, errors, warnings }. Read-only and never gated.',
    inputSchema: PIM_SCHEMA,
    run: (args: ToolArgs) => {
      const pim = requirePim(args);
      return jsonResult(validatePim(pim, executionContext(args)));
    },
  };

  const inspect: McpTool = {
    name: 'pim_inspect',
    title: 'Inspect an ERC-8313 manifest',
    description:
      'Summarise a Protocol Interaction Manifest: protocol identity, chains, intents, contracts and the assigned trust level (ERC-8313 Levels 0-3). Read-only and never gated.',
    inputSchema: PIM_SCHEMA,
    run: async (args: ToolArgs) => {
      const pim = requirePim(args) as Pim;
      const result = validatePim(pim, executionContext(args));
      const trust = await trustLevelOf(pim);
      const metadata = pim.metadata;
      return jsonResult({
        valid: result.valid,
        protocol: metadata.protocol,
        category: metadata.category,
        pimVersion: metadata.pimVersion,
        chainId: metadata.chainId,
        contracts: describeContracts(pim),
        intents: describeIntents(pim),
        trustLevel: {
          level: trust.level,
          name: trust.name,
          verified: trust.verified,
          reason: trust.reason,
          ...(trust.signer !== undefined ? { signer: trust.signer } : {}),
          ...(trust.signerLabel !== undefined ? { signerLabel: trust.signerLabel } : {}),
        },
        errors: result.errors,
        warnings: result.warnings,
      });
    },
  };

  return [validate, inspect];
}

const PIM_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    pim: { type: 'object', description: 'A parsed ERC-8313 Protocol Interaction Manifest.' },
    chainId: {
      type: 'number',
      description: 'Optional network id; a manifest whose metadata.chainId excludes it fails validation.',
    },
    now: {
      type: 'number',
      description: 'Optional unix time in seconds; enables the validFrom/validUntil checks.',
    },
  },
  required: ['pim'],
  additionalProperties: false,
};

function describeContracts(pim: Pim): Array<Record<string, unknown>> {
  return Object.entries(pim.contracts ?? {}).map(([name, contract]) => ({
    name,
    role: contract.role,
    ...(contract.address !== undefined ? { address: contract.address } : {}),
    ...(contract.lookup !== undefined ? { lookup: contract.lookup } : {}),
  }));
}

function describeIntents(pim: Pim): Array<Record<string, unknown>> {
  return Object.entries(pim.intents ?? {}).map(([name, intent]) => ({
    name,
    description: intent.description,
    requiredInputs: intent.requiredInputs,
  }));
}

function executionContext(args: ToolArgs): { now?: number; chainId?: number } {
  const options: { now?: number; chainId?: number } = {};
  if (typeof args.now === 'number') options.now = args.now;
  if (typeof args.chainId === 'number') options.chainId = args.chainId;
  return options;
}

function requirePim(args: ToolArgs): unknown {
  const pim = args.pim;
  if (!isObject(pim)) throw new Error('"pim" is required and must be a parsed PIM object');
  return pim;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
