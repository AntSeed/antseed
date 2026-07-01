import Fastify, { type FastifyInstance } from 'fastify';
import path from 'node:path';
import type { TopupConfig } from './config.js';
import { EvmChainGateway, type ChainGateway } from './chain.js';
import { createMeridianClient, type MeridianClient } from './meridian.js';
import { registerRoutes, type RouteHealthInfo } from './routes.js';
import { TopupService } from './service.js';
import { TopupStore } from './store.js';

export interface CreateAppOptions {
  service: TopupService;
  health: RouteHealthInfo;
}

/** Assemble a Fastify app around an existing service (used directly by tests). */
export function createApp(options: CreateAppOptions): FastifyInstance {
  const fastify = Fastify({ logger: false });
  registerRoutes(fastify, options);
  return fastify;
}

export interface TopupServer {
  fastify: FastifyInstance;
  service: TopupService;
  chain: ChainGateway;
  store: TopupStore;
}

/** Wire the real chain gateway, Meridian client and store from config. */
export function createServer(
  config: TopupConfig,
  overrides?: { chain?: ChainGateway; meridian?: MeridianClient; store?: TopupStore },
): TopupServer {
  const chain =
    overrides?.chain ??
    new EvmChainGateway({
      rpcUrl: config.chain.rpcUrl,
      evmChainId: config.chain.evmChainId,
      depositsAddress: config.chain.depositsContractAddress,
      depositTokenAddress: config.chain.usdcContractAddress,
      paymentAssetAddress: config.meridian.asset,
      relayerPrivateKey: config.relayerPrivateKey,
    });
  const meridian =
    overrides?.meridian ??
    createMeridianClient({ apiBase: config.meridian.apiBase, apiKey: config.meridian.apiKey });
  const store = overrides?.store ?? new TopupStore(path.join(config.dataDir, 'topups.db'));

  const service = new TopupService({
    store,
    chain,
    meridian,
    x402: {
      network: config.meridian.network,
      asset: config.meridian.asset,
      assetName: config.meridian.assetName,
      assetVersion: config.meridian.assetVersion,
      facilitator: config.meridian.facilitator,
      resourceUrl: `${config.resourceBaseUrl}/v1/topup`,
      evmChainId: config.chain.evmChainId,
    },
    limits: config.limits,
  });

  const fastify = createApp({
    service,
    health: {
      chainId: config.chain.chainId,
      network: config.meridian.network,
      asset: config.meridian.asset,
      facilitator: config.meridian.facilitator,
      depositsContractAddress: config.chain.depositsContractAddress,
      relayer: chain.relayerAddress,
    },
  });

  return { fastify, service, chain, store };
}
