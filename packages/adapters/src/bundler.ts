import { createEndpointResolver, pimlicoUrl, type EndpointResolver, type EndpointResolverOptions } from './endpoints.js';

/** Bundler providers Keel ships endpoint glue for. */
export type BundlerKind = 'pimlico' | 'alchemy' | 'cdp' | 'skandha' | 'rundler' | 'megafuel';

/** Standard ERC-4337 bundler JSON-RPC methods. */
export const BUNDLER_RPC = {
  sendUserOperation: 'eth_sendUserOperation',
  estimateUserOperationGas: 'eth_estimateUserOperationGas',
  getUserOperationReceipt: 'eth_getUserOperationReceipt',
  getUserOperationByHash: 'eth_getUserOperationByHash',
  supportedEntryPoints: 'eth_supportedEntryPoints',
} as const;

/** Resolves the bundler endpoint for a chain. */
export type BundlerAdapter = EndpointResolver<BundlerKind>;

export type BundlerAdapterOptions = EndpointResolverOptions;

/**
 * Builds a bundler adapter. Only `pimlico` has a built-in URL builder (see
 * {@link pimlicoUrl}); every other kind requires an explicit `url`/`urls`,
 * because their endpoints are account- or deployment-specific.
 *
 * The adapter resolves endpoints only — it does not implement the bundler RPC.
 * {@link BUNDLER_RPC} provides the method names to call against the endpoint.
 */
export function createBundlerAdapter(
  kind: BundlerKind,
  options: BundlerAdapterOptions,
): BundlerAdapter {
  const fallback = kind === 'pimlico' ? pimlicoUrl : undefined;
  return createEndpointResolver(kind, options, fallback);
}
