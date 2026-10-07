/**
 * Shared endpoint model for bundler and paymaster adapters.
 *
 * Both bundlers and paymaster services are addressed per chain rather than by
 * a single multichain URL — ERC-7677 states this explicitly for paymaster
 * services ("paymaster service URLs are not typically multichain"), and
 * bundler RPCs follow the same pattern. So an endpoint set carries one
 * optional default plus per-chain overrides.
 *
 * Keel deliberately does **not** hardcode provider hostnames beyond the one
 * provider whose URL layout is stable and public ({@link pimlicoUrl}). Every
 * other provider's endpoint is supplied by the caller, so a provider renaming
 * or re-sharding its URL can never silently break a Keel consumer.
 */

/** A concrete JSON-RPC endpoint plus optional auth headers and timeout. */
export interface Endpoint {
  url: string;
  headers?: Readonly<Record<string, string>>;
  timeoutMs?: number;
}

/** Endpoint configuration: one default, plus per-chain overrides that win. */
export interface EndpointSet {
  /** Applied to every chain without an explicit override. */
  url?: string;
  /** Per-chain overrides; take precedence over {@link url}. */
  urls?: Readonly<Record<number, string>>;
  headers?: Readonly<Record<string, string>>;
  timeoutMs?: number;
}

export interface EndpointResolverOptions extends EndpointSet {
  /**
   * Chains this adapter serves. Defaults to the keys of {@link EndpointSet.urls},
   * else `[]`.
   */
  chainIds?: readonly number[];
  /**
   * Provider API key, used only by providers with a built-in URL builder
   * (currently Pimlico).
   */
  apiKey?: string;
}

/** Resolves a per-chain endpoint for a given provider kind. */
export interface EndpointResolver<K extends string> {
  readonly kind: K;
  readonly chainIds: readonly number[];
  endpoint(args: { chainId: number }): Endpoint;
}

/**
 * Pimlico per-chain bundler/paymaster endpoint.
 * Format: `https://api.pimlico.io/v2/{chainId}/rpc?apikey={key}`.
 */
export function pimlicoUrl(chainId: number, apiKey: string): string {
  return `https://api.pimlico.io/v2/${chainId}/rpc?apikey=${encodeURIComponent(apiKey)}`;
}

/**
 * Builds an endpoint resolver. Precedence: `urls[chainId]` → `url` → provider
 * `fallback` (when the provider has one and an API key is present). Anything
 * else throws, so a missing endpoint surfaces as a config error rather than a
 * request to the wrong host.
 */
export function createEndpointResolver<K extends string>(
  kind: K,
  options: EndpointResolverOptions,
  fallback?: (chainId: number, apiKey: string) => string,
): EndpointResolver<K> {
  const chainIds = options.chainIds ?? (options.urls ? Object.keys(options.urls).map(Number) : []);
  const apiKey = options.apiKey;

  return {
    kind,
    chainIds,
    endpoint({ chainId }: { chainId: number }): Endpoint {
      const url =
        options.urls?.[chainId] ??
        options.url ??
        (fallback && apiKey ? fallback(chainId, apiKey) : undefined);
      if (!url) {
        throw new Error(`${kind}: no endpoint configured for chain ${chainId} (set urls[${chainId}] or url)`);
      }
      const endpoint: Endpoint = { url };
      if (options.headers) endpoint.headers = options.headers;
      if (options.timeoutMs !== undefined) endpoint.timeoutMs = options.timeoutMs;
      return endpoint;
    },
  };
}
