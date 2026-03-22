// Payment types
export type {
  PaymentMethod,
  ChainId,
  WalletInfo,
  TransactionType,
  Transaction,
  PaymentConfig,
  CryptoPaymentConfig,
} from './types.js';

// Balance tracking (local transaction history)
export { BalanceManager } from './balance-manager.js';
export type { UnifiedBalance } from './balance-manager.js';

// Base EVM client
export { BaseEvmClient } from './evm/base-evm-client.js';

// Base/EVM integration
export { BaseEscrowClient } from './evm/escrow-client.js';
export type { BaseEscrowConfig, SessionInfo, BuyerBalanceInfo, SellerAccountInfo } from './evm/escrow-client.js';
export { identityToEvmWallet, identityToEvmAddress } from './evm/keypair.js';
export {
  signSpendingAuth,
  makeEscrowDomain,
  SPENDING_AUTH_TYPES,
  signMessageEd25519,
  buildReceiptMessage,
  buildAckMessage,
  verifyMessageEd25519,
} from './evm/signatures.js';
export type { SpendingAuthMessage } from './evm/signatures.js';
// ANTS token
export { ANTSTokenClient } from './evm/ants-token-client.js';
export type { ANTSTokenClientConfig } from './evm/ants-token-client.js';

// Emissions
export { EmissionsClient } from './evm/emissions-client.js';
export type { EmissionsClientConfig } from './evm/emissions-client.js';

// Identity
export { IdentityClient } from './evm/identity-client.js';
export type { IdentityClientConfig, ProvenReputation, FeedbackSummary } from './evm/identity-client.js';

// Subscription Pool
export { SubPoolClient } from './evm/subpool-client.js';
export type { SubPoolClientConfig } from './evm/subpool-client.js';

// Session persistence
export { SessionStore, SESSION_STATUS } from './session-store.js';
export type { StoredSession, StoredReceipt } from './session-store.js';

// Buyer payment manager
export { BuyerPaymentManager } from './buyer-payment-manager.js';
export type { BuyerPaymentConfig } from './buyer-payment-manager.js';

// Seller payment manager
export { SellerPaymentManager } from './seller-payment-manager.js';
export type { SellerPaymentConfig } from './seller-payment-manager.js';

// Readiness checks
export { checkSellerReadiness, checkBuyerReadiness } from './readiness.js';
export type { ReadinessCheck } from './readiness.js';
