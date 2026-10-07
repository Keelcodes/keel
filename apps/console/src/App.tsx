import { useState } from 'react';
import { ConnectWalletModal } from './components/ConnectWalletModal.js';
import { SiteFooter } from './components/SiteFooter.js';
import { SiteHeader } from './components/SiteHeader.js';
import { ConsolePage } from './pages/ConsolePage.js';
import { LandingPage } from './pages/LandingPage.js';
import { useRoute } from './router.js';

/**
 * The site serves two roles from one bundle: the landing page at `/` and the
 * working console at `/console`. The wallet picker is modal and shared by both,
 * so "Connect wallet" behaves the same wherever it is clicked.
 */
export function App() {
  const [route, navigate] = useRoute();
  const [walletOpen, setWalletOpen] = useState(false);

  return (
    <div className="site">
      <SiteHeader route={route} onNavigate={navigate} onWallet={() => setWalletOpen(true)} />
      {route === 'console' ? (
        <ConsolePage onWallet={() => setWalletOpen(true)} />
      ) : (
        <LandingPage onLaunch={() => navigate('console')} />
      )}
      <SiteFooter onNavigate={navigate} />
      {walletOpen ? <ConnectWalletModal onClose={() => setWalletOpen(false)} /> : null}
    </div>
  );
}
