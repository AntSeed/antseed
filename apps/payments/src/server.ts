import { randomBytes } from 'node:crypto';
import Fastify from 'fastify';
import fastifyCors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { readFile } from 'node:fs/promises';
import { registerRoutes } from './routes.js';
import { loadCryptoContext, type CryptoContext, type PaymentCryptoConfig } from './crypto-context.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface PaymentsServerOptions {
  port: number;
  dataDir?: string;
  identityHex?: string;
}

export async function createServer(options: PaymentsServerOptions) {
  const fastify = Fastify({ logger: false });

  // Generate a bearer token for this session — only the desktop app knows it
  const bearerToken = randomBytes(32).toString('hex');

  // Restrict CORS to same-origin only (portal frontend is served from the same host)
  const portalOrigin = `http://127.0.0.1:${options.port}`;
  await fastify.register(fastifyCors, { origin: portalOrigin });

  // Authenticate API requests with bearer token (skip for static files and GET /api/config)
  fastify.addHook('onRequest', async (request, reply) => {
    // Allow static file serving and health checks
    if (!request.url.startsWith('/api/')) return;
    // Allow unauthenticated config read only (public contract addresses)
    if (request.method === 'GET' && request.url.startsWith('/api/config')) return;
    if (request.method === 'GET' && request.url.startsWith('/api/transactions')) return;
    // All other API requests require bearer token (balance, withdrawals)
    const auth = request.headers.authorization;
    if (auth !== `Bearer ${bearerToken}`) {
      return reply.status(401).send({ ok: false, error: 'Unauthorized' });
    }
  });

  // Serve static web files
  const webDir = path.resolve(__dirname, 'web');
  try {
    await fastify.register(fastifyStatic, {
      root: webDir,
      prefix: '/',
      wildcard: false,
    });
  } catch {
    // Web dir may not exist in dev mode
  }

  // Load crypto context
  let cryptoCtx: CryptoContext | null = null;
  let cryptoConfig: PaymentCryptoConfig | null = null;

  try {
    cryptoCtx = await loadCryptoContext({
      identityHex: options.identityHex,
      dataDir: options.dataDir,
    });

    // Load config for contract addresses
    try {
      const cfgPath = path.join(options.dataDir || homedir(), '.antseed', 'config.json');
      const raw = await readFile(cfgPath, 'utf-8');
      const config = JSON.parse(raw) as Record<string, unknown>;
      const payments = (config.payments ?? {}) as Record<string, unknown>;
      const crypto = (payments.crypto ?? {}) as Record<string, unknown>;
      if (crypto.rpcUrl && crypto.escrowContractAddress && crypto.usdcContractAddress) {
        cryptoConfig = {
          rpcUrl: String(crypto.rpcUrl),
          escrowContractAddress: String(crypto.escrowContractAddress),
          usdcContractAddress: String(crypto.usdcContractAddress),
        };
      }
    } catch {
      // Config not available
    }
  } catch (err) {
    console.warn('[payments] Failed to load crypto context:', err instanceof Error ? err.message : String(err));
  }

  registerRoutes(fastify, { cryptoCtx, cryptoConfig });

  // SPA fallback — serve index.html for non-API routes
  fastify.setNotFoundHandler((_request, reply) => {
    void reply.sendFile('index.html');
  });

  // Expose bearer token for authorized consumers (desktop app injects it via URL param)
  (fastify as unknown as { bearerToken: string }).bearerToken = bearerToken;

  return fastify;
}
