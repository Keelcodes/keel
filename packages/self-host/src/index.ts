/**
 * @keelcodes/self-host
 *
 * The reference stack a Keel consumer runs when it wants no hosted bundler or
 * paymaster in the loop — the OxaChain path, and the local sandbox every other
 * chain can be tested against.
 *
 * The deployable artifact is
 * [`infra/docker-compose.yml`](../../../infra/docker-compose.yml); this package
 * is its typed companion: the service model, the endpoint derivation and the
 * readiness probes. It has no runtime dependencies.
 */

export {
  ANVIL_MNEMONIC,
  DEFAULT_LOCAL_PORTS,
  LOCAL_CHAIN_ID,
  SELF_HOST_SERVICES,
} from './stack.js';
export type { StackService, StackServiceRole } from './stack.js';

export { localEndpoints } from './endpoints.js';
export type { LocalStackEndpoints, LocalStackOptions, LocalStackPorts } from './endpoints.js';

export { httpRpc, stackRpc } from './rpc.js';
export type {
  FetchLike,
  JsonRpcError,
  JsonRpcRequest,
  JsonRpcResponse,
  RpcCall,
  StackRpc,
} from './rpc.js';

export { checkBundler, checkChain, waitForStack } from './health.js';
export type { StackReadiness, WaitForStackOptions } from './health.js';
