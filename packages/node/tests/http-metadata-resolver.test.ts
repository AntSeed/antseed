import { describe, it, expect, vi, afterEach } from 'vitest';
import { HttpMetadataResolver } from '../src/discovery/http-metadata-resolver.js';
import { METADATA_VERSION, type PeerMetadata } from '../src/discovery/peer-metadata.js';

function buildMetadata(overrides?: Partial<PeerMetadata>): PeerMetadata {
  return {
    peerId: 'a'.repeat(64) as any,
    version: METADATA_VERSION,
    providers: [
      {
        provider: 'anthropic',
        models: ['claude-3-opus'],
        defaultPricing: {
          inputUsdPerMillion: 15,
          outputUsdPerMillion: 75,
        },
        maxConcurrency: 10,
        currentLoad: 0,
      },
    ],
    region: 'test',
    timestamp: Date.now(),
    signature: 'b'.repeat(128),
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('HttpMetadataResolver', () => {
  it('caches failed endpoints for the configured cooldown', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
    vi.stubGlobal('fetch', fetchMock);

    const resolver = new HttpMetadataResolver({
      timeoutMs: 100,
      failureCooldownMs: 60_000,
    });
    const peer = { host: '84.228.226.179', port: 6882 };

    const first = await resolver.resolve(peer);
    const second = await resolver.resolve(peer);

    expect(first).toBeNull();
    expect(second).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('skips other ports for a host after any port fails (host-level cache)', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
    vi.stubGlobal('fetch', fetchMock);

    const resolver = new HttpMetadataResolver({
      timeoutMs: 100,
      failureCooldownMs: 60_000,
    });

    // First call on a random ephemeral port fails and marks the host
    const first = await resolver.resolve({ host: '18.200.194.8', port: 57882 });
    // Second call on the correct port is skipped immediately (host-level cache)
    const second = await resolver.resolve({ host: '18.200.194.8', port: 6882 });

    expect(first).toBeNull();
    expect(second).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries an endpoint after cooldown expires', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

    const metadata = buildMetadata();
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(
        new Response(JSON.stringify(metadata), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const resolver = new HttpMetadataResolver({
      timeoutMs: 100,
      failureCooldownMs: 1_000,
    });
    const peer = { host: '147.236.231.105', port: 6882 };

    const first = await resolver.resolve(peer);
    const skipped = await resolver.resolve(peer);
    vi.setSystemTime(new Date('2026-01-01T00:00:01.001Z'));
    const retried = await resolver.resolve(peer);

    expect(first).toBeNull();
    expect(skipped).toBeNull();
    expect(retried).toEqual(metadata);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
