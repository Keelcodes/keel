import type { PublicClient } from 'viem';
import type { Address, Check, CheckTarget, Hex, PermissionsProvider, Suite } from './types.js';

/**
 * ERC-7715 conformance (Request Permissions from Wallets).
 *
 * ERC-7715 is a **wallet JSON-RPC** standard (EIP-1193 `request`), not an
 * on-chain interface; execution happens later through ERC-7710's
 * `redeemDelegations`. The suite therefore probes the wallet's methods and
 * validates the response shapes the EIP fixes — in particular that a granted
 * permission carries an opaque `context` and a `delegationManager` a redeemer
 * can actually call.
 *
 * Method names follow the current eips.ethereum.org text; older drafts and some
 * MetaMask docs used `wallet_grantPermissions` / `wallet_getPermissions`.
 */

export const ERC7715_METHODS = {
  request: 'wallet_requestExecutionPermissions',
  revoke: 'wallet_revokeExecutionPermission',
  supported: 'wallet_getSupportedExecutionPermissions',
  granted: 'wallet_getGrantedExecutionPermissions',
} as const;

export interface PermissionRule {
  type: string;
  data: Record<string, unknown>;
}

export interface PermissionResponse {
  /** `uint256` chain id, hex-encoded. */
  chainId: Hex;
  to: Address;
  from?: Address;
  permission: {
    type: string;
    isAdjustmentAllowed: boolean;
    data: Record<string, unknown>;
  };
  rules?: readonly PermissionRule[];
  /** Opaque, single-use string redeemed via ERC-7710. */
  context: Hex;
  dependencies: readonly { factory: Hex; factoryData: Hex }[];
  delegationManager: Address;
}

function isHex(value: unknown): value is Hex {
  return typeof value === 'string' && /^0x[0-9a-fA-F]*$/.test(value);
}

function isAddress(value: unknown): value is Address {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value);
}

/** Validates one `PermissionResponse` from `wallet_getGrantedExecutionPermissions`. */
export function assertPermissionResponse(value: unknown, index: number): PermissionResponse {
  const at = `permissions[${index}]`;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${at} must be an object`);
  }
  const record = value as Record<string, unknown>;

  if (!isHex(record['chainId']) || record['chainId'] === '0x') {
    throw new Error(`${at}.chainId must be a hex-encoded chain id`);
  }
  if (!isAddress(record['to'])) {
    throw new Error(`${at}.to must be an address`);
  }
  if (!isHex(record['context']) || record['context'] === '0x') {
    throw new Error(`${at}.context must be a non-empty 0x string`);
  }
  if (!isAddress(record['delegationManager'])) {
    throw new Error(`${at}.delegationManager must be an address`);
  }

  const permission = record['permission'];
  if (typeof permission !== 'object' || permission === null || Array.isArray(permission)) {
    throw new Error(`${at}.permission must be an object`);
  }
  const fields = permission as Record<string, unknown>;
  if (typeof fields['type'] !== 'string' || fields['type'] === '') {
    throw new Error(`${at}.permission.type must be a non-empty string`);
  }
  if (typeof fields['isAdjustmentAllowed'] !== 'boolean') {
    throw new Error(`${at}.permission.isAdjustmentAllowed must be a boolean`);
  }
  if (typeof fields['data'] !== 'object' || fields['data'] === null) {
    throw new Error(`${at}.permission.data must be an object`);
  }

  const dependencies = record['dependencies'];
  if (!Array.isArray(dependencies)) {
    throw new Error(`${at}.dependencies must be an array`);
  }
  dependencies.forEach((dependency, depIndex) => {
    if (typeof dependency !== 'object' || dependency === null) {
      throw new Error(`${at}.dependencies[${depIndex}] must be an object`);
    }
    const dep = dependency as Record<string, unknown>;
    if (!isHex(dep['factory']) || !isHex(dep['factoryData'])) {
      throw new Error(`${at}.dependencies[${depIndex}] must carry hex factory and factoryData`);
    }
  });

  return value as unknown as PermissionResponse;
}

function permissionsProvider(target: CheckTarget): PermissionsProvider {
  const provider = target.permissions;
  if (provider === undefined) {
    throw new Error('the ERC-7715 suite needs a `permissions` provider on the target');
  }
  return provider;
}

async function discover(provider: PermissionsProvider): Promise<Record<string, unknown>> {
  const result = await provider.request({ method: ERC7715_METHODS.supported, params: [] });
  if (typeof result !== 'object' || result === null || Array.isArray(result)) {
    throw new Error(`${ERC7715_METHODS.supported} must return an object`);
  }
  return result as Record<string, unknown>;
}

export const ERC7715_CHECKS: readonly Check[] = [
  {
    id: 'erc7715.wallet.capabilityDiscovery',
    title: 'Wallet advertises supported execution permissions',
    spec: 'ERC-7715 §wallet_getSupportedExecutionPermissions',
    severity: 'high',
    async run(target) {
      const supported = await discover(permissionsProvider(target));
      const types = Object.keys(supported);
      if (types.length === 0) {
        throw new Error(`${ERC7715_METHODS.supported} returned no permission types`);
      }
      for (const type of types) {
        const entry = supported[type];
        if (typeof entry !== 'object' || entry === null) {
          throw new Error(`supported permission ${type} must be an object`);
        }
        const record = entry as Record<string, unknown>;
        if (!Array.isArray(record['chainIds'])) {
          throw new Error(`supported permission ${type} must list chainIds`);
        }
        if (!Array.isArray(record['ruleTypes'])) {
          throw new Error(`supported permission ${type} must list ruleTypes`);
        }
      }
      return `${types.length} permission type(s) advertised`;
    },
  },
  {
    id: 'erc7715.wallet.chainIdFormat',
    title: 'Advertised chain ids are 0x hex strings',
    spec: 'ERC-7715 §wallet_getSupportedExecutionPermissions',
    severity: 'medium',
    async run(target) {
      const supported = await discover(permissionsProvider(target));
      for (const [type, entry] of Object.entries(supported)) {
        const chainIds = (entry as Record<string, unknown>)['chainIds'];
        if (!Array.isArray(chainIds)) continue;
        for (const chainId of chainIds) {
          if (!isHex(chainId) || chainId === '0x') {
            throw new Error(`supported permission ${type} has a non-hex chainId ${JSON.stringify(chainId)}`);
          }
        }
      }
      return 'chain ids are hex-encoded';
    },
  },
  {
    id: 'erc7715.wallet.grantedResponseShape',
    title: 'Granted permissions match the EIP response shape',
    spec: 'ERC-7715 §PermissionResponse',
    severity: 'high',
    async run(target) {
      const result = await permissionsProvider(target).request({
        method: ERC7715_METHODS.granted,
        params: [],
      });
      if (!Array.isArray(result)) {
        throw new Error(`${ERC7715_METHODS.granted} must return an array`);
      }
      result.forEach((entry, index) => assertPermissionResponse(entry, index));
      return `${result.length} granted permission(s) well-formed`;
    },
  },
  {
    id: 'erc7715.wallet.delegationManagerBound',
    title: 'Granted permissions point at the expected DelegationManager',
    spec: 'ERC-7715 §PermissionResponse → ERC-7710',
    severity: 'high',
    async run(target) {
      const result = await permissionsProvider(target).request({
        method: ERC7715_METHODS.granted,
        params: [],
      });
      if (!Array.isArray(result) || result.length === 0) {
        return 'no granted permissions to cross-check';
      }
      const permissions = result.map((entry, index) => assertPermissionResponse(entry, index));

      // When a delegation reader is present, redemption must land on it.
      const manager = target.delegation?.manager?.toLowerCase();
      for (const permission of permissions) {
        if (manager !== undefined && permission.delegationManager.toLowerCase() !== manager) {
          throw new Error(
            `permission redeems via ${permission.delegationManager}, but the delegation manager under test is ${target.delegation?.manager}`,
          );
        }
      }
      return `all ${permissions.length} permission(s) redeem via a known DelegationManager`;
    },
  },
];

/** ERC-7715 permissions suite. */
export const ERC7715_SUITE: Suite = {
  name: 'ERC-7715',
  spec: 'ERC-7715 (Request Permissions from Wallets)',
  checks: ERC7715_CHECKS,
};

/** Points the ERC-7715 suite at a wallet that speaks EIP-1193 `request`. */
export function createViemPermissionsProvider(client: PublicClient): PermissionsProvider {
  const request = client.request as unknown as (args: {
    method: string;
    params?: readonly unknown[];
  }) => Promise<unknown>;
  return { request: (args) => request(args) };
}
