import { http, createConfig, type CreateConnectorFn } from 'wagmi';
import { base, bsc, mainnet } from 'wagmi/chains';
import { walletConnect } from 'wagmi/connectors';

/**
 * The console's wagmi config: BSC, Base and Ethereum.
 *
 * Only real, named wallets are offered. wagmi's EIP-6963 discovery is on, so
 * every installed extension (MetaMask, OKX, Rabby, Coinbase and friends)
 * announces itself and is registered under its own name and icon — which is why
 * no generic `injected()` connector is declared: it would only add an
 * "Injected / Browser Wallet" entry that means nothing to a normal user.
 * WalletConnect is added on top when `VITE_WC_PROJECT_ID` is set, covering
 * mobile and wallet-less browsers; blank, it is absent rather than half-wired.
 *
 * wagmi treats the **first** entry of `chains` as the default, so `bsc` leads —
 * that order and `DEFAULT_CHAIN_ID` in `chains.ts` have to agree.
 *
 * RPC URLs come from `VITE_RPC_*` when set and fall back to viem's public
 * defaults otherwise, so a fresh clone runs with no configuration.
 */

const projectId = import.meta.env.VITE_WC_PROJECT_ID;
const walletConnectProjectId =
  typeof projectId === 'string' && projectId.trim().length > 0 ? projectId.trim() : undefined;

const connectors: CreateConnectorFn[] =
  walletConnectProjectId === undefined
    ? []
    : [walletConnect({ projectId: walletConnectProjectId, showQrModal: true })];

export const config = createConfig({
  chains: [bsc, base, mainnet],
  connectors,
  multiInjectedProviderDiscovery: true,
  transports: {
    [base.id]: http(import.meta.env.VITE_RPC_BASE),
    [mainnet.id]: http(import.meta.env.VITE_RPC_ETHEREUM),
    [bsc.id]: http(import.meta.env.VITE_RPC_BSC),
  },
});

declare module 'wagmi' {
  interface Register {
    config: typeof config;
  }
}
