import { randomBytes } from 'node:crypto';
import Fastify from 'fastify';
import fastifyCors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { readFile } from 'node:fs/promises';
import { resolveChainConfig } from '@antseed/node';
import { registerRoutes } from './routes.js';
import { registerWebSocket } from './websocket.js';
import { loadCryptoContext, type CryptoContext } from './crypto-context.js';
import type { SeederConfig } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface SeederServerOptions {
  port: number;
  dataDir?: string;
  identityHex?: string;
  configPath?: string;
}

export async function createSeederServer(options: SeederServerOptions) {
  const fastify = Fastify({ logger: false });

  const bearerToken = randomBytes(32).toString('hex');

  const portalOrigin = `http://127.0.0.1:${options.port}`;
  await fastify.register(fastifyCors, { origin: portalOrigin });

  // Authenticate API write requests with bearer token
  fastify.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api/')) return;
    // Allow GET requests without auth
    if (request.method === 'GET') return;
    const auth = request.headers.authorization;
    if (auth !== `Bearer ${bearerToken}`) {
      return reply.status(401).send({ ok: false, error: 'Unauthorized' });
    }
  });

  // Serve static web files
  const webDir = path.resolve(__dirname, 'web');
  let staticRegistered = false;
  try {
    await fastify.register(fastifyStatic, {
      root: webDir,
      prefix: '/',
    });
    staticRegistered = true;
  } catch {
    // Web dir may not exist in dev mode
  }

  // Load crypto context (identity)
  let cryptoCtx: CryptoContext | null = null;
  try {
    cryptoCtx = await loadCryptoContext({
      identityHex: options.identityHex,
      dataDir: options.dataDir,
    });
  } catch (err) {
    console.warn('[seeder] Failed to load crypto context:', err instanceof Error ? err.message : String(err));
  }

  // Resolve chain config
  let userOverrides: Record<string, unknown> = {};
  try {
    const cfgPath = options.configPath
      || (options.dataDir ? path.join(options.dataDir, 'config.json') : path.join(homedir(), '.antseed', 'config.json'));
    const raw = await readFile(cfgPath, 'utf-8');
    const config = JSON.parse(raw) as Record<string, unknown>;
    const payments = (config.payments ?? {}) as Record<string, unknown>;
    userOverrides = (payments.crypto ?? {}) as Record<string, unknown>;
  } catch {
    // No config file — use protocol defaults
  }

  const chainConfig = resolveChainConfig({
    chainId: userOverrides.chainId as string | undefined,
    rpcUrl: userOverrides.rpcUrl as string | undefined,
    depositsContractAddress: userOverrides.depositsContractAddress as string | undefined,
    usdcContractAddress: userOverrides.usdcContractAddress as string | undefined,
  });

  // Load seeder config for runtime endpoints
  let seederConfig: SeederConfig | null = null;
  try {
    const cfgPath = options.configPath
      || (options.dataDir ? path.join(options.dataDir, 'config.json') : path.join(homedir(), '.antseed', 'config.json'));
    const raw = await readFile(cfgPath, 'utf-8');
    seederConfig = JSON.parse(raw) as SeederConfig;
  } catch {
    // No config — runtime endpoints will degrade gracefully
  }

  registerRoutes(fastify, {
    cryptoCtx,
    chainConfig,
    seederConfig,
    configPath: options.configPath,
    dataDir: options.dataDir,
  });

  await registerWebSocket(fastify);

  // SPA fallback
  if (staticRegistered) {
    fastify.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/') || request.url.startsWith('/assets/')) {
        return reply.status(404).send({ error: 'Not found' });
      }
      void reply.sendFile('index.html');
    });
  }

  (fastify as unknown as { bearerToken: string }).bearerToken = bearerToken;

  return fastify;
}
