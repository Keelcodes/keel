import { encodeAbiParameters, encodePacked, keccak256, toHex, type PublicClient } from 'viem';
import { erc7710ManagerAbi } from './abi.js';
import type { Address, Check, CheckTarget, Delegation, DelegationCaveat, DelegationReader, Hex, Suite } from './types.js';

/**
 * ERC-7710 conformance (Smart Contract Delegation).
 *
 * The EIP body fixes only `redeemDelegations(bytes[],bytes32[],bytes[])`; the
 * getters probed here are the MetaMask delegation-framework reference that the
 * EIP names. The suite's core assertion is **off-chain / on-chain agreement**:
 * the delegation hash we derive from the EIP-712 preimage must equal what the
 * manager returns, and the domain separator must be bound to this chain and
 * manager — a mismatch is a replay vector across chains or deployments.
 */

/** `keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")`. */
export const EIP712_DOMAIN_TYPEHASH = keccak256(
  toHex('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'),
);

const CAVEAT_TYPEHASH = keccak256(toHex('Caveat(address enforcer,bytes terms)'));

const DELEGATION_TYPEHASH = keccak256(
  toHex(
    'Delegation(address delegate,address delegator,bytes32 authority,Caveat[] caveats,uint256 salt)Caveat(address enforcer,bytes terms)',
  ),
);

/** `ROOT_AUTHORITY` — the sentinel authority for a root delegation. */
export const ROOT_AUTHORITY: Hex = `0x${'ff'.repeat(32)}`;
/** `ANY_DELEGATE` — the reference's wildcard delegate sentinel. */
export const ANY_DELEGATE: Address = '0x0000000000000000000000000000000000000a11';

const DEFAULT_DOMAIN_NAME = 'DelegationManager';
const DEFAULT_DOMAIN_VERSION = '1';

/**
 * `keccak256(abi.encode(CAVEAT_TYPEHASH, enforcer, keccak256(terms)))` — the
 * caveat's `args` are deliberately excluded, matching the reference.
 */
export function caveatHash(caveat: DelegationCaveat): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'address' }, { type: 'bytes32' }],
      [CAVEAT_TYPEHASH, caveat.enforcer, keccak256(caveat.terms)],
    ),
  );
}

function caveatArrayHash(caveats: readonly DelegationCaveat[]): Hex {
  if (caveats.length === 0) return keccak256('0x');
  const types = caveats.map(() => 'bytes32' as const);
  const values = caveats.map((caveat) => caveatHash(caveat));
  return keccak256(encodePacked(types, values));
}

/** The EIP-712 delegation hash, derived off-chain. */
export function computeDelegationHash(delegation: Delegation): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'address' },
        { type: 'address' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'uint256' },
      ],
      [
        DELEGATION_TYPEHASH,
        delegation.delegate,
        delegation.delegator,
        delegation.authority,
        caveatArrayHash(delegation.caveats),
        delegation.salt,
      ],
    ),
  );
}

/** The EIP-712 domain separator for a manager on a chain. */
export function computeDomainHash(args: {
  manager: Address;
  chainId: number;
  name?: string;
  version?: string;
}): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'uint256' },
        { type: 'address' },
      ],
      [
        EIP712_DOMAIN_TYPEHASH,
        keccak256(toHex(args.name ?? DEFAULT_DOMAIN_NAME)),
        keccak256(toHex(args.version ?? DEFAULT_DOMAIN_VERSION)),
        BigInt(args.chainId),
        args.manager,
      ],
    ),
  );
}

/** A delegation fixture used to exercise the hash derivation. */
export const SAMPLE_DELEGATION: Delegation = {
  delegate: ANY_DELEGATE,
  delegator: '0x1111111111111111111111111111111111111111',
  authority: ROOT_AUTHORITY,
  caveats: [{ enforcer: '0x2222222222222222222222222222222222222222', terms: '0xdeadbeef' }],
  salt: 0n,
};

function delegationReader(target: CheckTarget): DelegationReader {
  const reader = target.delegation;
  if (reader === undefined) {
    throw new Error('the ERC-7710 suite needs a `delegation` reader on the target');
  }
  return reader;
}

function toHex32(value: Hex): string {
  return value.toLowerCase();
}

export const ERC7710_CHECKS: readonly Check[] = [
  {
    id: 'erc7710.manager.deployed',
    title: 'DelegationManager is deployed',
    spec: 'ERC-7710 §ERC7710Manager',
    severity: 'critical',
    async run(target) {
      const reader = delegationReader(target);
      if (!(await reader.hasCode(reader.manager))) {
        throw new Error(`no bytecode at DelegationManager ${reader.manager}`);
      }
      return `DelegationManager ${reader.manager} has bytecode`;
    },
  },
  {
    id: 'erc7710.manager.domainBinding',
    title: 'Domain separator is bound to this chain and manager',
    spec: 'ERC-7710 + EIP-712',
    severity: 'high',
    async run(target) {
      const reader = delegationReader(target);
      const expected = computeDomainHash({
        manager: reader.manager,
        chainId: await reader.chainId(),
        name: await reader.name(),
        version: await reader.version(),
      });
      const actual = await reader.domainHash();
      if (toHex32(expected) !== toHex32(actual)) {
        throw new Error(
          `getDomainHash() = ${actual}, expected ${expected} — a cross-chain/cross-contract replay vector`,
        );
      }
      return 'domain separator matches the EIP-712 preimage';
    },
  },
  {
    id: 'erc7710.manager.delegationHash',
    title: 'On-chain delegation hash matches the off-chain derivation',
    spec: 'ERC-7710 + MetaMask delegation-framework',
    severity: 'critical',
    async run(target) {
      const reader = delegationReader(target);
      const expected = computeDelegationHash(SAMPLE_DELEGATION);
      const actual = await reader.delegationHash(SAMPLE_DELEGATION);
      if (toHex32(expected) !== toHex32(actual)) {
        throw new Error(`getDelegationHash() = ${actual}, off-chain derivation = ${expected}`);
      }
      return 'delegation hash derivation agrees with the manager';
    },
  },
  {
    id: 'erc7710.manager.signatureIgnored',
    title: 'Delegation hash ignores the signature field',
    spec: 'ERC-7710 + MetaMask delegation-framework',
    severity: 'high',
    async run(target) {
      const reader = delegationReader(target);
      const withSignature: Delegation = { ...SAMPLE_DELEGATION, signature: '0xdeadbeef' };
      const plain = await reader.delegationHash(SAMPLE_DELEGATION);
      const signed = await reader.delegationHash(withSignature);
      if (toHex32(plain) !== toHex32(signed)) {
        throw new Error('a signature change altered the delegation hash — signing would invalidate it');
      }
      return 'signature is excluded from the hash';
    },
  },
  {
    id: 'erc7710.manager.rootAuthority',
    title: 'ROOT_AUTHORITY matches the reference sentinel',
    spec: 'ERC-7710 + MetaMask delegation-framework',
    severity: 'medium',
    async run(target) {
      const reader = delegationReader(target);
      const actual = await reader.rootAuthority();
      if (toHex32(actual) !== toHex32(ROOT_AUTHORITY)) {
        throw new Error(`ROOT_AUTHORITY() = ${actual}, expected ${ROOT_AUTHORITY}`);
      }
      return 'ROOT_AUTHORITY is the all-ones sentinel';
    },
  },
  {
    id: 'erc7710.manager.anyDelegate',
    title: 'ANY_DELEGATE matches the reference sentinel',
    spec: 'ERC-7710 + MetaMask delegation-framework',
    severity: 'medium',
    async run(target) {
      const reader = delegationReader(target);
      const actual = await reader.anyDelegate();
      if (actual.toLowerCase() !== ANY_DELEGATE.toLowerCase()) {
        throw new Error(`ANY_DELEGATE() = ${actual}, expected ${ANY_DELEGATE}`);
      }
      return 'ANY_DELEGATE is the reference wildcard';
    },
  },
  {
    id: 'erc7710.manager.notDisabledByDefault',
    title: 'An unspent delegation hash is not disabled',
    spec: 'ERC-7710 + MetaMask delegation-framework',
    severity: 'high',
    async run(target) {
      const reader = delegationReader(target);
      const hash = computeDelegationHash({ ...SAMPLE_DELEGATION, salt: 999n });
      if (await reader.isDelegationDisabled(hash)) {
        throw new Error(`disabledDelegations(${hash}) = true for a fresh delegation`);
      }
      return 'fresh delegation hashes read as enabled';
    },
  },
];

/** ERC-7710 delegation suite. */
export const ERC7710_SUITE: Suite = {
  name: 'ERC-7710',
  spec: 'ERC-7710 (Smart Contract Delegation)',
  checks: ERC7710_CHECKS,
};

function toAbiDelegation(delegation: Delegation) {
  return {
    delegate: delegation.delegate,
    delegator: delegation.delegator,
    authority: delegation.authority,
    caveats: delegation.caveats.map((caveat) => ({
      enforcer: caveat.enforcer,
      terms: caveat.terms,
      args: caveat.args ?? '0x',
    })),
    salt: delegation.salt,
    signature: delegation.signature ?? '0x',
  };
}

/** Points the ERC-7710 suite at a live `DelegationManager` via a viem client. */
export function createViemDelegationReader(client: PublicClient, manager: Address): DelegationReader {
  return {
    manager,

    async hasCode(address) {
      const code = await client.getCode({ address });
      return Boolean(code && code !== '0x');
    },

    chainId: () => client.getChainId(),

    domainHash: () =>
      client.readContract({ address: manager, abi: erc7710ManagerAbi, functionName: 'getDomainHash' }),

    delegationHash: (delegation) =>
      client.readContract({
        address: manager,
        abi: erc7710ManagerAbi,
        functionName: 'getDelegationHash',
        args: [toAbiDelegation(delegation)],
      }),

    isDelegationDisabled: (delegationHash) =>
      client.readContract({
        address: manager,
        abi: erc7710ManagerAbi,
        functionName: 'disabledDelegations',
        args: [delegationHash],
      }),

    name: () => client.readContract({ address: manager, abi: erc7710ManagerAbi, functionName: 'NAME' }),

    version: () =>
      client.readContract({ address: manager, abi: erc7710ManagerAbi, functionName: 'VERSION' }),

    rootAuthority: () =>
      client.readContract({ address: manager, abi: erc7710ManagerAbi, functionName: 'ROOT_AUTHORITY' }),

    anyDelegate: () =>
      client.readContract({ address: manager, abi: erc7710ManagerAbi, functionName: 'ANY_DELEGATE' }),
  };
}
