import { createRoot } from 'react-dom/client';
import { WagmiProvider } from 'wagmi';
import { RainbowKitProvider, lightTheme } from '@rainbow-me/rainbowkit';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { wagmiConfig } from './wagmi-config';
import { App } from './App';
import '@rainbow-me/rainbowkit/styles.css';
import './styles.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Most reads are polled by individual hooks; the client-level default
      // is a gentle fallback that keeps multicall responses warm.
      staleTime: 10_000,
      refetchOnWindowFocus: false,
    },
  },
});

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('#root not found in index.html');

createRoot(rootEl).render(
  <WagmiProvider config={wagmiConfig}>
    <QueryClientProvider client={queryClient}>
      <RainbowKitProvider
        theme={lightTheme({
          accentColor: '#1FD87A',
          accentColorForeground: '#0a0e14',
          borderRadius: 'large',
          fontStack: 'system',
        })}
      >
        <App />
      </RainbowKitProvider>
    </QueryClientProvider>
  </WagmiProvider>,
);
