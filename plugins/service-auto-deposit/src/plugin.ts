import type { AntseedServicePlugin } from '@antseed/node';
import { createAutoDepositService } from './factory.js';

export const autoDepositPlugin: AntseedServicePlugin = {
  type: 'service',
  kind: 'funding',
  name: 'auto-deposit',
  displayName: 'Auto Deposit',
  version: '0.1.0',
  description: 'Automatically move USDC sent to your wallet into the network so it can buy services. No ETH needed: gas is paid in USDC via the Circle Paymaster, and transactions are relayed by the Pimlico bundler. Your wallet is upgraded once (EIP-7702) on the first deposit.',
  capabilities: ['wallet', 'chain'],
  createService(host) {
    return createAutoDepositService(host);
  },
};

export default autoDepositPlugin;
