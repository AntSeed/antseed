// Main facade
export {
  AntseedNode,
  type NodeConfig,
  type BuyerPaymentConfig,
  type NodePaymentsConfig,
  type RequestStreamCallbacks,
  type RequestStreamResponseMetadata,
} from './node.js';
export type { Provider, ProviderStreamCallbacks } from './interfaces/seller-provider.js';
export type { Router } from './interfaces/buyer-router.js';

// Types (re-export everything)
export * from './types/index.js';

// Submodule re-exports (commonly used)
export { loadOrCreateIdentity, type Identity } from './p2p/identity.js';
export { DHTNode, DEFAULT_DHT_CONFIG } from './discovery/dht-node.js';
export { OFFICIAL_BOOTSTRAP_NODES, mergeBootstrapNodes, toBootstrapConfig } from './discovery/bootstrap.js';
export {
  WELL_KNOWN_MODEL_CATEGORIES,
  WELL_KNOWN_MODEL_API_PROTOCOLS,
  type ModelApiProtocol,
  type PeerMetadata,
  type ProviderAnnouncement,
} from './discovery/peer-metadata.js';
export { MetadataServer, type MetadataServerConfig } from './discovery/metadata-server.js';
export { MeteringStorage } from './metering/storage.js';
export { BalanceManager } from './payments/balance-manager.js';
export { BaseEscrowClient, type BaseEscrowConfig } from './payments/evm/escrow-client.js';
export { identityToEvmWallet, identityToEvmAddress } from './payments/evm/keypair.js';
export { NatTraversal, type NatMapping, type NatTraversalResult } from './p2p/nat-traversal.js';
export { BuyerPaymentManager } from './payments/buyer-payment-manager.js';
export type { BuyerSessionState, BuyerSessionStatus } from './payments/buyer-payment-manager.js';
export { ProxyMux } from './proxy/proxy-mux.js';
export { resolveProvider } from './proxy/provider-detection.js';
export {
  detectRequestModelApiProtocol,
  inferProviderDefaultModelApiProtocols,
  selectTargetProtocolForRequest,
  transformAnthropicMessagesRequestToOpenAIChat,
  transformOpenAIChatResponseToAnthropicMessage,
  transformOpenAIResponsesRequestToOpenAIChat,
  transformOpenAIChatResponseToOpenAIResponses,
  type TargetProtocolSelection,
  type AnthropicToOpenAIRequestTransformResult,
  type ResponsesToOpenAIRequestTransformResult,
} from './proxy/model-api-adapter.js';
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
