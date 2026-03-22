import Fastify, { FastifyInstance } from 'fastify';
import fastifyCors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import type { DashboardConfig } from './types.js';
import { registerApiRoutes } from './api/routes.js';
import { registerWebSocket, broadcastEvent } from './api/websocket.js';
import { DHTQueryService } from './dht-query-service.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface DashboardServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  getInstance(): FastifyInstance;
}

export interface DashboardServerOptions {
  configPath?: string;
  /**
   * Path to buyer.state.json. When provided, the dashboard reads peers
   * from this file (written by the buyer runtime) instead of running
   * its own standalone DHT node.
   */
  buyerStateFile?: string;
}

/**
 * Create the dashboard Fastify server.
 * Serves the built React app as static files and exposes API endpoints.
 *
 * @param config - The dashboard configuration (satisfies DashboardConfig)
 * @param port - Port to listen on
 * @returns DashboardServer instance
 */
export async function createDashboardServer(
  config: DashboardConfig,
  port: number,
  options?: DashboardServerOptions
): Promise<DashboardServer> {
  const app = Fastify({ logger: false });

  // Deny cross-origin requests
  await app.register(fastifyCors, { origin: false });

  // Create DHTQueryService for network visibility.
  // When buyerStateFile is provided, peers are read from the buyer runtime's
  // state file instead of running a standalone DHT node.
  const dhtQueryService = new DHTQueryService(config, {
    buyerStateFile: options?.buyerStateFile,
  });

  // Serve built dashboard static files.
  // __dirname resolves to antseed-dashboard/dist/ at runtime;
  // the web app is built to antseed-dashboard/dist-web/.
  const distPath = path.resolve(__dirname, '../dist-web');

  if (!existsSync(path.join(distPath, 'index.html'))) {
    console.warn(`Warning: dashboard UI not found at ${distPath}/index.html. Run "npm run build:web" in the dashboard package.`);
  }

  await app.register(fastifyStatic, {
    root: distPath,
    prefix: '/',
  });

  // Register API routes with DHT query service
  await registerApiRoutes(app, config, dhtQueryService, options?.configPath);

  // Register WebSocket handler
  await registerWebSocket(app);

  // Wire DHT peer updates to WebSocket broadcasts
  dhtQueryService.onPeersUpdated((peers) => {
    broadcastEvent({
      type: 'network_peers_updated',
      data: peers,
      timestamp: Date.now(),
    });
  });

  return {
    start: async () => {
      await app.listen({ port, host: '127.0.0.1' });
      // Start DHT query service after Fastify is listening
      await dhtQueryService.start().catch((err: unknown) => {
        console.error(`DHT start failed (non-fatal): ${(err as Error).message}`);
      });
    },
    stop: async () => {
      // Stop DHT query service before Fastify closes
      await dhtQueryService.stop().catch(() => {});
      await app.close();
    },
    getInstance: () => app,
  };
}
