import { getDefaultConfig } from '@rainbow-me/rainbowkit';
import { base } from 'wagmi/chains';
import { http, fallback } from 'viem';

// Mirror of `apps/payments/web/src/wagmi-config.ts` (same WalletConnect project
// + RPC fallback order benchmarked there). If this list drifts, update both
// — a shared `packages/wallet-config` is the next step if a third app adopts it.
export const wagmiConfig = getDefaultConfig({
  appName: 'AntSeed DIEM Staking',
  projectId: '9a1851410cb5589bc351a6dabf17140e',
  chains: [base],
  transports: {
    [base.id]: fallback([
      http('https://base-rpc.publicnode.com'),
      http('https://base.gateway.tenderly.co'),
      http('https://base-public.nodies.app'),
    ]),
  },
});
