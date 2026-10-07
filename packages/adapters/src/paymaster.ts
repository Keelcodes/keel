import { createEndpointResolver, pimlicoUrl, type EndpointResolver, type EndpointResolverOptions } from './endpoints.js';

/** Paymaster providers Keel ships endpoint glue for. */
export type PaymasterKind = 'pimlico' | 'alchemy' | 'cdp' | 'megafuel';

/** Standard ERC-7677 paymaster web-service JSON-RPC methods. */
export const PAYMASTER_RPC = {
  getPaymasterStubData: 'pm_getPaymasterStubData',
  getPaymasterData: 'pm_getPaymasterData',
} as const;

/** Resolves the paymaster service endpoint for a chain. */
export type PaymasterAdapter = EndpointResolver<PaymasterKind>;

export type PaymasterAdapterOptions = EndpointResolverOptions;

/**
 * Builds a paymaster adapter. Per ERC-7677 a paymaster service URL is provided
 * per chain, so the endpoint is resolved per chain rather than assumed to be
 * multichain. Only `pimlico` has a built-in URL builder; the rest require an
 * explicit `url`/`urls`.
 *
 * The adapter resolves endpoints only — it does not implement the paymaster
 * RPC. {@link PAYMASTER_RPC} provides the method names to call against the
 * endpoint; provider-specific `context` fields are owned by the caller, since
 * ERC-7677 leaves `context` to each provider.
 */
export function createPaymasterAdapter(
  kind: PaymasterKind,
  options: PaymasterAdapterOptions,
): PaymasterAdapter {
  const fallback = kind === 'pimlico' ? pimlicoUrl : undefined;
  return createEndpointResolver(kind, options, fallback);
}
