/**
 * Turning wagmi connectors into something a person can pick.
 *
 * Extension wallets are discovered via EIP-6963, so each connector already
 * carries a real, human name ("MetaMask", "OKX Wallet", "Rabby") and often an
 * icon. This module only normalises that into a display descriptor and keeps a
 * monogram for wallets that ship no icon.
 */

export type ConnectorKind = 'browser' | 'walletconnect';

export interface ConnectorDescriptor {
  uid: string;
  id: string;
  /** Human name, e.g. "MetaMask" or "WalletConnect". */
  name: string;
  /** Data-URI icon when the wallet advertises one (EIP-6963). */
  icon?: string;
  kind: ConnectorKind;
  /** One or two letters shown when there is no icon. */
  monogram: string;
}

function monogramOf(name: string): string {
  const words = name.replace(/[^a-zA-Z0-9 ]/g, ' ').trim().split(/\s+/);
  const letters = words.slice(0, 2).map((word) => word[0] ?? '');
  return (letters.join('') || name.slice(0, 1) || '?').toUpperCase();
}

export function isWalletConnect(id: string, name: string): boolean {
  const haystack = `${id} ${name}`.toLowerCase();
  return haystack.includes('walletconnect');
}

/** The shape of `useConnect().connectors` entries this module needs. */
export interface RawConnector {
  uid: string;
  id: string;
  name: string;
  icon?: string;
}

export function describeConnector(connector: RawConnector): ConnectorDescriptor {
  const kind: ConnectorKind = isWalletConnect(connector.id, connector.name)
    ? 'walletconnect'
    : 'browser';
  return {
    uid: connector.uid,
    id: connector.id,
    name: connector.name,
    icon: connector.icon,
    kind,
    monogram: monogramOf(connector.name),
  };
}
