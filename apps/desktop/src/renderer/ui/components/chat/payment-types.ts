/**
 * Payment bubble types — rendered inline in chat as system messages.
 * Discriminated by meta.paymentAction.
 */
export type PaymentAction =
  | 'connect-wallet'
  | 'fund-wallet'
  | 'deposit-escrow'
  | 'sign-spending-auth'
  | 'topup-auth';

export type PaymentBubbleMeta = {
  paymentAction: PaymentAction;
  /** For sign-spending-auth: EIP-712 domain + message */
  authRequest?: {
    seller: string;
    sellerPeerId: string;
    sessionId: string;
    maxAmount: string;       // USDC base units as string
    nonce: number;
    deadline: number;
    previousConsumption: string;
    previousSessionId: string;
  };
  /** For deposit-escrow: suggested deposit amount */
  suggestedAmount?: string;
  /** Completion callback key (used by orchestrator) */
  callbackId?: string;
};

/** Helper to check if a ChatMessage is a payment bubble */
export function isPaymentBubble(msg: { role: string; meta?: Record<string, unknown> }): boolean {
  return msg.role === 'system' && typeof msg.meta?.paymentAction === 'string';
}

/** Extract payment meta from a ChatMessage */
export function getPaymentMeta(msg: { meta?: Record<string, unknown> }): PaymentBubbleMeta | null {
  if (!msg.meta?.paymentAction) return null;
  return msg.meta as unknown as PaymentBubbleMeta;
}
