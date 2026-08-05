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
  assert.equal(config.verifier?.referenceMaxConcurrentRequests, 4);
  assert.equal(config.verifier?.referenceMaxConcurrentRequestsPerModel, 3);
  assert.equal(config.verifier?.referenceMinimumProbeCount, 100);
  assert.equal(config.verifier?.referenceMaximumProbeCount, 500);
  assert.equal(config.verifier?.referenceProbeStep, 10);
  assert.equal(config.verifier?.referenceMinimumStatisticalPower, 0.9);
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

test('loadConfig preserves and validates verifier settings', async () => {
  const referenceEndpoint = {
    baseUrl: 'https://reference.example/v1',
    sourceId: 'trusted-reference-v1',
    trust: 'trusted',
    models: {
      'gpt-5.6-sol': {
        upstreamModel: 'gpt-5.6-sol',
        contrastModels: ['kimi-k3'],
      },
    },
  };
  await withTempConfig(JSON.stringify({
    verifier: {
      referencesDir: './refs',
      evidenceDir: './evidence',
      probeRequestTimeoutMs: 90_000,
      referenceEndpoint,
      referenceMaxRequestsPerBuild: 500,
      referenceBatchRetryCount: 2,
      referenceRetryBaseDelayMs: 250,
      referenceMaxNoProgressRounds: 2,
      referenceMaxConcurrentRequests: 2,
      referenceMaxConcurrentRequestsPerModel: 1,
      referenceMinimumProbeCount: 120,
      referenceMaximumProbeCount: 240,
      referenceProbeStep: 20,
      referenceMinimumStatisticalPower: 0.95,
    },
  }), async (configPath) => {
    const config = await loadConfig(configPath);
    assert.equal(config.verifier?.referencesDir, './refs');
    assert.equal(config.verifier?.referenceEndpoint?.sourceId, 'trusted-reference-v1');
    assert.equal(config.verifier?.referenceMaxRequestsPerBuild, 500);
    assert.equal(config.verifier?.referenceMinimumProbeCount, 120);
    assert.equal(config.verifier?.referenceMaximumProbeCount, 240);
    assert.equal(config.verifier?.referenceProbeStep, 20);
    assert.equal(config.verifier?.referenceMinimumStatisticalPower, 0.95);
  });
});

test('loadConfig rejects invalid verifier settings', async () => {
  await withTempConfig(JSON.stringify({ verifier: { referenceBatchRetryCount: -1 } }), async (configPath) => {
    await assert.rejects(loadConfig(configPath), /referenceBatchRetryCount/);
  });
  await withTempConfig(JSON.stringify({ verifier: { probesPerAudti: 24 } }), async (configPath) => {
    await assert.rejects(loadConfig(configPath), /verifier\.probesPerAudti/);
  });
  await withTempConfig(JSON.stringify({ verifier: { referenceMinimumProbeCount: 105 } }), async (configPath) => {
    await assert.rejects(loadConfig(configPath), /referenceMinimumProbeCount/);
  });
  await withTempConfig(JSON.stringify({ verifier: {
    referenceMinimumProbeCount: 120,
    referenceMaximumProbeCount: 100,
  } }), async (configPath) => {
    await assert.rejects(loadConfig(configPath), /must not exceed/);
  });
  await withTempConfig(JSON.stringify({ verifier: {
    referenceMinimumProbeCount: 100,
    referenceMaximumProbeCount: 150,
    referenceProbeStep: 20,
  } }), async (configPath) => {
    await assert.rejects(loadConfig(configPath), /must divide/);
  });
  for (const power of [0, 1.01]) {
    await withTempConfig(JSON.stringify({ verifier: { referenceMinimumStatisticalPower: power } }), async (configPath) => {
      await assert.rejects(loadConfig(configPath), /referenceMinimumStatisticalPower/);
    });
  }
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
