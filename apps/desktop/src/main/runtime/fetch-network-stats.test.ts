import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchNetworkStats } from './fetch-network-stats.js';

// Helper to make a mock fetch that returns a resolved response object
function mockFetch(response: unknown): typeof globalThis.fetch {
  return async () => response as Response;
}

// Helper to restore original fetch after each test
const originalFetch = globalThis.fetch;
function restoreFetch() {
  globalThis.fetch = originalFetch;
}

test('returns empty when URL is undefined', async () => {
  let called = false;
  globalThis.fetch = async () => { called = true; return null as unknown as Response; };
  try {
    const out = await fetchNetworkStats(undefined);
    assert.equal(out.size, 0);
    assert.equal(called, false);
  } finally {
    restoreFetch();
  }
});

test('happy path — maps agentId to bigint stats', async () => {
  globalThis.fetch = mockFetch({
    ok: true,
    json: async () => ({
      peers: [
        {
          peerId: 'p1',
          onChainStats: {
            agentId: 42,
            totalRequests: '100',
            totalInputTokens: '1000',
            totalOutputTokens: '500',
            lastUpdatedAt: 1700000000,
          },
        },
      ],
    }),
  });
  try {
    const out = await fetchNetworkStats('https://example.com/api');
    assert.equal(out.size, 1);
    const entry = out.get(42);
    assert.ok(entry, 'expected entry for agentId 42');
    assert.equal(entry.requests, 100n);
    assert.equal(entry.inputTokens, 1000n);
    assert.equal(entry.outputTokens, 500n);
  } finally {
    restoreFetch();
  }
});

test('timeout — returns empty map when AbortError is thrown', async () => {
  globalThis.fetch = async () => {
    const err = new Error('aborted');
    (err as NodeJS.ErrnoException).name = 'AbortError';
    throw err;
  };
  try {
    const out = await fetchNetworkStats('https://example.com/api');
    assert.equal(out.size, 0);
  } finally {
    restoreFetch();
  }
});

test('non-2xx — returns empty map', async () => {
  globalThis.fetch = mockFetch({
    ok: false,
    status: 503,
    statusText: 'Service Unavailable',
  });
  try {
    const out = await fetchNetworkStats('https://example.com/api');
    assert.equal(out.size, 0);
  } finally {
    restoreFetch();
  }
});

test('malformed JSON — returns empty map', async () => {
  globalThis.fetch = mockFetch({
    ok: true,
    json: async () => { throw new Error('parse'); },
  });
  try {
    const out = await fetchNetworkStats('https://example.com/api');
    assert.equal(out.size, 0);
  } finally {
    restoreFetch();
  }
});

test('peer with onChainStats: null is skipped, valid peer is included', async () => {
  globalThis.fetch = mockFetch({
    ok: true,
    json: async () => ({
      peers: [
        { peerId: 'p1', onChainStats: null },
        {
          peerId: 'p2',
          onChainStats: {
            agentId: 7,
            totalRequests: '50',
            totalInputTokens: '200',
            totalOutputTokens: '100',
          },
        },
      ],
    }),
  });
  try {
    const out = await fetchNetworkStats('https://example.com/api');
    assert.equal(out.size, 1);
    const entry = out.get(7);
    assert.ok(entry, 'expected entry for agentId 7');
    assert.equal(entry.requests, 50n);
    assert.equal(entry.inputTokens, 200n);
    assert.equal(entry.outputTokens, 100n);
    assert.equal(out.has(0), false);
  } finally {
    restoreFetch();
  }
});

test('peer with malformed numeric string is skipped, others remain', async () => {
  globalThis.fetch = mockFetch({
    ok: true,
    json: async () => ({
      peers: [
        {
          peerId: 'bad',
          onChainStats: {
            agentId: 10,
            totalRequests: 'not-a-number',
            totalInputTokens: '0',
            totalOutputTokens: '0',
          },
        },
        {
          peerId: 'good',
          onChainStats: {
            agentId: 11,
            totalRequests: '99',
            totalInputTokens: '888',
            totalOutputTokens: '777',
          },
        },
      ],
    }),
  });
  try {
    const out = await fetchNetworkStats('https://example.com/api');
    assert.equal(out.has(10), false);
    const entry = out.get(11);
    assert.ok(entry, 'expected entry for agentId 11');
    assert.equal(entry.requests, 99n);
    assert.equal(entry.inputTokens, 888n);
    assert.equal(entry.outputTokens, 777n);
  } finally {
    restoreFetch();
  }
});

test('trailing slashes in URL are stripped before appending /stats', async () => {
  const calls: string[] = [];
  globalThis.fetch = async (url: string | URL | Request) => {
    calls.push(String(url));
    return { ok: true, json: async () => ({ peers: [] }) } as unknown as Response;
  };
  try {
    await fetchNetworkStats('https://example.com/');
    await fetchNetworkStats('https://example.com//');
    assert.equal(calls[0], 'https://example.com/stats');
    assert.equal(calls[1], 'https://example.com/stats');
  } finally {
    restoreFetch();
  }
});
