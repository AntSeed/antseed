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

test('loadConfig deep-merges nested hierarchical pricing without dropping defaults', async () => {
  await withTempConfig(
    JSON.stringify({
      seller: {
        pricing: {
          providers: {
            anthropic: {
              services: {
                'claude-sonnet-4-5-20250929': {
                  inputUsdPerMillion: 12,
                  outputUsdPerMillion: 18,
                },
              },
            },
          },
        },
      },
      buyer: {
        maxPricing: {
          providers: {
            openai: {
              defaults: {
                inputUsdPerMillion: 55,
                outputUsdPerMillion: 77,
              },
            },
          },
        },
      },
    }),
    async (configPath) => {
      const config = await loadConfig(configPath);

      assert.equal(config.seller.pricing.defaults.inputUsdPerMillion, 10);
      assert.equal(config.seller.pricing.defaults.outputUsdPerMillion, 10);
      assert.equal(
        config.seller.pricing.providers?.anthropic?.services?.['claude-sonnet-4-5-20250929']?.inputUsdPerMillion,
        12
      );
      assert.equal(
        config.seller.pricing.providers?.anthropic?.services?.['claude-sonnet-4-5-20250929']?.outputUsdPerMillion,
        18
      );

      assert.equal(config.buyer.maxPricing.defaults.inputUsdPerMillion, 100);
      assert.equal(config.buyer.maxPricing.defaults.outputUsdPerMillion, 100);
      assert.equal(config.buyer.maxPricing.providers?.openai?.defaults?.inputUsdPerMillion, 55);
      assert.equal(config.buyer.maxPricing.providers?.openai?.defaults?.outputUsdPerMillion, 77);
    }
  );
});

test('loadConfig throws explicit validation error for incomplete service pricing', async () => {
  await withTempConfig(
    JSON.stringify({
      seller: {
        pricing: {
          providers: {
            anthropic: {
              services: {
                broken: {
                  inputUsdPerMillion: 12,
                },
              },
            },
          },
        },
      },
    }),
    async (configPath) => {
      await assert.rejects(
        async () => loadConfig(configPath),
        /seller\.pricing\.providers\.anthropic\.services\.broken\.outputUsdPerMillion/
      );
    }
  );
});

test('loadConfig merges seller service categories per provider/service', async () => {
  await withTempConfig(
    JSON.stringify({
      seller: {
        serviceCategories: {
          anthropic: {
            'claude-sonnet-4-5-20250929': ['coding', 'legal'],
          },
        },
      },
    }),
    async (configPath) => {
      const config = await loadConfig(configPath);
      assert.deepEqual(
        config.seller.serviceCategories?.anthropic?.['claude-sonnet-4-5-20250929'],
        ['coding', 'legal']
      );
    }
  );
});

test('loadConfig rejects invalid seller service category values', async () => {
  await withTempConfig(
    JSON.stringify({
      seller: {
        serviceCategories: {
          anthropic: {
            'claude-sonnet-4-5-20250929': ['Bad Value'],
          },
        },
      },
    }),
    async (configPath) => {
      await assert.rejects(
        async () => loadConfig(configPath),
        /seller\.serviceCategories\.anthropic\.claude-sonnet-4-5-20250929/
      );
    }
  );
});
