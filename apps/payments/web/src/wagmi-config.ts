import { getDefaultConfig } from '@rainbow-me/rainbowkit';
import { base } from 'wagmi/chains';

export const wagmiConfig = getDefaultConfig({
  appName: 'AntSeed Payments',
  projectId: '9a1851410cb5589bc351a6dabf17140e',
  chains: [base],
});
