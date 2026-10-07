import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { buildKeelPim, canonicalPimJson, pimDigest, trustLevelOf } from './index.js';
import { PimBuildError } from './errors.js';
import { validatePim } from './validate.js';
import type { Pim } from './types.js';

const POLICY_HOOK = '0x1111111111111111111111111111111111111111';
const BOUNDED_ACTIONS = '0x2222222222222222222222222222222222222222';

// A PIM that is valid by construction: Keel's own manifest.
const base = (): Pim => buildKeelPim({ policyHook: POLICY_HOOK, boundedActions: BOUNDED_ACTIONS });

// Test-only mutable view; the validator takes `unknown` so this is safe to poke.
type Mutable = Record<string, any>;
const mutate = (fn: (pim: Mutable) => void): Pim => {
  const pim = structuredClone(base()) as Mutable;
  fn(pim);
  return pim as Pim;
};

const errorPaths = (pim: unknown, options?: Parameters<typeof validatePim>[1]): string[] =>
  validatePim(pim, options).errors.map((issue) => issue.path);

describe('validatePim — happy path', () => {
  it('accepts a valid PIM with no errors', () => {
    const result = validatePim(base());
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('reports a chain ID that is out of scope', () => {
    const pim = mutate((p) => {
      p.metadata.chainId = [1];
    });
    expect(errorPaths(pim, { chainId: 8453 })).toContain('metadata.chainId');
    expect(validatePim(pim, { chainId: 1 }).valid).toBe(true);
  });

  it('rejects an expired PIM when a clock is supplied', () => {
    const pim = mutate((p) => {
      p.metadata.validUntil = 1_000;
    });
    const result = validatePim(pim, { now: 2_000 });
    expect(result.errors.map((i) => i.message).join(' ')).toContain('expired');
  });

  it('rejects a PIM used before validFrom', () => {
    const pim = mutate((p) => {
      p.metadata.validFrom = 5_000;
    });
    expect(errorPaths(pim, { now: 1_000 })).toContain('metadata.validFrom');
  });
});

describe('validatePim — top-level sections', () => {
  it('rejects a non-object', () => {
    expect(validatePim('nope').errors[0]?.message).toContain('must be a JSON object');
  });

  it('reports every missing required section', () => {
    const pim = mutate((p) => {
      delete p.contracts;
      delete p.intents;
      delete p.signatures;
    });
    const paths = errorPaths(pim);
    expect(paths).toContain('contracts');
    expect(paths).toContain('intents');
    expect(paths).toContain('signatures');
  });

  it('rejects a section of the wrong type', () => {
    const pim = mutate((p) => {
      p.signatures = {};
    });
    expect(validatePim(pim).errors.some((i) => i.path === 'signatures')).toBe(true);
  });
});

describe('validatePim — metadata', () => {
  it('requires each metadata field', () => {
    const pim = mutate((p) => {
      delete p.metadata.protocol;
      delete p.metadata.website;
    });
    const paths = errorPaths(pim);
    expect(paths).toContain('metadata.protocol');
    expect(paths).toContain('metadata.website');
  });

  it('rejects an unknown category', () => {
    expect(errorPaths(mutate((p) => (p.metadata.category = 'nope')))).toContain('metadata.category');
  });

  it('rejects a non-semver pimVersion', () => {
    expect(errorPaths(mutate((p) => (p.metadata.pimVersion = '1')))).toContain('metadata.pimVersion');
  });

  it('rejects an empty chainId', () => {
    expect(errorPaths(mutate((p) => (p.metadata.chainId = [])))).toContain('metadata.chainId');
  });
});

describe('validatePim — contracts', () => {
  it('rejects an entry with both address and lookup', () => {
    const pim = mutate((p) => {
      p.contracts.policyHook.lookup = 'getCursor';
    });
    expect(errorPaths(pim)).toContain('contracts.policyHook');
  });

  it('rejects an entry with neither address nor lookup', () => {
    const pim = mutate((p) => {
      delete p.contracts.policyHook.address;
    });
    const result = validatePim(pim);
    expect(result.errors.some((i) => i.message.includes('either'))).toBe(true);
  });

  it('rejects an invalid role', () => {
    expect(errorPaths(mutate((p) => (p.contracts.policyHook.role = 'king')))).toContain('contracts.policyHook.role');
  });

  it('rejects a lookup that matches no lookup entry', () => {
    const pim = mutate((p) => {
      delete p.contracts.policyHook.address;
      p.contracts.policyHook.lookup = 'doesNotExist';
    });
    expect(errorPaths(pim)).toContain('contracts.policyHook.lookup');
  });
});

describe('validatePim — types', () => {
  it('rejects an invalid kind', () => {
    expect(errorPaths(mutate((p) => (p.types.Envelope.kind = 'struct')))).toContain('types.Envelope.kind');
  });

  it('requires fields per type', () => {
    expect(errorPaths(mutate((p) => delete p.types.Cursor.fields))).toContain('types.Cursor.fields');
  });
});

describe('validatePim — lookups', () => {
  it('rejects a contract that does not exist', () => {
    const pim = mutate((p) => {
      p.lookups.getCursor.contract = 'ghost';
    });
    expect(errorPaths(pim)).toContain('lookups.getCursor.contract');
  });

  it('requires function, args and returns', () => {
    const pim = mutate((p) => {
      delete p.lookups.getCursor.function;
      delete p.lookups.getCursor.args;
      delete p.lookups.getCursor.returns;
    });
    const paths = errorPaths(pim);
    expect(paths).toContain('lookups.getCursor.function');
    expect(paths).toContain('lookups.getCursor.args');
    expect(paths).toContain('lookups.getCursor.returns');
  });

  it('rejects a validate assertion with no operator', () => {
    const pim = mutate((p) => {
      p.lookups.getCursor.validate = [{ field: 'returns' }];
    });
    expect(errorPaths(pim)).toContain('lookups.getCursor.validate[0]');
  });

  it('rejects selectCriterion without select', () => {
    expect(errorPaths(mutate((p) => (p.lookups.getCursor.selectCriterion = 'amount')))).toContain(
      'lookups.getCursor.selectCriterion',
    );
  });

  it('rejects an invalid select mode', () => {
    expect(errorPaths(mutate((p) => (p.lookups.getCursor.select = 'first')))).toContain('lookups.getCursor.select');
  });

  it('warns (not errors) on a dangling lookup step reference', () => {
    const pim = mutate((p) => {
      p.intents.readEnvelope.steps[0].lookup = 'ghost';
    });
    const result = validatePim(pim);
    expect(result.valid).toBe(true);
    expect(result.warnings.map((w) => w.path)).toContain('intents.readEnvelope.steps[0].lookup');
  });
});

describe('validatePim — calculations', () => {
  it('requires a formula with a set instruction', () => {
    const paths = errorPaths(mutate((p) => (p.calculations.bad = { description: 'x', formula: { add: '1' } })));
    expect(paths).toContain('calculations.bad.formula');
  });

  it('rejects an invalid precision', () => {
    const pim = mutate((p) => {
      p.calculations.count = { description: 'x', formula: { set: '1' }, precision: 'double' };
    });
    expect(errorPaths(pim)).toContain('calculations.count.precision');
  });
});

describe('validatePim — intents and ui', () => {
  it('requires at least one intent', () => {
    expect(errorPaths(mutate((p) => (p.intents = {})))).toContain('intents');
  });

  it('rejects step ids that skip numbers', () => {
    const pim = mutate((p) => {
      p.intents.readEnvelope.steps[2].id = 7;
    });
    expect(errorPaths(pim)).toContain('intents.readEnvelope.steps');
  });

  it('requires buildTransaction contract/function/description', () => {
    const pim = mutate((p) => {
      delete p.intents.drawBoundedAction.steps[1].contract;
      delete p.intents.drawBoundedAction.steps[1].function;
      delete p.intents.drawBoundedAction.steps[1].description;
    });
    const paths = errorPaths(pim);
    expect(paths).toContain('intents.drawBoundedAction.steps[1].contract');
    expect(paths).toContain('intents.drawBoundedAction.steps[1].function');
    expect(paths).toContain('intents.drawBoundedAction.steps[1].description');
  });

  it('rejects a buildTransaction contract not declared in contracts', () => {
    const pim = mutate((p) => {
      p.intents.drawBoundedAction.steps[1].contract = 'ghost';
    });
    expect(errorPaths(pim)).toContain('intents.drawBoundedAction.steps[1].contract');
  });

  it('requires a ui description for every intent', () => {
    expect(errorPaths(mutate((p) => delete p.ui.intentDescriptions.readEnvelope))).toContain(
      'ui.intentDescriptions',
    );
  });
});

describe('validatePim — signatures', () => {
  it('requires a signer for an ecdsa signature', () => {
    const pim = mutate((p) => {
      p.signatures = [{ type: 'ecdsa', signature: '0x1234' }];
    });
    expect(errorPaths(pim)).toContain('signatures[0].signer');
  });

  it('warns on an unknown signature scheme but does not fail', () => {
    const pim = mutate((p) => {
      p.signatures = [{ type: 'fips-204', signature: '0x1234', signerHashed: `0x${'ab'.repeat(32)}` }];
    });
    const result = validatePim(pim);
    expect(result.valid).toBe(true);
    expect(result.warnings.some((w) => w.path === 'signatures[0].type')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// trust
// ---------------------------------------------------------------------------

const account = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');

describe('trustLevelOf', () => {
  it('grades an unsigned PIM as Level 0 Unverified', async () => {
    const info = await trustLevelOf(base());
    expect(info).toMatchObject({ level: 0, name: 'Unverified', verified: false });
  });

  it('verifies a raw-digest signature and grades it by registry', async () => {
    const signature = await account.sign({ hash: pimDigest(base()) });
    const pim = mutate((p) => {
      p.signatures = [{ type: 'ecdsa', signer: account.address, signature }];
    });
    const info = await trustLevelOf(pim, { protocolSigners: [account.address] });
    expect(info).toMatchObject({ level: 2, name: 'Protocol Signed', verified: true, scheme: 'digest' });
  });

  it('verifies an EIP-191 signature and grades a community signer as Level 1', async () => {
    const signature = await account.signMessage({ message: canonicalPimJson(base()) });
    const pim = mutate((p) => {
      p.signatures = [{ type: 'ecdsa', signer: account.address, signature, signerLabel: 'Example Community' }];
    });
    const info = await trustLevelOf(pim, { knownCommunitySigners: [account.address] });
    expect(info).toMatchObject({
      level: 1,
      name: 'Community',
      verified: true,
      scheme: 'personal',
      signerLabel: 'Example Community',
    });
  });

  it('grades a wallet-pinned signer as Level 3', async () => {
    const signature = await account.sign({ hash: pimDigest(base()) });
    const pim = mutate((p) => {
      p.signatures = [{ type: 'ecdsa', signer: account.address, signature }];
    });
    const info = await trustLevelOf(pim, { walletVerifiedSigners: [account.address] });
    expect(info).toMatchObject({ level: 3, name: 'Wallet Verified', verified: true });
  });

  it('keeps a verifiable but unknown signer at Level 0', async () => {
    const signature = await account.sign({ hash: pimDigest(base()) });
    const pim = mutate((p) => {
      p.signatures = [{ type: 'ecdsa', signer: account.address, signature }];
    });
    const info = await trustLevelOf(pim);
    expect(info).toMatchObject({ level: 0, verified: true });
  });

  it('does not verify when the content changed after signing', async () => {
    const signature = await account.sign({ hash: pimDigest(base()) });
    const pim = mutate((p) => {
      p.signatures = [{ type: 'ecdsa', signer: account.address, signature }];
      p.metadata.description = 'tampered';
    });
    const info = await trustLevelOf(pim);
    expect(info.verified).toBe(false);
  });

  it('rejects with a readable reason when no ecdsa signature is usable', async () => {
    const pim = mutate((p) => {
      p.signatures = [{ type: 'fips-204', signature: '0x1234', signerHashed: `0x${'ab'.repeat(32)}` }];
    });
    const info = await trustLevelOf(pim);
    expect(info.verified).toBe(false);
    expect(info.reason).toContain('ecdsa');
  });
});

// ---------------------------------------------------------------------------
// buildKeelPim
// ---------------------------------------------------------------------------

describe('buildKeelPim', () => {
  it('produces a manifest that passes its own validator', () => {
    const result = validatePim(base());
    expect(result.valid).toBe(true);
  });

  it('guards against placeholder addresses', () => {
    expect(() => buildKeelPim({ policyHook: '0x1234', boundedActions: BOUNDED_ACTIONS })).toThrow(PimBuildError);
    expect(() =>
      buildKeelPim({ policyHook: undefined as unknown as string, boundedActions: BOUNDED_ACTIONS }),
    ).toThrow(PimBuildError);
  });

  it('defaults chain scope and is unsigned', () => {
    const pim = base();
    expect(pim.metadata).toMatchObject({ protocol: 'Keel', category: 'other', author: 'Keel' });
    expect(pim.metadata.chainId).toEqual([1, 56, 8453]);
    expect(pim.signatures).toEqual([]);
  });

  it('declares both contracts with caller-supplied addresses', () => {
    const pim = base();
    expect(pim.contracts.policyHook?.address).toBe(POLICY_HOOK);
    expect(pim.contracts.boundedActions?.address).toBe(BOUNDED_ACTIONS);
  });

  it('carries a lookup and the shared ui description for every intent', () => {
    const pim = base();
    const intents = Object.keys(pim.intents);
    expect(intents.length).toBeGreaterThanOrEqual(2);
    for (const name of intents) {
      expect(pim.ui.intentDescriptions[name]).toBeTruthy();
    }
    expect(pim.lookups.getCursor?.contract).toBe('boundedActions');
  });
});
