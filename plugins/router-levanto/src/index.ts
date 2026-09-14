import type { AntseedRouterPlugin } from '@antseed/node';
import { DEFAULT_BASELINE_MODELS, LEVANTO_AUTO_SERVICE_ID, LEVANTO_DAILY_PASS_SERVICE_ID, LevantoRouter } from './router.js';

export { LEVANTO_AUTO_SERVICE_ID, LEVANTO_DAILY_PASS_SERVICE_ID };

const plugin: AntseedRouterPlugin = {
  name: 'levanto',
  displayName: 'Levanto Model Router',
  version: '0.0.1',
  type: 'router',
  description: 'Routes each chat request to the cheapest capable model, picked by Levanto\'s routing peer',
  autoRouteServiceId: LEVANTO_AUTO_SERVICE_ID,
  autoRouteInfo: {
    title: 'Levanto Router',
    body: 'Levanto Router picks the best model and seller for every message you send, weighing cost '
      + 'against quality according to your Cost / quality tradeoff preference. No need to switch '
      + 'models by hand as prices and availability change.',
  },
  preferencesSummary: 'The router picks the best model and seller for every message, balancing '
    + 'cost against quality.',
  savingsBaselineModel: DEFAULT_BASELINE_MODELS[0],
  dailyPassServiceId: LEVANTO_DAILY_PASS_SERVICE_ID,
  routingSettingsSchema: [{ key: 'costQuality', label: 'Levanto cost / quality tradeoff', type: 'number',
    default: '5', options: ['1', '3', '5', '7', '9'], min: 1, max: 9,
    description: 'Levanto-specific preference: 1 favours cost, 9 favours quality.' }],
  configSchema: [
    {
      key: 'LEVANTO_ROUTING_PEER_URL',
      label: 'Routing Peer URL',
      type: 'string',
      required: false,
      description: 'Base URL of the routing peer, e.g. http://127.0.0.1:8787. Optional -- omit it and the plugin discovers its real mainnet routing peer\'s address itself via P2P/DHT lookup once the node has started. Set this only to override that -- e.g. local devnet, where DHT discovery is deliberately disabled.',
    },
    {
      key: 'ANTSEED_ROUTER_DATA_DIR',
      label: 'Router Data Directory',
      type: 'string',
      required: false,
      description: 'Generic host-injected persistent directory every router plugin receives the same way, not a router-levanto-specific setting -- used for the routing_decisions ledger. Omit to keep the ledger in-memory only.',
    },
    {
      key: 'LEVANTO_SELLER_PEER_ID',
      label: 'Routing Peer ID',
      type: 'string',
      required: false,
      description: 'The routing peer\'s P2P peer id (40-char hex EVM address) -- who the daily usage charge is signed against, and what the plugin looks up via P2P/DHT to discover the routing peer URL above when that\'s not explicitly set. Distinct from the HTTP URL above: this is a P2P identity, not an endpoint. Omit to use this plugin\'s own real mainnet routing peer by default.',
    },
    {
      key: 'ANTSEED_BUYER_PEER_ID',
      label: 'Buyer Peer ID',
      type: 'string',
      required: false,
      description: 'This buyer\'s own P2P peer id, sent to the routing peer as x-antseed-buyer-peer-id so the daily-charge gate has someone to check. Omit and the routing peer sees no buyer identity at all -- every request fails that gate. See LevantoRouterConfig.buyerPeerId for why this is a demo-shaped stopgap, not a real authentication mechanism. Unlike the LEVANTO_-prefixed keys above, this is generic host-injected identity every router plugin receives the same way, not a router-levanto-specific setting.',
    },
    {
      key: 'ANTSEED_CHAIN_ID',
      label: 'Chain ID',
      type: 'string',
      required: false,
      description: 'This buyer\'s configured chain (e.g. base-local/base-sepolia/base-mainnet). Used only to pick this plugin\'s own devnet-vs-mainnet routing-peer defaults -- like ANTSEED_BUYER_PEER_ID, this is generic host-injected config every router plugin receives the same way, not a router-levanto-specific setting.',
    },
  ],
  createRouter(config: Record<string, string>) {
    // routingPeerUrl is optional -- with none given,
    // LevantoRouter discovers its own routing peer's address lazily, via
    // P2P/DHT lookup on sellerPeerId (also defaulted to this plugin's own
    // real mainnet routing peer if omitted), once the host wires in
    // configureRoutingPeerHostResolution after the node has started. This
    // runs before that -- no lookup capability exists yet at this point.
    return new LevantoRouter({
      routingPeerUrl: config['LEVANTO_ROUTING_PEER_URL'] || undefined,
      dataDir: config['ANTSEED_ROUTER_DATA_DIR'] || undefined,
      sellerPeerId: config['LEVANTO_SELLER_PEER_ID'] || undefined,
      buyerPeerId: config['ANTSEED_BUYER_PEER_ID'] || undefined,
      chainId: config['ANTSEED_CHAIN_ID'] || undefined,
    });
  },
};

export default plugin;
export { LevantoRouter, RoutingPeerError } from './router.js';
export type { LevantoRouterConfig } from './router.js';
export { buildDigest, periodKey } from './digest.js';
export type { DailyDigestBody } from './digest.js';
