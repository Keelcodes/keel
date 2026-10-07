import { useEffect, useState } from 'react';
import { useAccount, useConnect, useDisconnect, useSwitchChain } from 'wagmi';
import { chainName, explorerAddressUrl, shortAddress } from '../chains.js';
import { describeConnector } from '../wallet.js';
import { ExternalIcon } from './icons.js';

/**
 * The wallet picker. Extension wallets are listed by their discovered name and
 * icon (EIP-6963); WalletConnect appears only when a project id is configured.
 * Once connected the same panel becomes the account view: address, chain
 * switcher, explorer link and disconnect.
 */
export function ConnectWalletModal({ onClose }: { onClose: () => void }) {
  const { address, chainId, isConnected } = useAccount();
  const { connectors, connect, isPending, error, reset } = useConnect();
  const { disconnect } = useDisconnect();
  const { chains, switchChain } = useSwitchChain();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    if (isConnected) reset();
  }, [isConnected, reset]);

  async function copyAddress() {
    if (address === undefined) return;
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }

  const explorer = chainId === undefined || address === undefined ? undefined : explorerAddressUrl(chainId, address);

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="Connect a wallet">
      <button className="modal__scrim" aria-label="Close" onClick={onClose} />
      <div className="modal__card">
        <div className="modal__head">
          <h2>{isConnected ? 'Wallet' : 'Connect a wallet'}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        {!isConnected ? (
          <>
            <p className="modal__lede">
              Extension wallets are detected automatically. Pick one to read your sessions off the chain.
            </p>
            <ul className="wallet-list">
              {connectors.map((connector) => {
                const wallet = describeConnector(connector);
                return (
                  <li key={wallet.uid}>
                    <button
                      className="wallet-option"
                      onClick={() => connect({ connector })}
                      disabled={isPending}
                    >
                      <WalletAvatar wallet={wallet} />
                      <span className="wallet-option__name">{wallet.name}</span>
                      <span className="wallet-option__kind">
                        {wallet.kind === 'walletconnect' ? 'QR / mobile' : 'browser'}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
            {connectors.length === 0 ? (
              <p className="modal__note">
                No wallet detected. Install a browser wallet such as MetaMask, OKX or Rabby, then reload.
              </p>
            ) : null}
            {error ? <p className="error">{error.message}</p> : null}
          </>
        ) : (
          <>
            <div className="account-card">
              <div className="account-card__avatar" aria-hidden="true" />
              <div className="account-card__body">
                <code className="account-card__address">{address}</code>
                <span className="account-card__chain">
                  {chainId === undefined ? 'unknown chain' : chainName(chainId)}
                </span>
              </div>
            </div>
            <div className="row">
              <button className="btn btn--ghost btn--sm" onClick={copyAddress}>
                {copied ? 'Copied' : 'Copy address'}
              </button>
              {explorer ? (
                <a className="btn btn--ghost btn--sm" href={explorer} target="_blank" rel="noreferrer">
                  Explorer <ExternalIcon />
                </a>
              ) : null}
            </div>

            <p className="modal__label">Network</p>
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
            </div>

            <div className="modal__foot">
              <button
                className="btn btn--ghost btn--sm"
                onClick={() => {
                  disconnect();
                  onClose();
                }}
              >
                Disconnect
              </button>
              <span className="modal__hint">{shortAddress(address ?? '', 6)}</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function WalletAvatar({ wallet }: { wallet: ReturnType<typeof describeConnector> }) {
  if (wallet.icon !== undefined && wallet.icon.length > 0) {
    return <img className="wallet-avatar" src={wallet.icon} alt="" />;
  }
  return (
    <span className={`wallet-avatar wallet-avatar--mono ${wallet.kind}`} aria-hidden="true">
      {wallet.monogram}
    </span>
  );
}
