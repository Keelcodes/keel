/** `0x`-prefixed hex string. */
export type Hex = `0x${string}`;
/** `0x`-prefixed 20-byte address. */
export type Address = `0x${string}`;

/**
 * ERC-7579 module type ids. Declared here on purpose: a conformance suite must
 * depend on the *standards*, not on any particular project's adapter package, so
 * it can be pointed at any ERC-7579 account or module.
 */
export const MODULE_TYPE = {
  VALIDATOR: 1n,
  EXECUTOR: 2n,
  FALLBACK: 3n,
  HOOK: 4n,
} as const;

export type ModuleTypeId = (typeof MODULE_TYPE)[keyof typeof MODULE_TYPE];

/**
 * Default ERC-7579 execution modes a conformant account must support: callType
 * `0x00` (single) and `0x01` (batch), execType `0x00` (default), default mode
 * selector, empty payload.
 */
export const EXECUTION_MODE = {
  SINGLE: `0x${'00'.repeat(32)}` as Hex,
  BATCH: `0x01${'00'.repeat(31)}` as Hex,
} as const;

/** How much a failure matters. `critical` failures gate the suite. */
export type Severity = 'critical' | 'high' | 'medium' | 'low';

/**
 * Everything a check may query. Deliberately a small port rather than a viem
 * client, so a suite can run against an in-memory fake (tests) or a live chain
 * ({@link createViemReader}).
 */
export interface AccountReader {
  /** Whether `account` currently has bytecode (i.e. is deployed). */
  hasCode(account: Address): Promise<boolean>;
  /** ERC-7579 `isModuleInstalled(moduleTypeId, module, additionalContext)`. */
  isModuleInstalled(args: { account: Address; module: Address; moduleTypeId: bigint }): Promise<boolean>;
  /** ERC-7579 `supportsExecutionMode(bytes32 mode)`. */
  supportsExecutionMode(account: Address, mode: Hex): Promise<boolean>;
  /** ERC-7579 `accountId()`. */
  accountId(account: Address): Promise<string>;
  /** ERC-7579 `IModule.isInitialized(smartAccount)` on the module. */
  isModuleInitialized(module: Address, account: Address): Promise<boolean>;
  /** ERC-7579 `IModule.isModuleType(moduleTypeId)` on the module. */
  isModuleType(module: Address, moduleTypeId: bigint): Promise<boolean>;
}

/**
 * The write half of ERC-7579's module-manager surface, as a deliberate second
 * port. Kept separate from {@link AccountReader} so a read-only conformance run
 * can never mutate an account: install/uninstall only happen when the caller
 * injects this port explicitly. A live adapter would bind it to a wallet client
 * (it sends transactions); tests bind it to an in-memory fake.
 */
export interface ModuleAdminPort {
  /** ERC-7579 `installModule(moduleTypeId, module, initData)`. */
  installModule(args: {
    account: Address;
    module: Address;
    moduleTypeId: bigint;
    initData?: Hex;
  }): Promise<void>;
  /** ERC-7579 `uninstallModule(moduleTypeId, module, deInitData)`. */
  uninstallModule(args: {
    account: Address;
    module: Address;
    moduleTypeId: bigint;
    deInitData?: Hex;
  }): Promise<void>;
}

/** A caveat as defined by the ERC-7710 reference implementation. */
export interface DelegationCaveat {
  enforcer: Address;
  terms: Hex;
  /** Ignored when hashing, so it may change after signing. */
  args?: Hex;
}

/** A delegation as defined by the ERC-7710 reference implementation. */
export interface Delegation {
  delegate: Address;
  delegator: Address;
  authority: Hex;
  caveats: readonly DelegationCaveat[];
  salt: bigint;
  /** Ignored when hashing, so it may change after signing. */
  signature?: Hex;
}

/**
 * ERC-7710 delegation reads, bound to the `DelegationManager` under test.
 *
 * The EIP itself fixes only `redeemDelegations`; the getters below come from the
 * MetaMask delegation-framework reference implementation that the EIP names.
 * The reader is bound to one manager so checks need no extra arguments.
 */
export interface DelegationReader {
  manager: Address;
  hasCode(address: Address): Promise<boolean>;
  chainId(): Promise<number>;
  domainHash(): Promise<Hex>;
  delegationHash(delegation: Delegation): Promise<Hex>;
  isDelegationDisabled(delegationHash: Hex): Promise<boolean>;
  name(): Promise<string>;
  version(): Promise<string>;
  rootAuthority(): Promise<Hex>;
  anyDelegate(): Promise<Address>;
}

/**
 * ERC-7715 wallet surface — a JSON-RPC (EIP-1193) `request`, not an on-chain
 * interface. The suite discovers capabilities and inspects granted permissions.
 */
export interface PermissionsProvider {
  request(args: { method: string; params?: readonly unknown[] }): Promise<unknown>;
}

/** ERC-8004 registry reads, bound to one agent. */
export interface AgentRegistryReader {
  identityRegistry: Address;
  /** Optional; enables the reputation-binding check when present. */
  reputationRegistry?: Address;
  agentId: bigint;
  hasCode(address: Address): Promise<boolean>;
  ownerOf(): Promise<Address>;
  tokenURI(): Promise<string>;
  agentWallet(): Promise<Address>;
  supportsInterface(interfaceId: Hex): Promise<boolean>;
  reputationIdentityRegistry(): Promise<Address>;
}

/**
 * Red-team results port. Each `Check` in the red-team suite corresponds to one
 * Foundry case; the port reports whether that case passed, or `undefined` when
 * it was not executed — so a report can distinguish "Foundry-verified" from
 * "not run" instead of silently omitting unverified threats.
 */
export interface RedTeamPort {
  /** Whether the named Foundry test passed; `undefined` when it was not run. */
  outcomeOf(testName: string): Promise<boolean | undefined>;
}

/**
 * The subject of a conformance run. ERC-7579 needs the account fields; every
 * other suite carries its own bound port, so those fields are optional and only
 * the relevant suite reads them.
 */
export interface CheckTarget {
  reader?: AccountReader;
  /** Write half of the ERC-7579 module-manager surface; enables lifecycle checks. */
  moduleAdmin?: ModuleAdminPort;
  /** The smart account under test (ERC-7579). */
  account?: Address;
  /** The module under test (ERC-7579), typically installed on `account`. */
  module?: Address;
  /** ERC-7579 module type of `module` on `account`. */
  moduleTypeId?: bigint;
  delegation?: DelegationReader;
  permissions?: PermissionsProvider;
  agentRegistry?: AgentRegistryReader;
  redTeam?: RedTeamPort;
}

/** Narrows a target to the ERC-7579 account fields, or throws. */
export function accountTarget(target: CheckTarget): {
  reader: AccountReader;
  account: Address;
  module: Address;
  moduleTypeId: bigint;
} {
  const { reader, account, module, moduleTypeId } = target;
  if (reader === undefined || account === undefined || module === undefined || moduleTypeId === undefined) {
    throw new Error('the ERC-7579 suite needs reader, account, module and moduleTypeId on the target');
  }
  return { reader, account, module, moduleTypeId };
}

/**
 * Narrows a target to the ERC-7579 module-lifecycle fields, or throws. The
 * mutation checks need both the read port and the explicit write port, so a
 * plain read-only run fails them loudly instead of silently skipping.
 */
export function moduleAdminTarget(target: CheckTarget): {
  reader: AccountReader;
  moduleAdmin: ModuleAdminPort;
  account: Address;
  module: Address;
  moduleTypeId: bigint;
} {
  const { reader, moduleAdmin, account, module, moduleTypeId } = target;
  if (
    reader === undefined ||
    moduleAdmin === undefined ||
    account === undefined ||
    module === undefined ||
    moduleTypeId === undefined
  ) {
    throw new Error(
      'the ERC-7579 module lifecycle checks need reader, moduleAdmin, account, module and moduleTypeId on the target',
    );
  }
  return { reader, moduleAdmin, account, module, moduleTypeId };
}

/**
 * A single conformance assertion. `run` returns a short pass message, or throws
 * to fail — throwing keeps checks readable and lets the runner attach context.
 */
export interface Check {
  id: string;
  title: string;
  /** Spec anchor, e.g. `ERC-7579 §3.1`. */
  spec: string;
  severity: Severity;
  run(target: CheckTarget): Promise<string>;
}

export interface CheckResult {
  id: string;
  title: string;
  spec: string;
  severity: Severity;
  status: 'pass' | 'fail';
  message: string;
  durationMs: number;
}

export interface ConformanceSummary {
  passed: number;
  failed: number;
  criticalFailures: number;
  /** `true` only when nothing failed and no `critical` check failed. */
  ok: boolean;
}

export interface ConformanceReport {
  /** Name of the suite that produced the report. */
  suite: string;
  account?: Address;
  module?: Address;
  moduleTypeId?: bigint;
  startedAt: string;
  durationMs: number;
  results: CheckResult[];
  summary: ConformanceSummary;
}

/** A named, ordered bundle of checks for one standard. */
export interface Suite {
  name: string;
  spec: string;
  checks: readonly Check[];
}
