import { parseAbi } from 'viem';

/**
 * ERC-7579 account views a conformance run needs. Kept local to this package —
 * the suite probes the standard surface, not any project's adapter ABI.
 */
export const erc7579AccountAbi = parseAbi([
  'function isModuleInstalled(uint256 moduleTypeId, address module, bytes additionalContext) view returns (bool)',
  'function supportsExecutionMode(bytes32 mode) view returns (bool)',
  'function accountId() view returns (string)',
]);

/** ERC-7579 `IModule` views, read from the module itself. */
export const erc7579ModuleAbi = parseAbi([
  'function isInitialized(address smartAccount) view returns (bool)',
  'function isModuleType(uint256 moduleTypeId) view returns (bool)',
]);

/**
 * ERC-7710 delegation-manager views. The EIP fixes only `redeemDelegations`; the
 * getters below are the MetaMask delegation-framework reference that the EIP
 * names, which is what a conformance run can actually probe.
 */
export const erc7710ManagerAbi = parseAbi([
  'function getDomainHash() view returns (bytes32)',
  'function getDelegationHash((address delegate, address delegator, bytes32 authority, (address enforcer, bytes terms, bytes args)[] caveats, uint256 salt, bytes signature) delegation) view returns (bytes32)',
  'function disabledDelegations(bytes32 delegationHash) view returns (bool)',
  'function ROOT_AUTHORITY() view returns (bytes32)',
  'function ANY_DELEGATE() view returns (address)',
  'function NAME() view returns (string)',
  'function VERSION() view returns (string)',
]);

/** ERC-8004 identity registry — ERC-721 with agent extensions. */
export const erc8004IdentityAbi = parseAbi([
  'function ownerOf(uint256 agentId) view returns (address)',
  'function tokenURI(uint256 agentId) view returns (string)',
  'function getAgentWallet(uint256 agentId) view returns (address)',
  'function supportsInterface(bytes4 interfaceId) view returns (bool)',
]);

/** ERC-8004 reputation registry — the binding to its identity registry. */
export const erc8004ReputationAbi = parseAbi([
  'function getIdentityRegistry() view returns (address)',
]);
