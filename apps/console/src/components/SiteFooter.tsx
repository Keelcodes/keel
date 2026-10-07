import { ENTRY_POINT_V07, KEEL_POLICY_HOOK, SUPPORTED_CHAINS, shortAddress } from '../chains.js';
import type { Route } from '../router.js';
import { BrandMark, ExternalIcon } from './icons.js';

const GITHUB = 'https://github.com/Keelcodes/keel';
const NPM = 'https://www.npmjs.com/org/keelcodes';

/** Site footer: identity, developer entry points and the on-chain deployments. */
export function SiteFooter({ onNavigate }: { onNavigate: (route: Route) => void }) {
  return (
    <footer className="site-footer">
      <div className="site-footer__inner">
        <div className="site-footer__brand">
          <div className="brand brand--static">
            <BrandMark />
            <span className="brand__name">Keel</span>
          </div>
          <p className="site-footer__tagline">
            Authorization and settlement infrastructure for on-chain agent accounts.
          </p>
          <code className="site-footer__addr">
            hook {shortAddress(KEEL_POLICY_HOOK, 8)} · entrypoint {shortAddress(ENTRY_POINT_V07, 6)}
          </code>
        </div>

        <nav className="site-footer__col" aria-label="Product">
          <h3>Product</h3>
          <button className="link-btn" onClick={() => onNavigate('console')}>
            Console
          </button>
          <a href="#capabilities">Capabilities</a>
          <a href="#architecture">Architecture</a>
        </nav>

        <nav className="site-footer__col" aria-label="Developers">
          <h3>Developers</h3>
          <a href={GITHUB} target="_blank" rel="noreferrer">
            GitHub <ExternalIcon />
          </a>
          <a href={NPM} target="_blank" rel="noreferrer">
            npm @keelcodes <ExternalIcon />
          </a>
          <a href={`${GITHUB}/blob/main/docs/RUNBOOK.md`} target="_blank" rel="noreferrer">
            Runbook <ExternalIcon />
          </a>
        </nav>

        <nav className="site-footer__col" aria-label="Deployments">
          <h3>Deployments</h3>
          {SUPPORTED_CHAINS.map((chain) => (
            <a
              key={chain.id}
              href={`${chain.explorer}/address/${KEEL_POLICY_HOOK}`}
              target="_blank"
              rel="noreferrer"
            >
              {chain.name} <ExternalIcon />
            </a>
          ))}
        </nav>
      </div>

      <div className="site-footer__base">
        <span>Apache-2.0 · Keel contributors</span>
        <span className="site-footer__note">
          Console reads sessions live from KeelPolicyHook; settlement is self-hosted and not deployed here.
        </span>
      </div>
    </footer>
  );
}
