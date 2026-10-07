import { useEffect, type CSSProperties } from 'react';
import { ENTRY_POINT_V07, KEEL_POLICY_HOOK, SUPPORTED_CHAINS, shortAddress } from '../chains.js';
import { ExternalIcon, Glyph, type GlyphName } from '../components/icons.js';

const GITHUB = 'https://github.com/Keelcodes/keel';

interface Capability {
  glyph: GlyphName;
  title: string;
  body: string;
  tag: string;
  wide?: boolean;
}

const CAPABILITIES: readonly Capability[] = [
  {
    glyph: 'shield',
    title: 'Enforcement inside the execution path',
    body: 'KeelPolicyHook runs as an ERC-7579 hook, so limits are charged while the account executes — not in an off-chain pre-check a session key could skip. Every violation reverts the call.',
    tag: 'module type 4',
    wide: true,
  },
  {
    glyph: 'union',
    title: 'Many sessions per account',
    body: 'An account installs any number of sessions; a call is admitted if any session allows it, and the first admitting session is charged. Each attempt is trial-and-commit, so a rejection leaves nothing behind.',
    tag: 'union semantics',
  },
  {
    glyph: 'coins',
    title: 'Per-call, per-day, per-token',
    body: 'Cap value per transaction, spend per token per day, and total call count. Accrual is keyed by (account, sessionId), so reinstalling under a new id starts a fresh epoch.',
    tag: 'daily accounting',
  },
  {
    glyph: 'envelope',
    title: 'Aggregate budgets, optionally',
    body: 'Bind a session to an ERC-8312 envelope and its cross-call budget is charged on the same atomic path, on top of the per-call policy. Unbound sessions behave exactly as before.',
    tag: 'ERC-8312',
  },
  {
    glyph: 'flask',
    title: 'Check any account, live',
    body: 'Run the ERC-7579 conformance suite from the console against a connected account and the deployed hook — the same suite the packages ship.',
    tag: 'conformance',
  },
];

interface Layer {
  label: string;
  title: string;
  body: string;
  items: readonly string[];
}

const LAYERS: readonly Layer[] = [
  {
    label: 'account',
    title: 'Any ERC-7579 modular account',
    body: 'Kernel, Nexus and Safe7579 alike. The hook is account-agnostic: the account calls preCheck, so msg.sender is the account and storage keys by it for every implementation.',
    items: ['ERC-4337 v0.7', 'execute(bytes32,bytes)', 'account-agnostic'],
  },
  {
    label: 'policy',
    title: 'The hook is the enforcement point',
    body: 'A validator cannot keep per-rule daily accounting under ERC-7562 storage rules. A hook runs during execution, so it may read and write its own storage — per-tx, per-day, per-token and call ceilings are enforced for real.',
    items: ['fail-closed', 'trial-and-commit', 'CREATE2 address'],
  },
  {
    label: 'settlement',
    title: 'Settlement, when you run it',
    body: 'x402, MPP and ERC-8183 escrow receipts are modelled by @keelcodes/settlement. The service is self-hosted and is deliberately not deployed on this site, so the console shows no settlement rows.',
    items: ['x402', 'MPP', 'ERC-8183 escrow'],
  },
];

/** Adds the `is-visible` class to `[data-reveal]` elements as they scroll in. */
function useReveal() {
  useEffect(() => {
    const targets = Array.from(document.querySelectorAll<HTMLElement>('[data-reveal]'));
    if (targets.length === 0) return;

    if (typeof IntersectionObserver === 'undefined') {
      for (const el of targets) el.classList.add('is-visible');
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-visible');
            observer.unobserve(entry.target);
          }
        }
      },
      { rootMargin: '0px 0px -12% 0px', threshold: 0.15 },
    );

    for (const el of targets) observer.observe(el);
    return () => observer.disconnect();
  }, []);
}

export function LandingPage({ onLaunch }: { onLaunch: () => void }) {
  useReveal();

  return (
    <main className="landing">
      <section className="hero">
        <div className="hero__inner">
          <div className="hero__copy">
            <span className="eyebrow">
              <span className="eyebrow__dot" aria-hidden="true" />
              ERC-7579 policy hook · live on BSC, Base and Ethereum
            </span>
            <h1>Programmable limits for on-chain agents.</h1>
            <p className="hero__lede">
              Keel caps what an autonomous agent can do — per call, per day and per token — inside the
              account&rsquo;s execution path. Real on-chain enforcement, not an off-chain pre-check.
            </p>
            <div className="hero__cta">
              <button className="btn btn--gold" onClick={onLaunch}>
                Launch console
              </button>
              <a className="btn btn--ghost" href={GITHUB} target="_blank" rel="noreferrer">
                Read the docs <ExternalIcon />
              </a>
            </div>
            <ul className="hero__chains">
              {SUPPORTED_CHAINS.map((chain) => (
                <li key={chain.id}>
                  <span className="chain-chip">
                    <span className="chain-chip__dot" aria-hidden="true" />
                    {chain.name}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          <div className="hero__visual" aria-hidden="true">
            <div className="policy-card">
              <div className="policy-card__head">
                <span className="policy-card__label">example policy</span>
                <span className="badge active">active</span>
              </div>
              <h3 className="policy-card__title">Session · transfer cap</h3>
              <dl className="policy-rows">
                <div className="policy-row">
                  <dt>target</dt>
                  <dd>
                    <code>USDC</code> on Base
                  </dd>
                </div>
                <div className="policy-row">
                  <dt>max / tx</dt>
                  <dd>
                    <code>500.00</code> USDC
                  </dd>
                </div>
                <div className="policy-row">
                  <dt>max / day</dt>
                  <dd>
                    <code>2,000.00</code> USDC
                  </dd>
                </div>
                <div className="policy-row">
                  <dt>valid until</dt>
                  <dd>+ 5 days</dd>
                </div>
              </dl>
            </div>

            <div className="usage-card">
              <span className="usage-card__label">spent today</span>
              <span className="usage-card__value">812.40 USDC</span>
              <span className="usage-bar">
                <span className="usage-bar__fill" style={{ width: '41%' }} />
              </span>
              <span className="usage-card__foot">41% of the daily ceiling</span>
            </div>
          </div>
        </div>
      </section>

      <section className="section" id="capabilities">
        <header className="section__head" data-reveal>
          <h2>Enforcement that lives where the calls happen</h2>
          <p className="section__lede">
            Four moving parts, one guarantee: if the policy says no, the transaction reverts.
          </p>
        </header>
        <div className="bento">
          {CAPABILITIES.map((card) => (
            <article
              key={card.title}
              className={`card${card.wide === true ? ' card--wide' : ''}`}
              data-reveal
            >
              <span className="card__glyph">
                <Glyph name={card.glyph} />
              </span>
              <span className="card__tag">{card.tag}</span>
              <h3>{card.title}</h3>
              <p>{card.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="section" id="architecture">
        <div className="architecture">
          <div className="architecture__aside">
            <h2>Three layers, one execution path</h2>
            <p className="section__lede">
              Keel sits between the account that executes and the services that settle, so the policy is
              checked at the only moment it matters.
            </p>
            <div className="deployment-facts">
              <div>
                <span className="fact__label">KeelPolicyHook</span>
                <code>{shortAddress(KEEL_POLICY_HOOK, 10)}</code>
              </div>
              <div>
                <span className="fact__label">EntryPoint v0.7</span>
                <code>{shortAddress(ENTRY_POINT_V07, 8)}</code>
              </div>
              <div>
                <span className="fact__label">address</span>
                <span>identical on all three chains</span>
              </div>
            </div>
          </div>

          <ol className="architecture__layers">
            {LAYERS.map((layer, index) => (
              <li key={layer.label} className="layer" data-reveal style={{ '--i': index } as CSSProperties}>
                <span className="layer__index">{String(index + 1).padStart(2, '0')}</span>
                <div className="layer__body">
                  <span className="layer__label">{layer.label}</span>
                  <h3>{layer.title}</h3>
                  <p>{layer.body}</p>
                  <ul className="layer__items">
                    {layer.items.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="section deployments" id="deployments">
        <header className="section__head" data-reveal>
          <h2>The same hook, on every chain you ship to</h2>
          <p className="section__lede">
            Deployed with CREATE2, so the console reads one address on BSC, Base and Ethereum.
          </p>
        </header>
        <div className="deployment-grid">
          {SUPPORTED_CHAINS.map((chain) => (
            <a
              key={chain.id}
              className="deployment"
              data-reveal
              href={`${chain.explorer}/address/${KEEL_POLICY_HOOK}`}
              target="_blank"
              rel="noreferrer"
            >
              <span className="deployment__chain">{chain.name}</span>
              <code className="deployment__addr">{shortAddress(KEEL_POLICY_HOOK, 8)}</code>
              <span className="deployment__meta">deployed at block {chain.deployBlock.toLocaleString()}</span>
              <span className="deployment__link">
                View on explorer <ExternalIcon />
              </span>
            </a>
          ))}
        </div>
      </section>

      <section className="cta-band" data-reveal>
        <div className="cta-band__inner">
          <h2>Give your agents an account they can&rsquo;t overspend.</h2>
          <p>
            Connect a wallet and read your installed sessions straight off the chain, or run the ERC-7579
            suite against the deployed hook.
          </p>
          <div className="hero__cta">
            <button className="btn btn--gold" onClick={onLaunch}>
              Launch console
            </button>
            <a className="btn btn--ghost" href={GITHUB} target="_blank" rel="noreferrer">
              View on GitHub <ExternalIcon />
            </a>
          </div>
        </div>
      </section>
    </main>
  );
}
