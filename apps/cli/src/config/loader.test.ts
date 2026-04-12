import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from './loader.js';

async function withTempConfig(contents: string, fn: (configPath: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'antseed-cli-config-'));
  const configPath = join(dir, 'config.json');
  try {
    await writeFile(configPath, contents, 'utf-8');
    await fn(configPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('loadConfig reads nested seller.providers[name].services[id] shape', async () => {
  await withTempConfig(
    JSON.stringify({
      seller: {
        providers: {
          anthropic: {
            defaults: { inputUsdPerMillion: 5, outputUsdPerMillion: 10 },
            services: {
              'claude-sonnet-4-5-20250929': {
                upstreamModel: 'claude-sonnet-4-5-20250929',
                categories: ['coding', 'chat'],
                pricing: {
                  inputUsdPerMillion: 12,
                  outputUsdPerMillion: 18,
                  cachedInputUsdPerMillion: 1.5,
                },
              },
            },
          },
        },
      },
    }),
    async (configPath) => {
      const config = await loadConfig(configPath);
      const anthropic = config.seller.providers['anthropic'];
      assert.ok(anthropic);
      assert.equal(anthropic.defaults?.inputUsdPerMillion, 5);
      assert.equal(anthropic.defaults?.outputUsdPerMillion, 10);
      const service = anthropic.services['claude-sonnet-4-5-20250929'];
      assert.ok(service);
      assert.equal(service.upstreamModel, 'claude-sonnet-4-5-20250929');
      assert.deepEqual(service.categories, ['coding', 'chat']);
      assert.equal(service.pricing?.inputUsdPerMillion, 12);
      assert.equal(service.pricing?.outputUsdPerMillion, 18);
      assert.equal(service.pricing?.cachedInputUsdPerMillion, 1.5);
    }
  );
});

test('loadConfig rejects incomplete service pricing', async () => {
  await withTempConfig(
    JSON.stringify({
      seller: {
        providers: {
          anthropic: {
            services: {
              broken: {
                pricing: { inputUsdPerMillion: 12 },
              },
            },
          },
        },
      },
    }),
    async (configPath) => {
      await assert.rejects(
        async () => loadConfig(configPath),
        /seller\.providers\.anthropic\.services\.broken\.pricing\.outputUsdPerMillion/
      );
    }
  );
});

test('loadConfig rejects invalid category tags', async () => {
  await withTempConfig(
    JSON.stringify({
      seller: {
        providers: {
          anthropic: {
            services: {
              'claude-sonnet-4-5-20250929': {
                categories: ['Bad Value'],
              },
            },
          },
        },
      },
    }),
    async (configPath) => {
      await assert.rejects(
        async () => loadConfig(configPath),
        /seller\.providers\.anthropic\.services\.claude-sonnet-4-5-20250929\.categories/
      );
    }
  );
});

test('loadConfig normalizes category tags (lowercase, dedupe)', async () => {
  await withTempConfig(
    JSON.stringify({
      seller: {
        providers: {
          openai: {
            services: {
              'gpt-4': {
                categories: ['Chat', 'chat', 'Coding'],
              },
            },
          },
        },
      },
    }),
    async (configPath) => {
      const config = await loadConfig(configPath);
      assert.deepEqual(
        config.seller.providers['openai']?.services['gpt-4']?.categories,
        ['chat', 'coding']
      );
    }
  );
});

test('loadConfig preserves seller publicAddress override', async () => {
  await withTempConfig(
    JSON.stringify({
      seller: {
        publicAddress: 'peer.example.com:6882',
      },
    }),
    async (configPath) => {
      const config = await loadConfig(configPath);
      assert.equal(config.seller.publicAddress, 'peer.example.com:6882');
    }
  );
});

test('loadConfig preserves seller agentDir setting', async () => {
  await withTempConfig(
    JSON.stringify({
      seller: {
        agentDir: '/etc/antseed/my-agent',
      },
    }),
    async (configPath) => {
      const config = await loadConfig(configPath);
      assert.equal(config.seller.agentDir, '/etc/antseed/my-agent');
    }
  );
});
