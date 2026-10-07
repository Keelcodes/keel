/**
 * @keelcodes/conformance
 *
 * Cross-ecosystem conformance and security suite for agent accounts: it probes
 * the standard surface of an ERC-7579 account (and the modules installed on it)
 * and reports pass/fail per assertion, anchored to the spec.
 *
 * The suite talks to an {@link AccountReader} port, so it runs against an
 * in-memory fake in tests or a live chain via {@link createViemReader} — no
 * Keel-specific dependency, which is what makes it usable as a neutral public
 * good.
 *
 * @packageDocumentation
 */

export { erc7579AccountAbi, erc7579ModuleAbi, erc7710ManagerAbi, erc8004IdentityAbi, erc8004ReputationAbi } from './abi.js';
export { ERC7579_CHECKS, ERC7579_SUITE } from './checks.js';
export { createViemReader } from './reader.js';
export { formatReport } from './report.js';
export { runChecks, runSuite, summarize } from './runner.js';

export {
  ANY_DELEGATE,
  EIP712_DOMAIN_TYPEHASH,
  ERC7710_CHECKS,
  ERC7710_SUITE,
  ROOT_AUTHORITY,
  SAMPLE_DELEGATION,
  caveatHash,
  computeDelegationHash,
  computeDomainHash,
  createViemDelegationReader,
} from './delegation.js';

export {
  ERC7715_CHECKS,
  ERC7715_METHODS,
  ERC7715_SUITE,
  assertPermissionResponse,
  createViemPermissionsProvider,
} from './permissions.js';

export {
  ERC721_INTERFACE_ID,
  ERC8004_CHECKS,
  ERC8004_SUITE,
  createViemAgentRegistryReader,
} from './agents.js';

export {
  REDTEAM_CASES,
  REDTEAM_CHECKS,
  REDTEAM_SUITE,
  parseForgeRedTeamReport,
  toRedTeamPort,
} from './redteam.js';

export { EXECUTION_MODE, MODULE_TYPE, accountTarget, moduleAdminTarget } from './types.js';
export type { ModuleTypeId } from './types.js';
export type {
  AccountReader,
  Address,
  AgentRegistryReader,
  Check,
  CheckResult,
  CheckTarget,
  ConformanceReport,
  ConformanceSummary,
  Delegation,
  DelegationCaveat,
  DelegationReader,
  Hex,
  ModuleAdminPort,
  PermissionsProvider,
  RedTeamPort,
  Severity,
  Suite,
} from './types.js';
export type { PermissionResponse, PermissionRule } from './permissions.js';
export type { RedTeamCase } from './redteam.js';
export type { ViemAgentRegistryOptions } from './agents.js';
