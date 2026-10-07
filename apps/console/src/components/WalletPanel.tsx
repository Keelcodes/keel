import { useAccount, useDisconnect, useSwitchChain } from 'wagmi';
import { chainName, explorerAddressUrl, shortAddress } from '../chains.js';
import { ExternalIcon } from './icons.js';

/** The console's wallet card: connection state, chain switcher and disconnect. */
export function WalletPanel({ onWallet }: { onWallet: () => void }) {
  const { address, chainId, isConnected } = useAccount();
  const { disconnect } = useDisconnect();
  const { chains, switchChain } = useSwitchChain();

  if (!isConnected || address === undefined) {
    return (
      <section className="panel wallet-panel">
        <div className="wallet-panel__intro">
          <h2>Wallet</h2>
          <p className="muted">
            No wallet connected. Connect a browser wallet to read its sessions off the chain.
          </p>
        </div>
        <button className="btn btn--gold btn--sm" onClick={onWallet}>
          Connect wallet
        </button>
      </section>
    );
  }

  const url = chainId === undefined ? undefined : explorerAddressUrl(chainId, address);

  return (
    <section className="panel wallet-panel">
      <div className="wallet-panel__intro">
        <h2>Wallet</h2>
        <p className="muted">
          {chainId === undefined ? 'Connected' : `Connected on ${chainName(chainId)}`}
        </p>
      </div>

      <div className="account-card">
        <div className="account-card__avatar" aria-hidden="true" />
        <div className="account-card__body">
          {url ? (
            <a className="account-card__address" href={url} target="_blank" rel="noreferrer">
              <code>{shortAddress(address, 6)}</code> <ExternalIcon />
            </a>
          ) : (
            <code className="account-card__address">{shortAddress(address, 6)}</code>
          )}
          <span className="account-card__chain">
            {chainId === undefined ? 'unknown chain' : chainName(chainId)}
          </span>
        </div>
      </div>

      <div className="row">
        {chains.map((chain) => (
          <button
            key={chain.id}
            className={`btn btn--sm ${chain.id === chainId ? 'btn--active' : 'btn--ghost'}`}
            onClick={() => switchChain({ chainId: chain.id })}
            disabled={chain.id === chainId}
          >
            {chain.name}
          </button>
        ))}
        <button className="btn btn--ghost btn--sm" onClick={() => disconnect()}>
          Disconnect
        </button>
      </div>
    </section>
  );
}
