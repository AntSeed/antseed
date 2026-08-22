import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchNetworkStats,
  fetchNetworkStatsFromExplorer,
  getNetworkStats,
  resetNetworkStatsCache,
} from './fetch-network-stats.js';

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

test('explorer: returns empty when URL is undefined', async () => {
  let called = false;
  globalThis.fetch = async () => { called = true; return null as unknown as Response; };
  try {
    const out = await fetchNetworkStatsFromExplorer(undefined);
    assert.equal(out.size, 0);
    assert.equal(called, false);
  } finally {
    restoreFetch();
  }
});

test('explorer: maps /api/sellers rows to bigint stats, skipping null agentIds', async () => {
  const calls: string[] = [];
  globalThis.fetch = async (url: string | URL | Request) => {
    calls.push(String(url));
    return {
      ok: true,
      json: async () => ([
        { agentId: '53008', requestCount: '2111335', inputTokens: '6120535493', outputTokens: '1169883968' },
        { agentId: null, requestCount: '0', inputTokens: '0', outputTokens: '0' },
        { agentId: '10', requestCount: 'not-a-number', inputTokens: '0', outputTokens: '0' },
      ]),
    } as unknown as Response;
  };
  try {
    const out = await fetchNetworkStatsFromExplorer('https://antscan.example/');
    assert.equal(calls[0], 'https://antscan.example/api/sellers');
    assert.equal(out.size, 1);
    const entry = out.get(53008);
    assert.ok(entry, 'expected entry for agentId 53008');
    assert.equal(entry.requests, 2111335n);
    assert.equal(entry.inputTokens, 6120535493n);
    assert.equal(entry.outputTokens, 1169883968n);
  } finally {
    restoreFetch();
  }
});

test('explorer: non-array payload returns empty map', async () => {
  globalThis.fetch = mockFetch({ ok: true, json: async () => ({ sellers: [] }) });
  try {
    const out = await fetchNetworkStatsFromExplorer('https://antscan.example');
    assert.equal(out.size, 0);
  } finally {
    restoreFetch();
  }
});

test('getNetworkStats: explorer result is cached — second call does not refetch', async () => {
  resetNetworkStatsCache();
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return {
      ok: true,
      json: async () => ([{ agentId: '7', requestCount: '1', inputTokens: '2', outputTokens: '3' }]),
    } as unknown as Response;
  };
  try {
    const urls = { explorerApiUrl: 'https://antscan.example', networkStatsUrl: 'https://stats.example' };
    const first = await getNetworkStats(urls);
    const second = await getNetworkStats(urls);
    assert.equal(calls, 1);
    assert.equal(first, second);
    assert.equal(first.get(7)?.requests, 1n);
  } finally {
    resetNetworkStatsCache();
    restoreFetch();
  }
});

test('getNetworkStats: falls back to the aggregator when the explorer returns nothing', async () => {
  resetNetworkStatsCache();
  const calls: string[] = [];
  globalThis.fetch = async (url: string | URL | Request) => {
    calls.push(String(url));
    if (String(url).includes('/api/sellers')) {
      return { ok: false, status: 503, statusText: 'down' } as unknown as Response;
    }
    return {
      ok: true,
      json: async () => ({
        peers: [{ peerId: 'p', onChainStats: { agentId: 9, totalRequests: '4', totalInputTokens: '5', totalOutputTokens: '6' } }],
      }),
    } as unknown as Response;
  };
  try {
    const out = await getNetworkStats({ explorerApiUrl: 'https://antscan.example', networkStatsUrl: 'https://stats.example' });
    assert.deepEqual(calls, ['https://antscan.example/api/sellers', 'https://stats.example/stats']);
    assert.equal(out.get(9)?.requests, 4n);
  } finally {
    resetNetworkStatsCache();
    restoreFetch();
  }
});

test('getNetworkStats: both sources failing with no prior cache returns empty', async () => {
  resetNetworkStatsCache();
  globalThis.fetch = async () => { throw new Error('network down'); };
  try {
    const out = await getNetworkStats({ explorerApiUrl: 'https://antscan.example', networkStatsUrl: 'https://stats.example' });
    assert.equal(out.size, 0);
  } finally {
    resetNetworkStatsCache();
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
