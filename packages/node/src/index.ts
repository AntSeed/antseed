// Main facade
export {
  AntseedNode,
  type NodeConfig,
  type NodePaymentsConfig,
  type RequestStreamCallbacks,
  type RequestStreamResponseMetadata,
  type BuyerUsageTotals,
  type BuyerUsageChannelPoint,
} from './node.js';
export type { Provider, ProviderStreamCallbacks } from './interfaces/seller-provider.js';
export type { Router } from './interfaces/buyer-router.js';

// Types (re-export everything)
export * from './types/index.js';

// Submodule re-exports (commonly used)
export {
  loadOrCreateIdentity,
  identityFromPrivateKeyHex,
  type Identity,
  type IdentityStore,
  FileIdentityStore,
  hexToBytes,
  bytesToHex,
} from './p2p/identity.js';
export { DHTNode, DEFAULT_DHT_CONFIG } from './discovery/dht-node.js';
export { OFFICIAL_BOOTSTRAP_NODES, mergeBootstrapNodes, toBootstrapConfig } from './discovery/bootstrap.js';
export {
  WELL_KNOWN_SERVICE_CATEGORIES,
  WELL_KNOWN_SERVICE_API_PROTOCOLS,
  type ServiceApiProtocol,
  type PeerMetadata,
  type ProviderAnnouncement,
} from './discovery/peer-metadata.js';
export { MetadataServer, type MetadataServerConfig } from './discovery/metadata-server.js';
export { parsePublicAddress, MAX_PUBLIC_ADDRESS_LENGTH, type ParsedPublicAddress } from './discovery/public-address.js';
export { MeteringStorage } from './metering/storage.js';
export { BalanceManager } from './payments/balance-manager.js';
export { DepositsClient, type DepositsClientConfig, type BuyerBalanceInfo } from './payments/evm/deposits-client.js';
export { ChannelsClient, type ChannelsClientConfig, type ChannelInfo, type AgentStats } from './payments/evm/channels-client.js';
export { IdentityClient, type IdentityClientConfig } from './payments/evm/identity-client.js';
export { StakingClient, type StakingClientConfig } from './payments/evm/staking-client.js';
export { EmissionsClient, type EmissionsClientConfig } from './payments/evm/emissions-client.js';
export { ANTSTokenClient, type ANTSTokenClientConfig } from './payments/evm/ants-token-client.js';
export {
  StatsClient,
  type StatsClientConfig,
  type DecodedMetadataRecorded,
} from './payments/evm/stats-client.js';
export { signData, verifySignature, signUtf8, verifyUtf8 } from './p2p/identity.js';
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
} from './payments/evm/signatures.js';
export type { SpendingAuthMessage, ReserveAuthMessage, SetOperatorMessage, SpendingAuthMetadata } from './payments/evm/signatures.js';
export { NatTraversal, type NatMapping, type NatTraversalResult } from './p2p/nat-traversal.js';
export { BuyerPaymentManager } from './payments/buyer-payment-manager.js';
export type { BuyerPaymentConfig } from './payments/buyer-payment-manager.js';
export { SellerPaymentManager } from './payments/seller-payment-manager.js';
export type { SellerPaymentConfig } from './payments/seller-payment-manager.js';
export { ChannelStore } from './payments/channel-store.js';
export type { StoredChannel, StoredReceipt } from './payments/channel-store.js';
export { getChainConfig, resolveChainConfig, DEFAULT_CHAIN_ID, CHAIN_CONFIGS } from './payments/chain-config.js';
export type { ChainConfig } from './payments/chain-config.js';
export { formatUsdc, parseUsdc } from './payments/usdc-utils.js';
export { ProxyMux } from './proxy/proxy-mux.js';
export { resolveProvider } from './proxy/provider-detection.js';
export {
  detectRequestServiceApiProtocol,
  createOpenAIChatToAnthropicStreamingAdapter,
  createOpenAIChatToResponsesStreamingAdapter,
  inferProviderDefaultServiceApiProtocols,
  selectTargetProtocolForRequest,
  transformAnthropicMessagesRequestToOpenAIChat,
  transformOpenAIChatResponseToAnthropicMessage,
  transformOpenAIResponsesRequestToOpenAIChat,
  transformOpenAIChatResponseToOpenAIResponses,
  type TargetProtocolSelection,
  type AnthropicToOpenAIRequestTransformResult,
  type ResponsesToOpenAIRequestTransformResult,
  type StreamingResponseAdapter,
} from './proxy/service-api-adapter.js';
export { DefaultRouter, type DefaultRouterConfig } from './routing/default-router.js';

export type { AntseedPlugin, AntseedProviderPlugin, AntseedRouterPlugin, PluginConfigKey, ConfigField } from './interfaces/plugin.js'

// Reputation
export { UptimeTracker } from './reputation/uptime-tracker.js';
export {
  computeOnChainTrust,
  computeOnChainTrustBreakdown,
  buildSybilContext,
  computeOnChainSybilRisk,
  computeOnChainScore,
  scoreFromTrust,
  computeOnChainReputationScore,
  ON_CHAIN_TRUST_TICKET_TARGET_USDC,
  ON_CHAIN_TRUST_TICKET_MIN,
  ON_CHAIN_TRUST_TICKET_MAX,
  ON_CHAIN_TRUST_RECENCY_FRESH_DAYS,
  ON_CHAIN_TRUST_RECENCY_STALE_DAYS,
  ON_CHAIN_TRUST_RECENCY_DORMANT_FACTOR,
  ON_CHAIN_TRUST_STAKE_THRESHOLD_USDC,
  ON_CHAIN_TRUST_NO_STAKE_FACTOR,
  ON_CHAIN_SCORE_LOG_CAP_EXPONENT,
  SYBIL_WEIGHT_SUBFLOOR_TICKET,
  SYBIL_WEIGHT_BURN_RATE,
  SYBIL_WEIGHT_NARROW_CUSTOM,
  SYBIL_WEIGHT_YOUNG_HIGH_VOL,
  SYBIL_SUBFLOOR_TICKET_USDC,
  SYBIL_SUBFLOOR_MIN_CHANNELS,
  SYBIL_BURN_RATE_THRESHOLD,
  SYBIL_BURN_RATE_SATURATION,
  SYBIL_YOUNG_MAX_DAYS,
  SYBIL_YOUNG_CHANNEL_FLOOR,
  SYBIL_YOUNG_CHANNEL_SATURATION,
  SYBIL_ADVERTISED_CHEAP_INPUT_USD_PER_MILLION,
  type OnChainTrustBreakdown,
  type SybilContext,
  type SybilRiskResult,
  type SybilFlag,
} from './reputation/on-chain-reputation.js';
export type { UptimeWindow, PeerUptimeRecord } from './reputation/uptime-tracker.js';
export { ReportManager } from './reputation/report-manager.js';
export type { PeerReport, ReportReason, ReportEvidence, ReportStatus } from './types/report.js';
export { RatingManager } from './reputation/rating-manager.js';
export type { PeerRating, RatingDimension, AggregateRating } from './types/rating.js';

// Plugin config & loading
export { encryptValue, decryptValue, deriveMachineKey, generateSalt } from './config/encryption.js'
export {
  loadPluginConfig,
  savePluginConfig,
  addInstance,
  removeInstance,
  getInstance,
  getInstances,
  updateInstanceConfig,
} from './config/plugin-config-manager.js'
export {
  loadPluginModule,
  loadAllPlugins,
  type LoadedProvider,
  type LoadedRouter,
} from './config/plugin-loader.js'
