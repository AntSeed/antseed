import { useAccount, useBalance, useReadContract } from 'wagmi';
import { base } from 'viem/chains';
import { useMemo } from 'react';
import { checkPaymentReadiness, type PaymentReadiness } from '../../modules/payment-state';

const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const ESCROW_ADDRESS = '0x0000000000000000000000000000000000000000'; // TODO: from config

const ESCROW_ABI = [{
  name: 'getBuyerBalance',
  type: 'function',
  stateMutability: 'view',
  inputs: [{ name: 'buyer', type: 'address' }],
  outputs: [
    { name: 'available', type: 'uint256' },
    { name: 'reserved', type: 'uint256' },
    { name: 'pendingWithdrawal', type: 'uint256' },
    { name: 'lastActivity', type: 'uint256' },
  ],
}] as const;

export function usePaymentState(sellerPeerId: string | null, hasActiveSession: boolean): PaymentReadiness {
  const { address, isConnected } = useAccount();

  const { data: usdcBalance } = useBalance({
    address,
    token: USDC_ADDRESS,
    chainId: base.id,
    query: { enabled: isConnected, refetchInterval: 30_000 },
  });

  const { data: escrowData } = useReadContract({
    address: ESCROW_ADDRESS as `0x${string}`,
    abi: ESCROW_ABI,
    functionName: 'getBuyerBalance',
    args: address ? [address] : undefined,
    chainId: base.id,
    query: { enabled: isConnected && !!address, refetchInterval: 30_000 },
  });

  return useMemo(() => checkPaymentReadiness({
    walletConnected: isConnected,
    walletUsdcBalance: usdcBalance?.value ?? 0n,
    escrowBalance: escrowData ? escrowData[0] : 0n,
    hasActiveSession,
    sellerPeerId,
  }), [isConnected, usdcBalance?.value, escrowData, hasActiveSession, sellerPeerId]);
}
