import type { ReactNode } from 'react';
import { WagmiProvider } from 'wagmi';
import { RainbowKitProvider } from '@rainbow-me/rainbowkit';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { wagmiConfig } from './lib/wagmi-config';
import { AuthorizedWalletProvider } from './context/authorized-wallet-context';
import { useConfig } from './hooks/queries';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

export function Providers({ children }: { children: ReactNode }) {
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider>
          <AuthorizedWalletGate>{children}</AuthorizedWalletGate>
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}

// AuthorizedWalletProvider needs the runtime payment config, which is fetched
// via react-query — so it must live inside QueryClientProvider.
function AuthorizedWalletGate({ children }: { children: ReactNode }) {
  const { data: config = null } = useConfig();
  return <AuthorizedWalletProvider config={config}>{children}</AuthorizedWalletProvider>;
}
