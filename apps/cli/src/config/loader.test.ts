import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DEFAULT_BUYER_METADATA_FETCH_TIMEOUT_MS, DEFAULT_BUYER_PEER_REFRESH_INTERVAL_MS } from './defaults.js';
import { loadConfig } from './loader.js';
import { createDefaultConfig } from './defaults.js';
import { deriveDisplayNameFromPeerId, shouldDeriveDisplayName } from './identity-display-name.js';

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

test('deriveDisplayNameFromPeerId returns deterministic peer-specific names', () => {
  const peerId = '1234567890abcdef1234567890abcdef12345678';

  assert.equal(deriveDisplayNameFromPeerId(peerId), deriveDisplayNameFromPeerId(peerId));
  assert.match(deriveDisplayNameFromPeerId(peerId), /^antseed-[a-z]+-[a-z]+-[0-9a-f]{4}$/);
  assert.notEqual(deriveDisplayNameFromPeerId(peerId), deriveDisplayNameFromPeerId('abcdef1234567890abcdef1234567890abcdef12'));
  assert.equal(shouldDeriveDisplayName('Antseed Node'), true);
  assert.equal(shouldDeriveDisplayName('custom seller'), false);
});

test('createDefaultConfig includes a Base mainnet crypto payment default', () => {
  const config = createDefaultConfig();

  assert.deepEqual(config.payments.crypto, { chainId: 'base-mainnet' });
});

test('loadConfig reads nested seller.providers[name].services[id] shape', async () => {
  await withTempConfig(
    JSON.stringify({
      seller: {
        providers: {
          anthropic: {
            plugin: 'anthropic',
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

test('loadConfig treats legacy buyer minPeerReputation 50 as the new default', async () => {
  await withTempConfig(
    JSON.stringify({
      buyer: {
        minPeerReputation: 50,
      },
    }),
    async (configPath) => {
      const config = await loadConfig(configPath);
      assert.equal(config.buyer.minPeerReputation, 0);
    }
  );
});

test('loadConfig applies the default buyer peer refresh interval when missing', async () => {
  await withTempConfig(
    JSON.stringify({
      buyer: {
        proxyPort: 9123,
      },
    }),
    async (configPath) => {
      const config = await loadConfig(configPath);
      assert.equal(config.buyer.peerRefreshIntervalMs, DEFAULT_BUYER_PEER_REFRESH_INTERVAL_MS);
      assert.equal(config.buyer.metadataFetchTimeoutMs, DEFAULT_BUYER_METADATA_FETCH_TIMEOUT_MS);
    }
  );
});

test('loadConfig preserves explicit buyer peerRefreshIntervalMs and metadataFetchTimeoutMs', async () => {
  await withTempConfig(
    JSON.stringify({
      buyer: {
        peerRefreshIntervalMs: 15_000,
        metadataFetchTimeoutMs: 2_500,
      },
    }),
    async (configPath) => {
      const config = await loadConfig(configPath);
      assert.equal(config.buyer.peerRefreshIntervalMs, 15_000);
      assert.equal(config.buyer.metadataFetchTimeoutMs, 2_500);
    }
  );
});

test('loadConfig defaults and preserves buyer metadata v2 service opt-out setting', async () => {
  await withTempConfig(
    JSON.stringify({
      buyer: {
        proxyPort: 9123,
      },
    }),
    async (configPath) => {
      const config = await loadConfig(configPath);
      assert.equal(config.buyer.disableMetadataV2Services, false);
    }
  );

  await withTempConfig(
    JSON.stringify({
      buyer: {
        disableMetadataV2Services: true,
      },
    }),
    async (configPath) => {
      const config = await loadConfig(configPath);
      assert.equal(config.buyer.disableMetadataV2Services, true);
    }
  );
});

test('loadConfig rejects invalid buyer disableMetadataV2Services', async () => {
  await withTempConfig(
    JSON.stringify({
      buyer: {
        disableMetadataV2Services: 'false',
      },
    }),
    async (configPath) => {
      await assert.rejects(
        async () => loadConfig(configPath),
        /buyer\.disableMetadataV2Services/
      );
    }
  );
});

test('loadConfig preserves buyer verification sampling settings', async () => {
  await withTempConfig(
    JSON.stringify({
      buyer: {
        verification: {
          sampleRate: 1,
          maxSampleBytes: 1048576,
        },
      },
    }),
    async (configPath) => {
      const config = await loadConfig(configPath);
      assert.deepEqual(config.buyer.verification, {
        sampleRate: 1,
        maxSampleBytes: 1048576,
      });
    }
  );
});

test('loadConfig preserves buyer delegate settings', async () => {
  await withTempConfig(
    JSON.stringify({
      buyer: {
        delegate: {
          enabled: true,
          maxConcurrentJobs: 4,
          maxJobsPerHour: 120,
          discoveryIntervalMs: 60_000,
        },
      },
    }),
    async (configPath) => {
      const config = await loadConfig(configPath);
      assert.deepEqual(config.buyer.delegate, {
        enabled: true,
        maxConcurrentJobs: 4,
        maxJobsPerHour: 120,
        discoveryIntervalMs: 60_000,
      });
    }
  );
});

test('loadConfig rejects invalid buyer delegate settings', async () => {
  await withTempConfig(
    JSON.stringify({
      buyer: {
        delegate: {
          enabled: 'true',
        },
      },
    }),
    async (configPath) => {
      await assert.rejects(
        async () => loadConfig(configPath),
        /buyer\.delegate\.enabled/
      );
    }
  );
});

test('loadConfig rejects invalid buyer verification sampleRate', async () => {
  await withTempConfig(
    JSON.stringify({
      buyer: {
        verification: {
          sampleRate: 1.1,
        },
      },
    }),
    async (configPath) => {
      await assert.rejects(
        async () => loadConfig(configPath),
        /buyer\.verification\.sampleRate/
      );
    }
  );
});

test('loadConfig preserves verifier delegation settings', async () => {
  await withTempConfig(
    JSON.stringify({
      verifier: {
        services: ['kimi-k2'],
        delegation: {
          enabled: true,
          signalingPort: 6883,
          jobTimeoutMs: 45_000,
          minDelegates: 2,
          requireDelegates: true,
        },
      },
    }),
    async (configPath) => {
      const config = await loadConfig(configPath);
      assert.deepEqual(config.verifier?.delegation, {
        enabled: true,
        signalingPort: 6883,
        jobTimeoutMs: 45_000,
        minDelegates: 2,
        requireDelegates: true,
      });
    }
  );
});

test('loadConfig rejects mistyped verifier.services instead of widening to audit-everything', async () => {
  // `services: [123]` previously collapsed to [] — which means "audit
  // EVERYTHING the network advertises".
  await withTempConfig(
    JSON.stringify({ verifier: { services: [123] } }),
    async (configPath) => {
      await assert.rejects(async () => loadConfig(configPath), /verifier\.services\[0\]/);
    }
  );
});

test('loadConfig rejects a non-object verifier section', async () => {
  await withTempConfig(
    JSON.stringify({ verifier: 'yes please' }),
    async (configPath) => {
      await assert.rejects(async () => loadConfig(configPath), /verifier must be an object/);
    }
  );
});

test('loadConfig rejects mistyped verifier numeric fields', async () => {
  await withTempConfig(
    JSON.stringify({ verifier: { probesPerAudit: '24' } }),
    async (configPath) => {
      await assert.rejects(async () => loadConfig(configPath), /verifier\.probesPerAudit/);
    }
  );
});

test('loadConfig rejects an invalid verifier probeSource', async () => {
  await withTempConfig(
    JSON.stringify({ verifier: { probeSource: 'compositoinal' } }),
    async (configPath) => {
      await assert.rejects(async () => loadConfig(configPath), /verifier\.probeSource/);
    }
  );
});

test('loadConfig rejects a mistyped verifier upstream instead of silently disabling enrollment', async () => {
  await withTempConfig(
    JSON.stringify({ verifier: { upstream: { baseUrl: 123 } } }),
    async (configPath) => {
      await assert.rejects(async () => loadConfig(configPath), /verifier\.upstream\.baseUrl/);
    }
  );
  await withTempConfig(
    JSON.stringify({ verifier: { upstream: ['https://u/v1'] } }),
    async (configPath) => {
      await assert.rejects(async () => loadConfig(configPath), /verifier\.upstream must be an object/);
    }
  );
  await withTempConfig(
    JSON.stringify({ verifier: { upstream: { baseUrl: 'https://u/v1', modelMap: { 'kimi-k2': 7 } } } }),
    async (configPath) => {
      await assert.rejects(async () => loadConfig(configPath), /verifier\.upstream\.modelMap\["kimi-k2"\]/);
    }
  );
});

test('loadConfig rejects mistyped verifier directories', async () => {
  await withTempConfig(
    JSON.stringify({ verifier: { evidenceDir: 42 } }),
    async (configPath) => {
      await assert.rejects(async () => loadConfig(configPath), /verifier\.evidenceDir/);
    }
  );
});

test('loadConfig preserves a valid verifier section end-to-end', async () => {
  await withTempConfig(
    JSON.stringify({
      verifier: {
        services: ['Kimi-K2'],
        probesPerAudit: 24,
        probeSource: 'bank',
        referencesDir: './refs',
        upstream: {
          baseUrl: 'https://openrouter.ai/api/v1',
          apiKeyEnv: 'OPENROUTER_KEY',
          modelMap: { 'kimi-k2': 'moonshotai/kimi-k2' },
        },
      },
    }),
    async (configPath) => {
      const config = await loadConfig(configPath);
      assert.deepEqual(config.verifier?.services, ['Kimi-K2']);
      assert.equal(config.verifier?.probesPerAudit, 24);
      assert.equal(config.verifier?.probeSource, 'bank');
      assert.equal(config.verifier?.referencesDir, './refs');
      assert.deepEqual(config.verifier?.upstream, {
        baseUrl: 'https://openrouter.ai/api/v1',
        apiKeyEnv: 'OPENROUTER_KEY',
        modelMap: { 'kimi-k2': 'moonshotai/kimi-k2' },
      });
    }
  );
});

test('loadConfig rejects invalid verifier delegation settings', async () => {
  await withTempConfig(
    JSON.stringify({
      verifier: {
        delegation: {
          enabled: true,
          minDelegates: 0,
        },
      },
    }),
    async (configPath) => {
      await assert.rejects(
        async () => loadConfig(configPath),
        /verifier\.delegation\.minDelegates/
      );
    }
  );
});

test('loadConfig rejects invalid buyer peerRefreshIntervalMs', async () => {
  await withTempConfig(
    JSON.stringify({
      buyer: {
        peerRefreshIntervalMs: 999,
      },
    }),
    async (configPath) => {
      await assert.rejects(
        async () => loadConfig(configPath),
        /buyer\.peerRefreshIntervalMs/
      );
    }
  );
});

test('loadConfig rejects invalid buyer metadataFetchTimeoutMs', async () => {
  await withTempConfig(
    JSON.stringify({
      buyer: {
        metadataFetchTimeoutMs: 99,
      },
    }),
    async (configPath) => {
      await assert.rejects(
        async () => loadConfig(configPath),
        /buyer\.metadataFetchTimeoutMs/
      );
    }
  );
});

test('loadConfig preserves explicit non-default buyer minPeerReputation', async () => {
  await withTempConfig(
    JSON.stringify({
      buyer: {
        minPeerReputation: 42,
      },
    }),
    async (configPath) => {
      const config = await loadConfig(configPath);
      assert.equal(config.buyer.minPeerReputation, 42);
    }
  );
});

test('loadConfig rejects incomplete service pricing', async () => {
  await withTempConfig(
    JSON.stringify({
      seller: {
        providers: {
          anthropic: {
            plugin: 'anthropic',
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
            plugin: 'anthropic',
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
            plugin: 'openai',
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

test('loadConfig drops seller provider entries without plugin', async () => {
  await withTempConfig(
    JSON.stringify({
      seller: {
        providers: {
          openai: {
            services: {
              'gpt-4': {},
            },
          },
        },
      },
    }),
    async (configPath) => {
      const config = await loadConfig(configPath);
      assert.equal(config.seller.providers['openai'], undefined);
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

test('loadConfig preserves seller verifications.domains claims', async () => {
  await withTempConfig(
    JSON.stringify({
      seller: {
        verifications: {
          domains: [
            { domain: 'Example.COM', methods: ['https-well-known', 'dns-txt'] },
          ],
        },
      },
    }),
    async (configPath) => {
      const config = await loadConfig(configPath);
      assert.deepEqual(config.seller.verifications, {
        domains: [
          { domain: 'example.com', methods: ['https-well-known', 'dns-txt'] },
        ],
      });
    }
  );
});

test('loadConfig rejects unknown domain verification methods instead of dropping them', async () => {
  await withTempConfig(
    JSON.stringify({
      seller: {
        verifications: {
          domains: [
            { domain: 'example.com', methods: ['dns-text'] },
          ],
        },
      },
    }),
    async (configPath) => {
      await assert.rejects(
        loadConfig(configPath),
        /verifications\.domains\[0\]\.methods\[0\]/,
      );
    }
  );
});

test('loadConfig preserves seller verifications.github claims', async () => {
  await withTempConfig(
    JSON.stringify({
      seller: {
        verifications: {
          github: [
            { username: 'OctoCat' },
            { username: 'hubber', repository: 'Antseed-Proofs' },
          ],
        },
      },
    }),
    async (configPath) => {
      const config = await loadConfig(configPath);
      assert.deepEqual(config.seller.verifications, {
        github: [
          { username: 'octocat' },
          { username: 'hubber', repository: 'antseed-proofs' },
        ],
      });
    }
  );
});

test('loadConfig rejects invalid github verification usernames', async () => {
  await withTempConfig(
    JSON.stringify({
      seller: {
        verifications: {
          github: [
            { username: '-invalid-' },
          ],
        },
      },
    }),
    async (configPath) => {
      await assert.rejects(
        loadConfig(configPath),
        /verifications\.github\[0\]\.username/,
      );
    }
  );
});

test('loadConfig rejects empty seller verifications', async () => {
  await withTempConfig(
    JSON.stringify({
      seller: {
        verifications: { domains: [] },
      },
    }),
    async (configPath) => {
      await assert.rejects(
        loadConfig(configPath),
        /verifications\.domains/,
      );
    }
  );
});

test('loadConfig preserves seller maxUploadBodyBytes setting', async () => {
  await withTempConfig(
    JSON.stringify({
      seller: {
        maxUploadBodyBytes: 134217728,
      },
    }),
    async (configPath) => {
      const config = await loadConfig(configPath);
      assert.equal(config.seller.maxUploadBodyBytes, 134217728);
    }
  );
});

test('loadConfig rejects invalid seller maxUploadBodyBytes setting', async () => {
  await withTempConfig(
    JSON.stringify({
      seller: {
        maxUploadBodyBytes: 123,
      },
    }),
    async (configPath) => {
      await assert.rejects(
        async () => loadConfig(configPath),
        /seller\.maxUploadBodyBytes/
      );
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
