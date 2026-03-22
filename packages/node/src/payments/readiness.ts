import { type Identity } from '../p2p/identity.js';
import { type BaseEscrowClient } from './evm/escrow-client.js';
import { type IdentityClient } from './evm/identity-client.js';
import { identityToEvmAddress } from './evm/keypair.js';
import { formatEther } from 'ethers';

export interface ReadinessCheck {
  name: string;
  passed: boolean;
  message: string;
  command?: string;
}

export async function checkSellerReadiness(
  identity: Identity,
  escrowClient: BaseEscrowClient,
  identityClient: IdentityClient,
): Promise<ReadinessCheck[]> {
  const checks: ReadinessCheck[] = [];
  const evmAddr = identityToEvmAddress(identity);

  // 1. ETH for gas
  const ethBalance = await escrowClient.provider.getBalance(evmAddr);
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
    message: isReg ? 'Registered' : 'Not registered. Run: antseed register',
    command: isReg ? undefined : 'antseed register',
  });

  // 3. Staked
  const account = await escrowClient.getSellerAccount(evmAddr);
  const hasStake = account.stake > 0n;
  checks.push({
    name: 'Stake',
    passed: hasStake,
    message: hasStake ? `Staked: ${account.stake}` : 'No stake. Run: antseed stake <amount>',
    command: hasStake ? undefined : 'antseed stake 10',
  });

  // 4. Token rate
  checks.push({
    name: 'Token rate',
    passed: account.tokenRate > 0n,
    message: account.tokenRate > 0n ? `Rate: ${account.tokenRate}` : 'Token rate not set',
  });

  return checks;
}

export async function checkBuyerReadiness(
  identity: Identity,
  escrowClient: BaseEscrowClient,
): Promise<ReadinessCheck[]> {
  const checks: ReadinessCheck[] = [];
  const evmAddr = identityToEvmAddress(identity);

  // 1. ETH for gas
  const ethBalance = await escrowClient.provider.getBalance(evmAddr);
  checks.push({
    name: 'Gas balance',
    passed: ethBalance > 0n,
    message: ethBalance > 0n
      ? `ETH balance: ${formatEther(ethBalance)}`
      : `No ETH for gas. Send ETH to ${evmAddr}`,
  });

  // 2. USDC in escrow
  const balance = await escrowClient.getBuyerBalance(evmAddr);
  checks.push({
    name: 'Escrow balance',
    passed: balance.available > 0n,
    message: balance.available > 0n
      ? `Available: ${balance.available}`
      : 'No USDC in escrow. Run: antseed deposit <amount>',
    command: balance.available > 0n ? undefined : 'antseed deposit 10',
  });

  return checks;
}
