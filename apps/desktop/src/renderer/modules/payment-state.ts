import type { PaymentAction } from '../ui/components/chat/payment-types';

export type PaymentReadiness =
  | { ready: true }
  | { ready: false; action: PaymentAction; meta?: Record<string, unknown> };

/**
 * Determine what payment action (if any) is needed before a message can be sent.
 * Called by the chat module's sendMessage flow.
 *
 * @param walletConnected - is a wallet connected via wagmi?
 * @param walletUsdcBalance - USDC balance in the wallet (base units)
 * @param escrowBalance - USDC deposited in escrow (base units)
 * @param hasActiveSession - does the buyer have a confirmed session with this seller?
 * @param sellerPeerId - the target seller's peer ID
 */
export function checkPaymentReadiness(params: {
  walletConnected: boolean;
  walletUsdcBalance: bigint;
  escrowBalance: bigint;
  hasActiveSession: boolean;
  sellerPeerId: string | null;
}): PaymentReadiness {
  const { walletConnected, walletUsdcBalance, escrowBalance, hasActiveSession, sellerPeerId } = params;

  // Step 1: Need wallet
  if (!walletConnected) {
    return { ready: false, action: 'connect-wallet' };
  }

  // Step 2: Need USDC in wallet or escrow
  if (walletUsdcBalance === 0n && escrowBalance === 0n) {
    return { ready: false, action: 'fund-wallet' };
  }

  // Step 3: Need deposit in escrow
  if (escrowBalance === 0n && walletUsdcBalance > 0n) {
    return { ready: false, action: 'deposit-escrow', meta: { suggestedAmount: walletUsdcBalance.toString() } };
  }

  // Step 4: Need active session with seller (SpendingAuth)
  if (!hasActiveSession && sellerPeerId) {
    return { ready: false, action: 'sign-spending-auth' };
  }

  // Ready to send
  return { ready: true };
}
