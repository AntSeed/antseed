import assert from 'node:assert/strict';
import test from 'node:test';
import {
  fetchBuyerSpendHistory,
  resetBuyerSpendHistoryCacheForTests,
} from './buyer-spend-history.js';

const NOW_MS = Date.UTC(2026, 7, 10, 12);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test.beforeEach(() => resetBuyerSpendHistoryCacheForTests());

test('fetchBuyerSpendHistory paginates Antscan settlements and aggregates daily spend and tokens', async () => {
  let requestUrl = '';
  const requestBodies: Record<string, unknown>[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    requestUrl = String(input);
    const requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requestBodies.push(requestBody);
    const after = (requestBody['variables'] as Record<string, unknown>)['after'];
    return jsonResponse({
      data: {
        settlementVolumes: {
          items: after === null ? [
            { day: '2026-08-09', dayStart: 1_786_233_600, deltaUsdc: '125000', inputTokens: '100', outputTokens: '25' },
            { day: 'invalid', dayStart: 1_786_320_000, deltaUsdc: '500', inputTokens: '2', outputTokens: '1' },
          ] : [
            { day: '2026-08-09', dayStart: 1_786_233_600, deltaUsdc: '75000', inputTokens: '40', outputTokens: '10' },
          ],
          pageInfo: after === null
            ? { hasNextPage: true, endCursor: 'next-page' }
            : { hasNextPage: false, endCursor: null },
        },
      },
    });
  };

  const result = await fetchBuyerSpendHistory({
    address: '0xAbCd',
    chainId: 8453,
    fetchImpl,
    nowMs: NOW_MS,
  });

  assert.equal(requestUrl, 'https://antscan.co/graphql');
  assert.deepEqual(requestBodies[0]?.['variables'], {
    address: '0xabcd',
    cutoff: 1_778_630_400,
    after: null,
  });
  assert.equal((requestBodies[1]?.['variables'] as Record<string, unknown>)['after'], 'next-page');
  assert.deepEqual(result, {
    available: true,
    source: 'antscan',
    unavailableReason: null,
    days: [{
      day: '2026-08-09',
      dayStart: 1_786_233_600,
      spentUsdc: '200000',
      inputTokens: '140',
      outputTokens: '35',
    }],
  });
});

test('fetchBuyerSpendHistory reuses a successful result for 60 seconds', async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    return jsonResponse({
      data: {
        settlementVolumes: {
          items: [],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    });
  };

  await fetchBuyerSpendHistory({ address: '0x1234', chainId: 8453, fetchImpl, nowMs: NOW_MS });
  await fetchBuyerSpendHistory({ address: '0x1234', chainId: 8453, fetchImpl, nowMs: NOW_MS + 59_999 });

  assert.equal(calls, 1);
});

test('fetchBuyerSpendHistory does not call Antscan without a Base wallet', async () => {
  const fetchImpl: typeof fetch = async () => {
    throw new Error('unexpected fetch');
  };

  assert.deepEqual(
    await fetchBuyerSpendHistory({ address: null, chainId: 8453, fetchImpl, nowMs: NOW_MS }),
    { available: false, source: 'antscan', unavailableReason: 'no-wallet', days: [] },
  );
  assert.deepEqual(
    await fetchBuyerSpendHistory({ address: '0x1234', chainId: 31337, fetchImpl, nowMs: NOW_MS }),
    { available: false, source: 'antscan', unavailableReason: 'unsupported-network', days: [] },
  );
});

test('fetchBuyerSpendHistory rejects transport, HTTP, and GraphQL failures', async () => {
  await assert.rejects(
    fetchBuyerSpendHistory({
      address: '0x1234',
      chainId: 8453,
      nowMs: NOW_MS,
      fetchImpl: async () => { throw new Error('offline'); },
    }),
    /offline/,
  );

  await assert.rejects(
    fetchBuyerSpendHistory({
      address: '0x1234',
      chainId: 8453,
      nowMs: NOW_MS,
      fetchImpl: async () => jsonResponse({}, 503),
    }),
    /HTTP 503/,
  );

  await assert.rejects(
    fetchBuyerSpendHistory({
      address: '0x1234',
      chainId: 8453,
      nowMs: NOW_MS,
      fetchImpl: async () => jsonResponse({ errors: [{ message: 'bad query' }] }),
    }),
    /GraphQL error/,
  );
});
