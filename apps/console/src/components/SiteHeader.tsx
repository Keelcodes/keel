import { useAccount } from 'wagmi';
import { chainName, shortAddress } from '../chains.js';
import type { Route } from '../router.js';
import { BrandMark } from './icons.js';

interface SiteHeaderProps {
  route: Route;
  onNavigate: (route: Route) => void;
  onWallet: () => void;
}

/** Sticky site header: brand, section nav, wallet button and console launch. */
export function SiteHeader({ route, onNavigate, onWallet }: SiteHeaderProps) {
  const { address, chainId, isConnected } = useAccount();

  return (
    <header className="site-header">
      <div className="site-header__inner">
        <button className="brand" onClick={() => onNavigate('landing')} aria-label="Keel home">
          <BrandMark />
          <span className="brand__name">Keel</span>
        </button>

        {route === 'landing' ? (
          <nav className="site-nav" aria-label="Sections">
            <a href="#capabilities">Capabilities</a>
            <a href="#architecture">Architecture</a>
            <a href="#deployments">Deployments</a>
          </nav>
        ) : (
          <nav className="site-nav" aria-label="Sections">
            <button className="link-btn" onClick={() => onNavigate('landing')}>
              ← Back to site
            </button>
          </nav>
        )}

        <div className="site-header__actions">
          <button
            className={isConnected ? 'wallet-chip' : 'btn btn--gold btn--sm'}
            onClick={onWallet}
          >
            {isConnected && address !== undefined ? (
              <>
                <span className="wallet-chip__dot" aria-hidden="true" />
                {shortAddress(address, 4)}
                {chainId === undefined ? null : (
                  <span className="wallet-chip__chain">{chainName(chainId)}</span>
                )}
              </>
            ) : (
              'Connect wallet'
            )}
          </button>
          {route === 'landing' ? (
            <button className="btn btn--ghost btn--sm" onClick={() => onNavigate('console')}>
              Launch console
            </button>
          ) : null}
        </div>
      </div>
    </header>
  );
}
