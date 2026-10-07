import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WagmiProvider } from 'wagmi';
import { App } from './App.js';
import { config } from './wagmi.js';
import './styles.css';

const queryClient = new QueryClient();

const container = document.getElementById('root');
if (container === null) {
  throw new Error('console: #root container is missing from index.html');
}

createRoot(container).render(
  <StrictMode>
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </WagmiProvider>
  </StrictMode>,
);
