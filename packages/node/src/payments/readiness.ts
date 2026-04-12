import { type Identity } from '../p2p/identity.js';
import { type DepositsClient } from './evm/deposits-client.js';
import { type IdentityClient } from './evm/identity-client.js';
import { type StakingClient } from './evm/staking-client.js';
import { formatEther } from 'ethers';

export interface ReadinessCheck {
  name: string;
  passed: boolean;
  message: string;
  command?: string;
}

export async function checkSellerReadiness(
  identity: Identity,
  identityClient: IdentityClient,
  stakingClient: StakingClient,
): Promise<ReadinessCheck[]> {
  const checks: ReadinessCheck[] = [];
  const evmAddr = identity.wallet.address;

  // 1. ETH for gas
  const ethBalance = await stakingClient.provider.getBalance(evmAddr);
  checks.push({
    name: 'Gas balance',
    passed: ethBalance > 0n,
    message: ethBalance > 0n
      ? `ETH balance: ${formatEther(ethBalance)}`
      : `No ETH for gas fees. Send ETH to ${evmAddr}`,
  });

  // 2. Registered
  const isReg = await identityClient.isRegistered(evmAddr);
  checks.push({
    name: 'Peer registration',
    passed: isReg,
    message: isReg ? 'Registered' : 'Not registered. Run: antseed seller register',
    command: isReg ? undefined : 'antseed seller register',
  });

  // 3. Staked
  const stake = await stakingClient.getStake(evmAddr);
  const hasStake = stake > 0n;
  checks.push({
    name: 'Stake',
    passed: hasStake,
    message: hasStake ? `Staked: ${stake}` : 'No stake. Run: antseed seller stake <amount>',
    command: hasStake ? undefined : 'antseed seller stake 10',
  });

  return checks;
}

export async function checkBuyerReadiness(
  identity: Identity,
  depositsClient: DepositsClient,
): Promise<ReadinessCheck[]> {
  const checks: ReadinessCheck[] = [];
  const evmAddr = identity.wallet.address;

  // 1. ETH for gas
  const ethBalance = await depositsClient.provider.getBalance(evmAddr);
  checks.push({
    name: 'Gas balance',
    passed: ethBalance > 0n,
    message: ethBalance > 0n
      ? `ETH balance: ${formatEther(ethBalance)}`
      : `No ETH for gas. Send ETH to ${evmAddr}`,
  });

  // 2. USDC in deposits
  const balance = await depositsClient.getBuyerBalance(evmAddr);
  checks.push({
    name: 'Deposit balance',
    passed: balance.available > 0n,
    message: balance.available > 0n
      ? `Available: ${balance.available}`
      : 'No USDC deposited. Run: antseed buyer deposit <amount>',
    command: balance.available > 0n ? undefined : 'antseed buyer deposit 10',
  });

  return checks;
}
