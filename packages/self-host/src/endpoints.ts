import { DEFAULT_LOCAL_PORTS, LOCAL_CHAIN_ID } from './stack.js';

export interface LocalStackPorts {
  anvil: number;
  bundler: number;
  paymaster: number;
  api: number;
}

export interface LocalStackOptions {
  /** Host the stack runs on. Defaults to `127.0.0.1`. */
  host?: string;
  /** Overrides for the published ports. */
  ports?: Partial<LocalStackPorts>;
  /** Expected chain id. Defaults to {@link LOCAL_CHAIN_ID}. */
  chainId?: number;
}

/** The endpoints the reference stack exposes. */
export interface LocalStackEndpoints {
  chainId: number;
  rpcUrl: string;
  bundlerUrl: string;
  paymasterUrl: string;
  /** The console backend's base URL. */
  apiUrl: string;
}

/**
 * Derives the endpoints of the local reference stack, so a consumer can point
 * `@keelcodes/adapters` (or any ERC-4337 client) at it without hardcoding ports.
 */
export function localEndpoints(options: LocalStackOptions = {}): LocalStackEndpoints {
  const host = options.host ?? '127.0.0.1';
  const ports: LocalStackPorts = { ...DEFAULT_LOCAL_PORTS, ...options.ports };
  return {
    chainId: options.chainId ?? LOCAL_CHAIN_ID,
    rpcUrl: `http://${host}:${ports.anvil}`,
    bundlerUrl: `http://${host}:${ports.bundler}`,
    paymasterUrl: `http://${host}:${ports.paymaster}`,
    apiUrl: `http://${host}:${ports.api}`,
  };
}
