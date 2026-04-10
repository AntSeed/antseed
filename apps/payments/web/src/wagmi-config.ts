import { getDefaultConfig } from '@rainbow-me/rainbowkit';
import { base } from 'wagmi/chains';
import { http, fallback } from 'viem';

// Use a fallback chain of RPCs so we don't get rate-limited by the public
// Base endpoint (mainnet.base.org returns 429 under any concurrent load).
// viem's fallback transport rotates on failure and re-ranks healthy nodes.
export const wagmiConfig = getDefaultConfig({
  appName: 'AntSeed Payments',
  projectId: '9a1851410cb5589bc351a6dabf17140e',
  chains: [base],
  transports: {
    [base.id]: fallback([
      http('https://base.llamarpc.com'),
      http('https://base-rpc.publicnode.com'),
      http('https://mainnet.base.org'),
    ]),
  },
});
