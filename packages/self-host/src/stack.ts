/**
 * The self-host reference stack, as data.
 *
 * This is the machine-readable mirror of [`infra/docker-compose.yml`](../../../infra/docker-compose.yml):
 * one entry per service, with the same image, port and dependency wiring the
 * compose file declares. Keeping it here lets the endpoint model and the
 * readiness probes share a single, testable description instead of scraping the
 * YAML.
 *
 * The AA stack is deliberately small and neutral — a chain, a deployer, a
 * bundler and a paymaster — because that is the minimum a Keel consumer needs to
 * run ERC-4337 user operations with no hosted provider in the loop. The `api`
 * service is the console's backend, added so a self-hosted deployment can show
 * the session index and settlement ledger the browser cannot read from a chain.
 */

/** The reference chain's id (Foundry's default). */
export const LOCAL_CHAIN_ID = 31337;

/**
 * Foundry's canonical development mnemonic. Every account it derives is public
 * and funded on a local chain only — never point this at anything else.
 */
export const ANVIL_MNEMONIC =
  'test test test test test test test test test test test junk';

/** Host ports the compose stack publishes. */
export const DEFAULT_LOCAL_PORTS = {
  anvil: 8545,
  bundler: 4337,
  paymaster: 3000,
  api: 8080,
} as const;

export type StackServiceRole = 'chain' | 'deployer' | 'bundler' | 'paymaster' | 'api';

/** One service in the reference stack. */
export interface StackService {
  name: string;
  image: string;
  role: StackServiceRole;
  /** Host port published by the service, when it exposes one. */
  port?: number;
  /** Services that must be healthy (or completed) first. */
  dependsOn?: readonly string[];
  /** Build context, for services built from this repo rather than pulled. */
  build?: string;
  note: string;
}

/** The reference stack, in dependency order. */
export const SELF_HOST_SERVICES: readonly StackService[] = [
  {
    name: 'anvil',
    image: 'ghcr.io/foundry-rs/foundry:latest',
    role: 'chain',
    port: 8545,
    note: `local EVM node, chain ${LOCAL_CHAIN_ID}, deterministic dev accounts`,
  },
  {
    name: 'contract-deployer',
    image: 'ghcr.io/pimlicolabs/mock-contract-deployer:main',
    role: 'deployer',
    dependsOn: ['anvil'],
    note: 'one-shot: deploys EntryPoint and the account factories, then exits',
  },
  {
    name: 'bundler',
    image: 'ghcr.io/pimlicolabs/alto:latest',
    role: 'bundler',
    port: 4337,
    dependsOn: ['anvil', 'contract-deployer'],
    note: 'ERC-4337 bundler (Alto), driven by infra/alto-config.json',
  },
  {
    name: 'paymaster',
    image: 'ghcr.io/pimlicolabs/mock-verifying-paymaster:main',
    role: 'paymaster',
    port: 3000,
    dependsOn: ['anvil', 'contract-deployer'],
    note: 'ERC-7677 paymaster service; the mock forwards to the bundler',
  },
  {
    name: 'api',
    image: 'keel-self-host-api',
    role: 'api',
    port: 8080,
    build: '../apps/api',
    note: 'console backend (session index + settlement ledger + telemetry); built from apps/api, no deps',
  },
];
