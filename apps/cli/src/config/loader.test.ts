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
              models: {
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
        config.seller.pricing.providers?.anthropic?.models?.['claude-sonnet-4-5-20250929']?.inputUsdPerMillion,
        12
      );
      assert.equal(
        config.seller.pricing.providers?.anthropic?.models?.['claude-sonnet-4-5-20250929']?.outputUsdPerMillion,
        18
      );

      assert.equal(config.buyer.maxPricing.defaults.inputUsdPerMillion, 100);
      assert.equal(config.buyer.maxPricing.defaults.outputUsdPerMillion, 100);
      assert.equal(config.buyer.maxPricing.providers?.openai?.defaults?.inputUsdPerMillion, 55);
      assert.equal(config.buyer.maxPricing.providers?.openai?.defaults?.outputUsdPerMillion, 77);
    }
  );
});

test('loadConfig throws explicit validation error for incomplete model pricing', async () => {
  await withTempConfig(
    JSON.stringify({
      seller: {
        pricing: {
          providers: {
            anthropic: {
              models: {
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
        /seller\.pricing\.providers\.anthropic\.models\.broken\.outputUsdPerMillion/
      );
    }
  );
});

test('loadConfig deep-merges network tor settings', async () => {
  await withTempConfig(
    JSON.stringify({
      network: {
        tor: {
          enabled: true,
          manualPeers: ['abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd@example.onion:31337'],
        },
      },
    }),
    async (configPath) => {
      const config = await loadConfig(configPath);
      assert.equal(config.network.tor?.enabled, true);
      assert.equal(config.network.tor?.manualPeers?.[0], 'abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd@example.onion:31337');
      assert.equal(config.network.tor?.socksProxy, '127.0.0.1:9050');
      assert.equal(config.network.tor?.allowDirectFallback, false);
    }
  );
});

test('loadConfig rejects invalid tor manual peer format', async () => {
  await withTempConfig(
    JSON.stringify({
      network: {
        tor: {
          enabled: true,
          manualPeers: ['missing-port'],
        },
      },
    }),
    async (configPath) => {
      await assert.rejects(
        async () => loadConfig(configPath),
        /network\.tor\.manualPeers\[0\] must be in \[peerId@\]host:port format/
      );
    }
  );
});

test('loadConfig rejects onion manual peers without peerId in tor mode', async () => {
  await withTempConfig(
    JSON.stringify({
      network: {
        tor: {
          enabled: true,
          manualPeers: ['exampleexampleexampleexampleexampleexampleexampleexample.onion:80'],
        },
      },
    }),
    async (configPath) => {
      await assert.rejects(
        async () => loadConfig(configPath),
        /network\.tor\.manualPeers\[0\] onion peer must include peerId@host:port/
      );
    }
  );
});

test('loadConfig rejects tor onionPort when onionAddress is not set', async () => {
  await withTempConfig(
    JSON.stringify({
      network: {
        tor: {
          onionPort: 80,
        },
      },
    }),
    async (configPath) => {
      await assert.rejects(
        async () => loadConfig(configPath),
        /network\.tor\.onionPort requires network\.tor\.onionAddress/
      );
    }
  );
});

test('loadConfig accepts valid tor onion address and port', async () => {
  await withTempConfig(
    JSON.stringify({
      network: {
        tor: {
          onionAddress: 'abcdefghijklmnop.onion',
          onionPort: 443,
        },
      },
    }),
    async (configPath) => {
      const config = await loadConfig(configPath);
      assert.equal(config.network.tor?.onionAddress, 'abcdefghijklmnop.onion');
      assert.equal(config.network.tor?.onionPort, 443);
    }
  );
});

test('loadConfig rejects invalid tor onionAddress format', async () => {
  await withTempConfig(
    JSON.stringify({
      network: {
        tor: {
          onionAddress: 'not-an-onion-host',
        },
      },
    }),
    async (configPath) => {
      await assert.rejects(
        async () => loadConfig(configPath),
        /network\.tor\.onionAddress must be a valid v2\/v3 \.onion hostname/
      );
    }
  );
});

test('loadConfig allows onion manual peer without peerId when tor mode is disabled', async () => {
  await withTempConfig(
    JSON.stringify({
      network: {
        tor: {
          enabled: false,
          manualPeers: ['abcdefghijklmnop.onion:80'],
        },
      },
    }),
    async (configPath) => {
      const config = await loadConfig(configPath);
      assert.equal(config.network.tor?.manualPeers?.[0], 'abcdefghijklmnop.onion:80');
    }
  );
});
