import type { PublicClient } from 'viem';
import { describe, expect, it } from 'vitest';
import {
  ANY_DELEGATE,
  ERC7710_SUITE,
  ERC7715_METHODS,
  ERC7715_SUITE,
  ERC721_INTERFACE_ID,
  ERC8004_SUITE,
  ROOT_AUTHORITY,
  REDTEAM_CASES,
  REDTEAM_SUITE,
  SAMPLE_DELEGATION,
  computeDelegationHash,
  computeDomainHash,
  createViemAgentRegistryReader,
  createViemDelegationReader,
  parseForgeRedTeamReport,
  runSuite,
  toRedTeamPort,
} from './index.js';
import type {
  Address,
  AgentRegistryReader,
  CheckTarget,
  DelegationReader,
  Hex,
  PermissionsProvider,
} from './index.js';

const MANAGER = '0x5555555555555555555555555555555555555555' as Address;
const WALLET = '0x6666666666666666666666666666666666666666' as Address;
const IDENTITY = '0x7777777777777777777777777777777777777777' as Address;
const REPUTATION = '0x8888888888888888888888888888888888888888' as Address;
const OWNER = '0x9999999999999999999999999999999999999999' as Address;
const ZERO = '0x0000000000000000000000000000000000000000' as Address;

/* ------------------------------------------------------------------ ERC-7710 */

function fakeDelegation(overrides: Partial<DelegationReader> = {}): DelegationReader {
  return {
    manager: MANAGER,
    hasCode: async () => true,
    chainId: async () => 31337,
    domainHash: async () => computeDomainHash({ manager: MANAGER, chainId: 31337 }),
    delegationHash: async (delegation) => computeDelegationHash(delegation),
    isDelegationDisabled: async () => false,
    name: async () => 'DelegationManager',
    version: async () => '1',
    rootAuthority: async () => ROOT_AUTHORITY,
    anyDelegate: async () => ANY_DELEGATE,
    ...overrides,
  };
}

describe('ERC-7710 suite', () => {
  it('passes on a conformant delegation manager', async () => {
    const report = await runSuite({ delegation: fakeDelegation() }, ERC7710_SUITE);
    expect(report.suite).toBe('ERC-7710');
    expect(report.summary).toEqual({ passed: 7, failed: 0, criticalFailures: 0, ok: true });
  });

  it('flags a domain separator that is not bound to the chain', async () => {
    const reader = fakeDelegation({ chainId: async () => 1 });
    const report = await runSuite({ delegation: reader }, ERC7710_SUITE);
    const check = report.results.find((result) => result.id === 'erc7710.manager.domainBinding');
    expect(check?.status).toBe('fail');
    expect(check?.message).toMatch(/replay vector/);
    expect(report.summary.ok).toBe(false);
  });

  it('flags an off-chain / on-chain hash mismatch', async () => {
    const reader = fakeDelegation({ delegationHash: async () => `0x${'00'.repeat(32)}` });
    const report = await runSuite({ delegation: reader }, ERC7710_SUITE);
    const check = report.results.find((result) => result.id === 'erc7710.manager.delegationHash');
    expect(check?.status).toBe('fail');
    expect(report.summary.criticalFailures).toBe(1);
  });

  it('reports a missing delegation reader instead of throwing', async () => {
    const report = await runSuite({}, ERC7710_SUITE);
    expect(report.summary.ok).toBe(false);
    expect(report.summary.failed).toBe(7);
    expect(report.results[0]?.message).toMatch(/needs a `delegation` reader/);
  });
});

describe('delegation hash derivation', () => {
  it('is deterministic and ignores the signature', () => {
    const base = computeDelegationHash(SAMPLE_DELEGATION);
    expect(computeDelegationHash({ ...SAMPLE_DELEGATION })).toBe(base);
    expect(computeDelegationHash({ ...SAMPLE_DELEGATION, signature: '0xdeadbeef' })).toBe(base);
    expect(computeDelegationHash({ ...SAMPLE_DELEGATION, salt: 1n })).not.toBe(base);
  });

  it('binds the domain to chain and manager', () => {
    const a = computeDomainHash({ manager: MANAGER, chainId: 1 });
    expect(computeDomainHash({ manager: MANAGER, chainId: 2 })).not.toBe(a);
    expect(computeDomainHash({ manager: WALLET, chainId: 1 })).not.toBe(a);
    expect(computeDomainHash({ manager: MANAGER, chainId: 1 })).toBe(a);
  });
});

describe('createViemDelegationReader', () => {
  it('reads getters from the manager and fills struct defaults', async () => {
    const calls: Array<{ address: string; functionName: string; args?: readonly unknown[] }> = [];
    const client = {
      getCode: async () => '0x6000',
      getChainId: async () => 8453,
      readContract: async (call: { address: string; functionName: string; args?: readonly unknown[] }) => {
        calls.push(call);
        if (call.functionName === 'NAME') return 'DelegationManager';
        if (call.functionName === 'VERSION') return '1';
        if (call.functionName === 'ANY_DELEGATE') return ANY_DELEGATE;
        if (call.functionName === 'ROOT_AUTHORITY') return ROOT_AUTHORITY;
        if (call.functionName === 'getDelegationHash') return `0x${'11'.repeat(32)}`;
        if (call.functionName === 'getDomainHash') return `0x${'22'.repeat(32)}`;
        return false;
      },
    } as unknown as PublicClient;

    const reader = createViemDelegationReader(client, MANAGER);
    await expect(reader.hasCode(MANAGER)).resolves.toBe(true);
    await expect(reader.chainId()).resolves.toBe(8453);
    await reader.domainHash();
    await reader.delegationHash(SAMPLE_DELEGATION);
    await reader.anyDelegate();

    const hashCall = calls.find((call) => call.functionName === 'getDelegationHash');
    expect(hashCall?.address).toBe(MANAGER);
    const arg = hashCall?.args?.[0] as { caveats: Array<{ args: string }>; signature: string };
    expect(arg.signature).toBe('0x');
    expect(arg.caveats[0]?.args).toBe('0x');
  });
});

/* ------------------------------------------------------------------ ERC-7715 */

const SUPPORTED = { 'erc20-transfer': { chainIds: ['0x1'], ruleTypes: ['expiry'] } };

const GRANTED = [
  {
    chainId: '0x1',
    to: WALLET,
    permission: { type: 'erc20-transfer', isAdjustmentAllowed: true, data: {} },
    context: '0xdeadbeef',
    dependencies: [],
    delegationManager: MANAGER,
  },
];

function fakePermissions(overrides: Record<string, unknown> = {}): PermissionsProvider {
  const table: Record<string, unknown> = {
    [ERC7715_METHODS.supported]: SUPPORTED,
    [ERC7715_METHODS.granted]: GRANTED,
    ...overrides,
  };
  return {
    request: async ({ method }) => {
      if (!(method in table)) throw new Error(`unexpected method ${method}`);
      return table[method];
    },
  };
}

describe('ERC-7715 suite', () => {
  it('passes on a wallet that speaks the permissions methods', async () => {
    const report = await runSuite({ permissions: fakePermissions() }, ERC7715_SUITE);
    expect(report.suite).toBe('ERC-7715');
    expect(report.summary.ok).toBe(true);
  });

  it('fails when no permission types are advertised', async () => {
    const report = await runSuite(
      { permissions: fakePermissions({ [ERC7715_METHODS.supported]: {} }) },
      ERC7715_SUITE,
    );
    const check = report.results.find((result) => result.id === 'erc7715.wallet.capabilityDiscovery');
    expect(check?.status).toBe('fail');
  });

  it('rejects a non-hex chain id', async () => {
    const report = await runSuite(
      { permissions: fakePermissions({ [ERC7715_METHODS.supported]: { x: { chainIds: ['1'], ruleTypes: [] } } }) },
      ERC7715_SUITE,
    );
    const check = report.results.find((result) => result.id === 'erc7715.wallet.chainIdFormat');
    expect(check?.status).toBe('fail');
  });

  it('rejects a granted permission with an empty context', async () => {
    const report = await runSuite(
      {
        permissions: fakePermissions({
          [ERC7715_METHODS.granted]: [{ ...GRANTED[0], context: '0x' }],
        }),
      },
      ERC7715_SUITE,
    );
    const check = report.results.find((result) => result.id === 'erc7715.wallet.grantedResponseShape');
    expect(check?.status).toBe('fail');
    expect(check?.message).toMatch(/context must be a non-empty/);
  });

  it('cross-checks the delegation manager when a delegation reader is present', async () => {
    const ok = await runSuite(
      { permissions: fakePermissions(), delegation: fakeDelegation() },
      ERC7715_SUITE,
    );
    expect(ok.summary.ok).toBe(true);

    const mismatch = await runSuite(
      { permissions: fakePermissions(), delegation: fakeDelegation({ manager: WALLET }) },
      ERC7715_SUITE,
    );
    const check = mismatch.results.find((result) => result.id === 'erc7715.wallet.delegationManagerBound');
    expect(check?.status).toBe('fail');
  });
});

/* ------------------------------------------------------------------ ERC-8004 */

function fakeAgent(overrides: Partial<AgentRegistryReader> = {}): AgentRegistryReader {
  return {
    identityRegistry: IDENTITY,
    reputationRegistry: REPUTATION,
    agentId: 22n,
    hasCode: async () => true,
    ownerOf: async () => OWNER,
    tokenURI: async () => 'https://agent.example/.well-known/agent-card.json',
    agentWallet: async () => WALLET,
    supportsInterface: async (interfaceId: Hex) => interfaceId === ERC721_INTERFACE_ID,
    reputationIdentityRegistry: async () => IDENTITY,
    ...overrides,
  };
}

describe('ERC-8004 suite', () => {
  it('passes on a registered agent', async () => {
    const report = await runSuite({ agentRegistry: fakeAgent() }, ERC8004_SUITE);
    expect(report.suite).toBe('ERC-8004');
    expect(report.summary.ok).toBe(true);
  });

  it('fails when the agent is not registered', async () => {
    const report = await runSuite({ agentRegistry: fakeAgent({ ownerOf: async () => ZERO }) }, ERC8004_SUITE);
    const check = report.results.find((result) => result.id === 'erc8004.identity.agentRegistered');
    expect(check?.status).toBe('fail');
    expect(report.summary.criticalFailures).toBe(1);
  });

  it('fails when the registry is not ERC-721', async () => {
    const report = await runSuite({ agentRegistry: fakeAgent({ supportsInterface: async () => false }) }, ERC8004_SUITE);
    expect(report.results.find((result) => result.id === 'erc8004.identity.erc721')?.status).toBe('fail');
  });

  it('fails when the reputation registry is not bound', async () => {
    const report = await runSuite(
      { agentRegistry: fakeAgent({ reputationIdentityRegistry: async () => ZERO }) },
      ERC8004_SUITE,
    );
    expect(report.results.find((result) => result.id === 'erc8004.reputation.bound')?.status).toBe('fail');
  });

  it('reports a missing registry reader per check', async () => {
    const report = await runSuite({ agentRegistry: fakeAgent({ reputationRegistry: undefined }) }, ERC8004_SUITE);
    const check = report.results.find((result) => result.id === 'erc8004.reputation.bound');
    expect(check?.status).toBe('fail');
    expect(check?.message).toMatch(/no reputation registry configured/);
  });
});

describe('createViemAgentRegistryReader', () => {
  it('reads identity views from the registry and reputation binding from the reputation registry', async () => {
    const calls: Array<{ address: string; functionName: string; args?: readonly unknown[] }> = [];
    const client = {
      getCode: async () => '0x6000',
      readContract: async (call: { address: string; functionName: string; args?: readonly unknown[] }) => {
        calls.push(call);
        if (call.functionName === 'ownerOf') return OWNER;
        if (call.functionName === 'tokenURI') return 'ipfs://agent';
        if (call.functionName === 'getAgentWallet') return WALLET;
        if (call.functionName === 'supportsInterface') return true;
        if (call.functionName === 'getIdentityRegistry') return IDENTITY;
        return false;
      },
    } as unknown as PublicClient;

    const reader = createViemAgentRegistryReader(client, {
      identityRegistry: IDENTITY,
      reputationRegistry: REPUTATION,
      agentId: 22n,
    });

    await expect(reader.ownerOf()).resolves.toBe(OWNER);
    await reader.tokenURI();
    await reader.agentWallet();
    await reader.supportsInterface(ERC721_INTERFACE_ID);
    await expect(reader.reputationIdentityRegistry()).resolves.toBe(IDENTITY);

    const ownerCall = calls.find((call) => call.functionName === 'ownerOf');
    expect(ownerCall?.address).toBe(IDENTITY);
    expect(ownerCall?.args).toEqual([22n]);

    const reputationCall = calls.find((call) => call.functionName === 'getIdentityRegistry');
    expect(reputationCall?.address).toBe(REPUTATION);
  });
});

/* --------------------------------------------------------------- target port */

describe('accountTarget', () => {
  it('fails the ERC-7579 suite clearly when the target lacks account fields', async () => {
    const target: CheckTarget = {};
    const { ERC7579_SUITE } = await import('./index.js');
    const report = await runSuite(target, ERC7579_SUITE);
    expect(report.summary.ok).toBe(false);
    expect(report.results[0]?.message).toMatch(/needs reader, account, module and moduleTypeId/);
  });
});

/* ------------------------------------------------------------------ Red-team */

function allPassing() {
  return Object.fromEntries(REDTEAM_CASES.map((testCase) => [testCase.test, true]));
}

describe('Red-team suite', () => {
  it('maps every threat id to exactly one distinct Foundry case', () => {
    const threats = REDTEAM_CASES.map((testCase) => testCase.threat);
    const tests = REDTEAM_CASES.map((testCase) => testCase.test);
    expect(new Set(threats).size).toBe(threats.length);
    expect(new Set(tests).size).toBe(tests.length);
    expect(threats).toContain('T-BYPASS-01');
    expect(threats).toContain('T-LIFECYCLE-01');
  });

  it('passes when every Foundry case passed', async () => {
    const report = await runSuite({ redTeam: toRedTeamPort(allPassing()) }, REDTEAM_SUITE);
    expect(report.suite).toBe('Red-team');
    expect(report.summary).toEqual({
      passed: REDTEAM_CASES.length,
      failed: 0,
      criticalFailures: 0,
      ok: true,
    });
  });

  it('flags a failed Foundry case as potentially exploitable', async () => {
    const results = { ...allPassing(), test_T_BYPASS_01_delegatecallCannotReachThePolicy: false };
    const report = await runSuite({ redTeam: toRedTeamPort(results) }, REDTEAM_SUITE);
    const check = report.results.find((result) => result.id === 'redteam.t-bypass-01');
    expect(check?.status).toBe('fail');
    expect(check?.message).toMatch(/may be exploitable/);
    expect(report.summary.criticalFailures).toBe(1);
  });

  it('flags an unexecuted case as not run rather than silently passing', async () => {
    const results = { ...allPassing() };
    delete (results as Record<string, boolean>)['test_T_CEILING_01_batchCannotSplitAroundDailyCap'];
    const report = await runSuite({ redTeam: toRedTeamPort(results) }, REDTEAM_SUITE);
    const check = report.results.find((result) => result.id === 'redteam.t-ceiling-01');
    expect(check?.status).toBe('fail');
    expect(check?.message).toMatch(/not run/);
  });

  it('reports every case as failed when no red-team port is supplied', async () => {
    const report = await runSuite({}, REDTEAM_SUITE);
    expect(report.summary.failed).toBe(REDTEAM_CASES.length);
    expect(report.results[0]?.message).toMatch(/needs a `redTeam` port/);
  });
});

describe('parseForgeRedTeamReport', () => {
  it('reads the nested forge --json shape and strips function signatures', () => {
    const forgeJson = {
      'test/redteam/KeelPolicyHook.redteam.t.sol:KeelPolicyHookRedTeamTest': {
        duration: '1ms',
        test_results: {
          'test_T_BYPASS_01_delegatecallCannotReachThePolicy()': { status: 'Success' },
          'test_T_BYPASS_02_unknownDispatchSelectorRefused()': { status: 'Failure', reason: 'x' },
        },
      },
    };
    expect(parseForgeRedTeamReport(forgeJson)).toEqual({
      test_T_BYPASS_01_delegatecallCannotReachThePolicy: true,
      test_T_BYPASS_02_unknownDispatchSelectorRefused: false,
    });
  });

  it('returns an empty table for non-object input', () => {
    expect(parseForgeRedTeamReport(null)).toEqual({});
    expect(parseForgeRedTeamReport('nope')).toEqual({});
  });
});
