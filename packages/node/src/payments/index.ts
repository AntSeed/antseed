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

// Deposits client (buyer deposits + seller payouts)
export { DepositsClient } from './evm/deposits-client.js';
export type { DepositsClientConfig, BuyerBalanceInfo } from './evm/deposits-client.js';

// Channels client (reserve, settle, timeout)
export { ChannelsClient } from './evm/channels-client.js';
export type { ChannelsClientConfig, ChannelInfo } from './evm/channels-client.js';

// Identity client (ERC-8004 IdentityRegistry)
export { IdentityClient } from './evm/identity-client.js';
export type { IdentityClientConfig } from './evm/identity-client.js';

// Stats client (AntseedStats)
export { StatsClient } from './evm/stats-client.js';
export type { StatsClientConfig, AgentStats } from './evm/stats-client.js';

// Staking client (seller staking, token rate, slashing)
export { StakingClient } from './evm/staking-client.js';
export type { StakingClientConfig, SellerAccountInfo } from './evm/staking-client.js';

export {
  signSpendingAuth,
  signReserveAuth,
  signSetOperator,
  makeChannelsDomain,
  makeDepositsDomain,
  SPENDING_AUTH_TYPES,
  RESERVE_AUTH_TYPES,
  SET_OPERATOR_TYPES,
  computeMetadataHash,
  encodeMetadata,
  computeChannelId,
  ZERO_METADATA,
  ZERO_METADATA_HASH,
} from './evm/signatures.js';
export type { SpendingAuthMessage, ReserveAuthMessage, SetOperatorMessage, SpendingAuthMetadata } from './evm/signatures.js';

// ANTS token
export { ANTSTokenClient } from './evm/ants-token-client.js';
export type { ANTSTokenClientConfig } from './evm/ants-token-client.js';

// Emissions
export { EmissionsClient } from './evm/emissions-client.js';
export type { EmissionsClientConfig } from './evm/emissions-client.js';

// Subscription Pool
export { SubPoolClient } from './evm/subpool-client.js';
export type { SubPoolClientConfig } from './evm/subpool-client.js';

// Channel persistence
export { ChannelStore, CHANNEL_STATUS } from './channel-store.js';
export type { StoredChannel, StoredReceipt } from './channel-store.js';

// Buyer payment manager
export { BuyerPaymentManager } from './buyer-payment-manager.js';
export type { BuyerPaymentConfig, PerRequestAuthResult } from './buyer-payment-manager.js';

// Seller payment manager
export { SellerPaymentManager } from './seller-payment-manager.js';
export type { SellerPaymentConfig } from './seller-payment-manager.js';

// Pricing utilities
export { computeCostUsdc, estimateCostFromBytes, estimateTokensFromBytes } from './pricing.js';
export type { ServicePricing } from './pricing.js';

// Readiness checks
export { checkSellerReadiness, checkBuyerReadiness } from './readiness.js';
export type { ReadinessCheck } from './readiness.js';
