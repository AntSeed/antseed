// EVM integration
export { EscrowClient, EscrowClient as BaseEscrowClient } from './evm/escrow-client.js';
export type {
  EscrowConfig,
  EscrowConfig as BaseEscrowConfig,
  BuyerBalance,
  SessionAuthInfo,
  ReputationData,
} from './evm/escrow-client.js';

export { identityToEvmWallet, identityToEvmAddress } from './evm/keypair.js';
export {
  SPENDING_AUTH_TYPES,
  makeEscrowDomain,
  signSpendingAuth,
  signMessageEd25519,
  buildReceiptMessage,
  buildAckMessage,
  verifyMessageEd25519,
  // Legacy
  signMessageEcdsa,
} from './evm/signatures.js';
export type { SpendingAuthMessage } from './evm/signatures.js';
export { getWalletInfo, getAddress } from './evm/wallet.js';

// Payment managers
export { BuyerPaymentManager } from './buyer-payment-manager.js';
export type {
  BuyerPaymentConfig,
  SellerSession,
} from './buyer-payment-manager.js';

export { SellerPaymentManager } from './seller-payment-manager.js';
export type {
  SellerPaymentConfig,
  BuyerAuth,
} from './seller-payment-manager.js';

// Legacy exports (kept for existing code that imports them)
export { BalanceManager } from './balance-manager.js';
export type { UnifiedBalance } from './balance-manager.js';
export { calculateSettlement, isSettlementWithinEscrow, calculateRefund } from './settlement.js';
export {
  createDispute,
  detectDiscrepancy,
  resolveDispute,
  isDisputeExpired,
  calculateDisputedAmount,
  DISPUTE_TIMEOUT_MS,
} from './disputes.js';
export type {
  PaymentMethod,
  ChainId,
  WalletInfo,
  TransactionType,
  Transaction,
  PaymentConfig,
  CryptoPaymentConfig,
  SettlementResult,
  DisputeStatus,
  PaymentDispute,
} from './types.js';
