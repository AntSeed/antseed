// Payment types
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

// Balance tracking (local transaction history)
export { BalanceManager } from './balance-manager.js';
export type { UnifiedBalance } from './balance-manager.js';

// Off-chain settlement calculation
export { calculateSettlement, isSettlementWithinEscrow, calculateRefund } from './settlement.js';

// Off-chain dispute detection
export {
  createDispute,
  detectDiscrepancy,
  resolveDispute,
  isDisputeExpired,
  calculateDisputedAmount,
  DISPUTE_TIMEOUT_MS,
} from './disputes.js';

// Base/EVM integration
export { BaseEscrowClient } from './evm/escrow-client.js';
export type { BaseEscrowConfig, SessionInfo, ReputationInfo } from './evm/escrow-client.js';
export { identityToEvmWallet, identityToEvmAddress } from './evm/keypair.js';
export {
  signMessageEcdsa,
  signMessageEd25519,
  buildLockMessageHash,
  buildSettlementMessageHash,
  buildExtendLockMessageHash,
  buildReceiptMessage,
  buildAckMessage,
  verifyMessageEd25519,
} from './evm/signatures.js';
export { getWalletInfo, getAddress } from './evm/wallet.js';

// Buyer payment manager
export { BuyerPaymentManager } from './buyer-payment-manager.js';
export type { BuyerPaymentConfig, BuyerSessionState, BuyerSessionStatus } from './buyer-payment-manager.js';
