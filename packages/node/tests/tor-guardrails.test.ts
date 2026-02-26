import { afterEach, describe, expect, it, vi } from 'vitest';
import { AntseedNode } from '../src/node.js';

const BUYER_PEER_ID = 'a'.repeat(64);
const SELLER_PEER_ID = 'b'.repeat(64);
const OTHER_PEER_ID = 'c'.repeat(64);

function attachIdentity(node: AntseedNode, peerId = BUYER_PEER_ID): void {
  (node as unknown as {
    _identity: {
      peerId: string;
      privateKey: Uint8Array;
      publicKey: Uint8Array;
    };
  })._identity = {
    peerId,
    privateKey: new Uint8Array(32),
    publicKey: new Uint8Array(32),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Tor guardrails (buyer)', () => {
  it('rejects onion manual peers when socks proxy is not configured', async () => {
    const node = new AntseedNode({
      role: 'buyer',
      tor: {
        enabled: true,
        manualPeers: [`${SELLER_PEER_ID}@abcdefghijklmnop.onion:80`],
      },
    });
    attachIdentity(node);

    await expect(
      (node as unknown as { _startBuyer: (bootstrap: Array<{ host: string; port: number }>) => Promise<void> })
        ._startBuyer([])
    ).rejects.toThrow(/requires tor\.socksProxy/i);
  });

  it('rejects onion manual peers without explicit peerId', async () => {
    const node = new AntseedNode({
      role: 'buyer',
      tor: {
        enabled: true,
        manualPeers: ['abcdefghijklmnop.onion:80'],
        socksProxy: { host: '127.0.0.1', port: 9050 },
      },
    });
    attachIdentity(node);

    await expect(
      (node as unknown as { _startBuyer: (bootstrap: Array<{ host: string; port: number }>) => Promise<void> })
        ._startBuyer([])
    ).rejects.toThrow(/requires peerId@host:port/i);
  });

  it('rejects non-onion peers unless allowDirectFallback=true', async () => {
    const node = new AntseedNode({
      role: 'buyer',
      tor: {
        enabled: true,
        manualPeers: [`${SELLER_PEER_ID}@127.0.0.1:6882`],
      },
    });
    attachIdentity(node);

    await expect(
      (node as unknown as { _startBuyer: (bootstrap: Array<{ host: string; port: number }>) => Promise<void> })
        ._startBuyer([])
    ).rejects.toThrow(/only allows \.onion manual peers/i);
  });

  it('starts buyer in tor mode with valid onion manual peer + socks proxy', async () => {
    const node = new AntseedNode({
      role: 'buyer',
      tor: {
        enabled: true,
        manualPeers: [`${SELLER_PEER_ID}@abcdefghijklmnop.onion:80`],
        socksProxy: { host: '127.0.0.1', port: 9050 },
      },
    });
    attachIdentity(node);

    await expect(
      (node as unknown as { _startBuyer: (bootstrap: Array<{ host: string; port: number }>) => Promise<void> })
        ._startBuyer([])
    ).resolves.toBeUndefined();
  });
});

describe('Tor manual discovery', () => {
  it('skips mismatched metadata peerId instead of falling back to synthetic peer', async () => {
    const node = new AntseedNode({
      role: 'buyer',
      tor: {
        enabled: true,
        manualPeerProviders: ['anthropic'],
      },
    });

    const mutableNode = node as unknown as {
      _started: boolean;
      _torManualPeers: Array<{ raw: string; peerId?: string; host: string; port: number }>;
      _discoverTorManualPeers: () => Promise<Array<{ peerId: string }>>;
    };
    mutableNode._started = true;
    mutableNode._torManualPeers = [
      {
        raw: `${SELLER_PEER_ID}@127.0.0.1:6882`,
        peerId: SELLER_PEER_ID,
        host: '127.0.0.1',
        port: 6882,
      },
    ];

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          peerId: OTHER_PEER_ID,
          version: 2,
          providers: [
            {
              provider: 'anthropic',
              models: ['claude-3-opus'],
              defaultPricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 },
              maxConcurrency: 4,
              currentLoad: 0,
            },
          ],
          region: 'test',
          timestamp: Date.now(),
          signature: 'd'.repeat(128),
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    const peers = await mutableNode._discoverTorManualPeers();
    expect(peers).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not attempt metadata HTTP fetch for onion endpoints', async () => {
    const node = new AntseedNode({
      role: 'buyer',
      tor: {
        enabled: true,
        manualPeerProviders: ['anthropic', 'openai'],
      },
    });

    const mutableNode = node as unknown as {
      _started: boolean;
      _torManualPeers: Array<{ raw: string; peerId?: string; host: string; port: number }>;
      _discoverTorManualPeers: () => Promise<
        Array<{ peerId: string; providers: string[]; publicAddress?: string }>
      >;
    };
    mutableNode._started = true;
    mutableNode._torManualPeers = [
      {
        raw: `${SELLER_PEER_ID}@abcdefghijklmnop.onion:80`,
        peerId: SELLER_PEER_ID,
        host: 'abcdefghijklmnop.onion',
        port: 80,
      },
    ];

    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const peers = await mutableNode._discoverTorManualPeers();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(peers).toHaveLength(1);
    expect(peers[0]?.peerId).toBe(SELLER_PEER_ID);
    expect(peers[0]?.providers).toEqual(['anthropic', 'openai']);
    expect(peers[0]?.publicAddress).toBe('abcdefghijklmnop.onion:80');
  });
});
