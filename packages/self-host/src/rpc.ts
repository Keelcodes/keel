import type { LocalStackEndpoints } from './endpoints.js';

/** A minimal JSON-RPC request envelope. */
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params: readonly unknown[];
}

export interface JsonRpcError {
  code: number;
  message: string;
}

export interface JsonRpcResponse {
  result?: unknown;
  error?: JsonRpcError;
}

/**
 * The subset of `fetch` this package needs. Injectable so the probes run in
 * tests and CI with no network, mirroring the port style used across Keel.
 */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** A single JSON-RPC method call bound to one endpoint. */
export type RpcCall = (method: string, params?: readonly unknown[]) => Promise<unknown>;

/** Builds an {@link RpcCall} for one JSON-RPC endpoint over an injected fetch. */
export function httpRpc(url: string, fetchImpl: FetchLike): RpcCall {
  let id = 0;
  return async (method, params = []) => {
    const request: JsonRpcRequest = { jsonrpc: '2.0', id: ++id, method, params };
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    });
    if (!response.ok) {
      throw new Error(`rpc ${method}: HTTP ${response.status}`);
    }
    const payload = (await response.json()) as JsonRpcResponse;
    if (payload.error) {
      throw new Error(`rpc ${method}: ${payload.error.code} ${payload.error.message}`);
    }
    return payload.result;
  };
}

/** One {@link RpcCall} per stack endpoint. */
export interface StackRpc {
  chain: RpcCall;
  bundler: RpcCall;
  paymaster: RpcCall;
}

/** Binds the three stack endpoints to JSON-RPC calls. */
export function stackRpc(endpoints: LocalStackEndpoints, fetchImpl: FetchLike): StackRpc {
  return {
    chain: httpRpc(endpoints.rpcUrl, fetchImpl),
    bundler: httpRpc(endpoints.bundlerUrl, fetchImpl),
    paymaster: httpRpc(endpoints.paymasterUrl, fetchImpl),
  };
}
