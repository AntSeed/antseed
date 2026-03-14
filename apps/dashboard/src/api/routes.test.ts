import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { registerApiRoutes } from './routes.js';
import type { DashboardConfig } from '../types.js';

function makeConfig(): DashboardConfig {
  return {
    identity: {
      displayName: 'Dashboard Test Node',
    },
    seller: {
      enabledProviders: ['anthropic'],
      reserveFloor: 10,
      maxConcurrentBuyers: 5,
      pricing: {
        defaults: {
          inputUsdPerMillion: 10,
          outputUsdPerMillion: 20,
        },
      },
    },
    buyer: {
      maxPricing: {
        defaults: {
          inputUsdPerMillion: 30,
          outputUsdPerMillion: 60,
        },
      },
      minPeerReputation: 50,
      proxyPort: 8377,
    },
    network: {
      bootstrapNodes: [],
    },
    payments: {
      preferredMethod: 'crypto',
      platformFeeRate: 0.05,
    },
    providers: [],
    plugins: [],
  };
}

test('PUT /api/config writes to injected config path and persists payments updates', async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), 'dashboard-routes-test-'));
  const configPath = join(tempDir, 'custom-config.json');
  const app = Fastify();

  t.after(async () => {
    await app.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  await registerApiRoutes(app, makeConfig(), undefined, configPath);

  const response = await app.inject({
    method: 'PUT',
    url: '/api/config',
    payload: {
      payments: {
        preferredMethod: 'crypto',
        platformFeeRate: 0.12,
        crypto: {
          chainId: 'base-sepolia',
          rpcUrl: 'http://127.0.0.1:8545',
          escrowContractAddress: '0xabc',
          usdcContractAddress: '0xdef',
        },
      },
    },
  });

  assert.equal(response.statusCode, 200);

  const savedRaw = await readFile(configPath, 'utf-8');
  const saved = JSON.parse(savedRaw) as DashboardConfig;
  assert.equal(saved.payments.platformFeeRate, 0.12);
  assert.equal(saved.payments.crypto?.rpcUrl, 'http://127.0.0.1:8545');
});
