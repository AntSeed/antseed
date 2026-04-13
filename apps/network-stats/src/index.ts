import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { StakingClient, StatsClient, resolveChainConfig } from '@antseed/node';

import { NetworkPoller } from './poller.js';
import { createServer } from './server.js';
import { SqliteStore } from './store.js';
import { MetadataIndexer } from './indexer.js';

const PORT = parseInt(process.env['PORT'] ?? '4000', 10);
const CACHE_PATH = process.env['CACHE_PATH'];
const CHAIN_ID = process.env['NETWORK_STATS_CHAIN_ID'] ?? 'base-mainnet';
const DB_PATH = process.env['NETWORK_STATS_DB_PATH'] ?? 'data/network-stats.sqlite';
const RPC_URL_OVERRIDE = process.env['NETWORK_STATS_RPC_URL'];
const TICK_INTERVAL_MS = parseInt(process.env['NETWORK_STATS_TICK_INTERVAL_MS'] ?? '60000', 10);
const MAX_BLOCKS_PER_TICK = parseInt(process.env['NETWORK_STATS_MAX_BLOCKS_PER_TICK'] ?? '2000', 10);
const REORG_SAFETY_BLOCKS = 12;

const poller = new NetworkPoller(CACHE_PATH);

const chainConfig = resolveChainConfig({
  chainId: CHAIN_ID,
  ...(RPC_URL_OVERRIDE ? { rpcUrl: RPC_URL_OVERRIDE } : {}),
});
let store: SqliteStore | null = null;
let indexer: MetadataIndexer | null = null;
let stakingClient: StakingClient | null = null;

if (chainConfig.statsContractAddress && typeof chainConfig.statsDeployBlock === 'number') {
  mkdirSync(dirname(DB_PATH), { recursive: true });
  store = new SqliteStore(DB_PATH);
  store.init();
  const statsClient = new StatsClient({
    rpcUrl: chainConfig.rpcUrl,
    contractAddress: chainConfig.statsContractAddress,
  });
  indexer = new MetadataIndexer({
    store,
    statsClient,
    chainId: CHAIN_ID,
    contractAddress: chainConfig.statsContractAddress.toLowerCase(),
    deployBlock: chainConfig.statsDeployBlock,
    tickIntervalMs: TICK_INTERVAL_MS,
    reorgSafetyBlocks: REORG_SAFETY_BLOCKS,
    maxBlocksPerTick: MAX_BLOCKS_PER_TICK,
    rpcUrl: chainConfig.rpcUrl,
  });
  if (chainConfig.stakingContractAddress) {
    stakingClient = new StakingClient({
      rpcUrl: chainConfig.rpcUrl,
      contractAddress: chainConfig.stakingContractAddress,
      usdcAddress: chainConfig.usdcContractAddress,
    });
  } else {
    console.warn(`[network-stats] stats contract is configured for ${CHAIN_ID} but staking contract is not — /stats enrichment will fall back to the legacy non-enriched payload`);
  }
} else {
  console.log(
    `[network-stats] stats indexer disabled for chain ${CHAIN_ID} (no stats contract configured)`,
  );
}

const server = createServer({
  poller,
  ...(store ? { store } : {}),
  ...(stakingClient ? { stakingClient } : {}),
  ...(indexer ? { indexer } : {}),
  ...(store && chainConfig.statsContractAddress
    ? { chainId: CHAIN_ID, contractAddress: chainConfig.statsContractAddress }
    : {}),
  port: PORT,
});

await server.start();
await poller.start();
indexer?.start();

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

function shutdown(): void {
  console.log('[network-stats] shutting down...');
  indexer?.stop();
  store?.close();
  poller.stop();
  server.stop();
  process.exit(0);
}
