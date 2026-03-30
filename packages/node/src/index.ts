// Main facade
export {
  AntseedNode,
  type NodeConfig,
  type NodePaymentsConfig,
  type RequestStreamCallbacks,
  type RequestStreamResponseMetadata,
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
export { SessionsClient, type SessionsClientConfig, type SessionInfo } from './payments/evm/sessions-client.js';
export { IdentityClient, type IdentityClientConfig } from './payments/evm/identity-client.js';
export { StatsClient, type StatsClientConfig, type AgentStats } from './payments/evm/stats-client.js';
export { StakingClient, type StakingClientConfig, type SellerAccountInfo } from './payments/evm/staking-client.js';
export { signData, verifySignature, signUtf8, verifyUtf8 } from './p2p/identity.js';
export {
  signSpendingAuth,
  signReserveAuth,
  makeSessionsDomain,
  SPENDING_AUTH_TYPES,
  RESERVE_AUTH_TYPES,
  computeMetadataHash,
  encodeMetadata,
  computeChannelId,
  ZERO_METADATA,
  ZERO_METADATA_HASH,
} from './payments/evm/signatures.js';
export type { SpendingAuthMessage, ReserveAuthMessage, SpendingAuthMetadata } from './payments/evm/signatures.js';
export { NatTraversal, type NatMapping, type NatTraversalResult } from './p2p/nat-traversal.js';
export { BuyerPaymentManager } from './payments/buyer-payment-manager.js';
export type { BuyerPaymentConfig } from './payments/buyer-payment-manager.js';
export { SellerPaymentManager } from './payments/seller-payment-manager.js';
export type { SellerPaymentConfig } from './payments/seller-payment-manager.js';
export { SessionStore } from './payments/session-store.js';
export type { StoredSession, StoredReceipt } from './payments/session-store.js';
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
export { TrustScoreEngine } from './reputation/trust-engine.js';
export { UptimeTracker } from './reputation/uptime-tracker.js';
export { computeTrustScore, DEFAULT_TRUST_WEIGHTS } from './reputation/trust-score.js';
export type { TrustScore, TrustComponents } from './reputation/trust-score.js';
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
