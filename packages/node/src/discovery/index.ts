export { DHTNode, DEFAULT_DHT_CONFIG, topicToInfoHash, providerTopic, modelTopic, capabilityTopic, type DHTNodeConfig } from './dht-node.js';
export { PeerAnnouncer, type AnnouncerConfig } from './announcer.js';
export { PeerLookup, DEFAULT_LOOKUP_CONFIG, type LookupConfig, type LookupResult } from './peer-lookup.js';

export { scorePeer, rankPeers, selectBestPeer, selectDiversePeers, DEFAULT_SCORING_WEIGHTS, type ScoringWeights, type PeerCandidate, type ScoredPeer } from './peer-selector.js';
export { OFFICIAL_BOOTSTRAP_NODES, parseBootstrapList, mergeBootstrapNodes, toBootstrapConfig, type BootstrapNode } from './bootstrap.js';
export { encodeMetadata, encodeMetadataForSigning, decodeMetadata } from './metadata-codec.js';
export { validateMetadata, MAX_METADATA_SIZE, MAX_PROVIDERS, type ValidationError } from './metadata-validator.js';
export { METADATA_VERSION, WELL_KNOWN_MODEL_CATEGORIES, type PeerMetadata, type ProviderAnnouncement } from './peer-metadata.js';
export { type MetadataResolver, type PeerEndpoint } from './metadata-resolver.js';
export { DefaultMetadataResolver } from './default-metadata-resolver.js';
export { HttpMetadataResolver, type HttpMetadataResolverConfig } from './http-metadata-resolver.js';
export { DHTHealthMonitor, DEFAULT_HEALTH_THRESHOLDS, type DHTHealthSnapshot, type HealthThresholds } from './dht-health.js';
export { verifyReputation, type ReputationVerification } from './reputation-verifier.js';
