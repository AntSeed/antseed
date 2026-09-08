import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import type { AbstractSigner } from 'ethers';
import { loadOrCreateIdentity, resolveChainConfig } from '@antseed/node';
import { AntsContext, type AntsChainConfig } from './service/context.js';
import { JobRunner } from './jobs.js';
import { registerRoutes } from './routes.js';
import { ViewCache } from './view-cache.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface AntsServerOptions {
  port: number;
  host?: string;
  /** Node data directory holding the identity wallet (default ~/.antseed). */
  dataDir?: string;
  /** Config file with `payments.crypto` overrides (default <dataDir>/config.json). */
  configPath?: string;
  /** Pre-resolved chain config; skips reading config.json. */
  chain?: AntsChainConfig;
  /** Explicit signer/address; skips loading the identity from disk. */
  signer?: AbstractSigner;
  address?: string;
  /** Serve a read-only dashboard for `address` without a signer. */
  readOnly?: boolean;
}

export interface AntsServer {
  app: FastifyInstance;
  token: string;
  url: string;
  context: AntsContext;
  listen(): Promise<string>;
  close(): Promise<void>;
}

async function readCryptoOverrides(configPath: string): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await readFile(configPath, 'utf-8')) as { payments?: { crypto?: Record<string, unknown> } };
    return parsed.payments?.crypto ?? {};
  } catch {
    return {};
  }
}

/** Resolve the chain config the same way the CLI does: protocol defaults + `payments.crypto` overrides + ANTSEED_BASE_RPC_URL. */
export async function resolveAntsChain(configPath: string, env: NodeJS.ProcessEnv = process.env): Promise<AntsChainConfig> {
  const overrides = await readCryptoOverrides(configPath);
  const rpcOverride = env['ANTSEED_BASE_RPC_URL']?.trim();
  const resolved = resolveChainConfig({ ...(overrides as object), ...(rpcOverride ? { rpcUrl: rpcOverride } : {}) });
  return { ...resolved, ...(overrides as object), rpcUrl: rpcOverride || (overrides['rpcUrl'] as string | undefined) || resolved.rpcUrl } as AntsChainConfig;
}

export async function createAntsServer(options: AntsServerOptions): Promise<AntsServer> {
  const host = options.host ?? '127.0.0.1';
  const dataDir = options.dataDir ?? path.join(homedir(), '.antseed');
  const configPath = options.configPath ?? path.join(dataDir, 'config.json');
  const chain = options.chain ?? await resolveAntsChain(configPath);

  let signer = options.signer;
  let address = options.address;
  if (!signer && !options.readOnly) {
    const identity = await loadOrCreateIdentity(dataDir);
    signer = identity.wallet;
    address = identity.wallet.address;
  }
  if (!address) throw new Error('An address is required for a read-only dashboard.');
  const readOnly = !signer;
  const context = new AntsContext({ chain, address, ...(signer ? { signer } : {}) });
  await context.selectRpc();

  const app = Fastify({ logger: false, bodyLimit: 32 * 1024 * 1024 });
  const token = randomBytes(24).toString('hex');
  const origin = `http://${host}:${options.port}`;
  await app.register(fastifyCors, { origin });

  // Every API call carries the per-session token the CLI put in the URL fragment;
  // a page on another origin cannot read it, and a stray tab cannot sign.
  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api/')) return;
    const header = request.headers.authorization;
    if (header !== `Bearer ${token}`) return reply.status(401).send({ ok: false, error: 'Unauthorized' });
  });

  const webDir = path.resolve(__dirname, 'ants-web');
  try {
    await app.register(fastifyStatic, { root: webDir, prefix: '/' });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) return reply.status(404).send({ ok: false, error: 'Not found' });
      return reply.sendFile('index.html');
    });
  } catch {
    // No web bundle (dev mode); the API is still available for the Vite dev server.
  }

  const views = new ViewCache();
  registerRoutes(app, { ctx: context, jobs: new JobRunner({ onFinish: () => views.invalidate() }), views, readOnly, dataDir });

  const url = `${origin}/#token=${token}`;
  return {
    app,
    token,
    url,
    context,
    async listen() {
      await app.listen({ port: options.port, host });
      return url;
    },
    async close() {
      await app.close();
    },
  };
}
