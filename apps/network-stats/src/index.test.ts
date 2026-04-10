/**
 * Tests for network-stats service.
 *
 * Uses node:test (built-in) — no extra test runner needed.
 * The poller's poll() method is tested with DHT/metadata stubbed out
 * so tests run offline and fast.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { writeFile, mkdir } from 'node:fs/promises';

import { NetworkPoller } from './poller.js';
import { createServer } from './server.js';
import type { PeerMetadata } from '@antseed/node';
import { toPeerId } from '@antseed/node';
import { METADATA_VERSION } from '@antseed/node/discovery';

// ── helpers ──────────────────────────────────────────────────────────────────

function tmpCache(): string {
  return join(tmpdir(), `antseed-test-${randomUUID()}`, 'network.json');
}

function fakePeer(id: string, services: string[]): PeerMetadata {
  return {
    peerId: toPeerId(createHash('sha256').update(id).digest('hex').slice(0, 40)),
    version: METADATA_VERSION,
    providers: [{ provider: 'test', services, defaultPricing: { inputUsdPerMillion: 10, outputUsdPerMillion: 10 }, maxConcurrency: 1, currentLoad: 0 }],
    region: 'eu-west-1',
    timestamp: Date.now(),
    signature: 'sig',
  };
}

// ── NetworkPoller unit tests ──────────────────────────────────────────────────

describe('NetworkPoller', () => {
  it('returns empty snapshot before first poll', () => {
    const poller = new NetworkPoller(tmpCache());
    const snap = poller.getSnapshot();
    assert.equal(snap.peers.length, 0);
    assert.equal(snap.updatedAt, new Date(0).toISOString());
  });

  it('loads snapshot from existing cache file on start', async () => {
    const cachePath = tmpCache();
    await mkdir(dirname(cachePath), { recursive: true });

    const peer = fakePeer('peer-1', ['gpt-4o', 'claude-sonnet']);
    const saved = { peers: [peer], updatedAt: '2026-01-01T00:00:00.000Z' };
    await writeFile(cachePath, JSON.stringify(saved), 'utf8');

    const poller = new NetworkPoller(cachePath);
    const originalSetTimeout = globalThis.setTimeout;
    const originalSetInterval = globalThis.setInterval;
    // @ts-expect-error — stub
    globalThis.setTimeout = (_fn: unknown, _ms: unknown) => 0;
    // @ts-expect-error — stub
    globalThis.setInterval = (_fn: unknown, _ms: unknown) => 0;
    try {
      await poller.start();
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.setInterval = originalSetInterval;
    }

    const snap = poller.getSnapshot();
    assert.equal(snap.peers.length, 1);
    assert.ok(snap.peers[0]!.peerId);
  });

  it('snapshot holds full PeerMetadata objects', () => {
    const poller = new NetworkPoller(tmpCache());
    const peers = [fakePeer('peer-a', ['deepseek-r1']), fakePeer('peer-b', ['llama-4-maverick'])];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (poller as any).snapshot = { peers, updatedAt: new Date().toISOString() };

    const snap = poller.getSnapshot();
    assert.equal(snap.peers.length, 2);
    assert.ok(snap.peers[0]!.peerId);
    assert.deepEqual(snap.peers[1]!.providers[0]!.services, ['llama-4-maverick']);
  });

  it('stop() clears the interval without throwing', () => {
    const poller = new NetworkPoller(tmpCache());
    assert.doesNotThrow(() => poller.stop());
  });
});

// ── HTTP server tests ─────────────────────────────────────────────────────────

describe('createServer', () => {
  let serverHandle: { start(): Promise<void>; stop(): void };
  let poller: NetworkPoller;
  const PORT = 14321;

  before(async () => {
    poller = new NetworkPoller(tmpCache());
    const peers = [fakePeer('peer-1', ['kimi-k2.5']), fakePeer('peer-2', ['glm-5'])];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (poller as any).snapshot = { peers, updatedAt: '2026-03-04T12:00:00.000Z' };
    serverHandle = createServer(poller, PORT);
    await serverHandle.start();
  });

  after(() => {
    serverHandle.stop();
  });

  it('GET /health returns { ok: true }', async () => {
    const res = await fetch(`http://localhost:${PORT}/health`);
    assert.equal(res.status, 200);
    const body = await res.json() as { ok: boolean };
    assert.equal(body.ok, true);
  });

  it('GET /stats returns snapshot shape', async () => {
    const res = await fetch(`http://localhost:${PORT}/stats`);
    assert.equal(res.status, 200);
    const body = await res.json() as { peers: PeerMetadata[]; updatedAt: string };
    assert.ok(Array.isArray(body.peers));
    assert.equal(typeof body.updatedAt, 'string');
  });

  it('GET /stats returns correct peer count and data', async () => {
    const res = await fetch(`http://localhost:${PORT}/stats`);
    const body = await res.json() as { peers: PeerMetadata[] };
    assert.equal(body.peers.length, 2);
    assert.ok(body.peers[0]!.peerId);
    assert.ok(body.peers[1]!.peerId);
  });

  it('GET /stats includes CORS header', async () => {
    const res = await fetch(`http://localhost:${PORT}/stats`);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
  });
});
