import { getDefaultConfig } from '@rainbow-me/rainbowkit';
import { base } from 'wagmi/chains';
import { http, fallback } from 'viem';

// publicnode is the most reliable public Base endpoint we've tested —
// it handles concurrent eth_call reads without 429s, unlike llamarpc
// and mainnet.base.org which rate-limit under trivial load. Mirrors the
// @antseed/node default. mainnet.base.org is kept as a last-resort
// fallback so a publicnode blip doesn't break the deposit flow.
export const wagmiConfig = getDefaultConfig({
  appName: 'AntSeed Payments',
  projectId: '9a1851410cb5589bc351a6dabf17140e',
  chains: [base],
  transports: {
    [base.id]: fallback([
      http('https://base-rpc.publicnode.com'),
      http('https://mainnet.base.org'),
    ]),
  },
});
