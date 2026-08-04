import assert from 'node:assert/strict'
import test from 'node:test'
import {
  calculateTrafficShareBps,
  resolveAntscanTrafficShare,
} from './traffic-share.js'

const SELLER = `0x${'11'.repeat(20)}`
const SERVICE = `0x${'22'.repeat(32)}`
const OTHER_SERVICE = `0x${'33'.repeat(32)}`
const WINDOW = { epoch: 7n, startedAt: 1_800_000_000, endsAt: 1_800_604_800 }

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

test('calculates ceiling basis points and preserves exact zero traffic', () => {
  assert.equal(calculateTrafficShareBps(0n, 0n), 0)
  assert.equal(calculateTrafficShareBps(0n, 10_000n), 0)
  assert.equal(calculateTrafficShareBps(1n, 1_000_000n), 1)
  assert.equal(calculateTrafficShareBps(2_501n, 10_000n), 2_501)
  assert.equal(calculateTrafficShareBps(10_000n, 10_000n), 10_000)
  assert.throws(() => calculateTrafficShareBps(2n, 1n), /exceeds seller traffic/)
})

test('paginates complete seller history beyond 5000 rows and aggregates settled USDC', async () => {
  const rows = Array.from({ length: 5_001 }, (_unused, index) => ({
    id: `row-${index}`,
    seller: SELLER,
    serviceId: index % 5 === 0 ? SERVICE : OTHER_SERVICE,
    deltaAmountUsdc: String(index + 1),
    blockNumber: 100 + index,
    timestamp: WINDOW.startedAt + index,
  }))
  let graphqlCalls = 0
  const snapshot = await resolveAntscanTrafficShare({
    sellerAddress: SELLER,
    serviceHash: SERVICE,
    epochWindow: WINDOW,
  }, {
    pageSize: 1_000,
    fetchImpl: async (url, init) => {
      if (String(url).endsWith('/api/overview')) {
        return jsonResponse({ sync: { status: 'synced', indexedBlock: 10_000 } })
      }
      graphqlCalls += 1
      const body = JSON.parse(String(init?.body)) as { variables: { after: string | null; limit: number } }
      const offset = body.variables.after === null ? 0 : Number(body.variables.after)
      const items = rows.slice(offset, offset + body.variables.limit)
      const nextOffset = offset + items.length
      return jsonResponse({
        data: {
          settlementServices: {
            items,
            totalCount: rows.length,
            pageInfo: {
              hasNextPage: nextOffset < rows.length,
              endCursor: nextOffset < rows.length ? String(nextOffset) : null,
            },
          },
        },
      })
    },
  })

  const sellerVolume = rows.reduce((total, row) => total + BigInt(row.deltaAmountUsdc), 0n)
  const serviceVolume = rows
    .filter((row) => row.serviceId === SERVICE)
    .reduce((total, row) => total + BigInt(row.deltaAmountUsdc), 0n)
  assert.equal(graphqlCalls, 6)
  assert.equal(snapshot.sellerVolumeUsdc, sellerVolume)
  assert.equal(snapshot.serviceVolumeUsdc, serviceVolume)
  assert.equal(snapshot.modelShareBps, calculateTrafficShareBps(serviceVolume, sellerVolume))
  assert.equal(snapshot.indexedBlock, 10_000)
})

test('fails closed for unsynced and incomplete Antscan data', async () => {
  await assert.rejects(resolveAntscanTrafficShare({
    sellerAddress: SELLER,
    serviceHash: SERVICE,
    epochWindow: WINDOW,
  }, {
    fetchImpl: async () => jsonResponse({ sync: { status: 'backfilling', indexedBlock: 10 } }),
  }), /not synced/)

  let calls = 0
  await assert.rejects(resolveAntscanTrafficShare({
    sellerAddress: SELLER,
    serviceHash: SERVICE,
    epochWindow: WINDOW,
  }, {
    fetchImpl: async (url) => {
      if (String(url).endsWith('/api/overview')) {
        return jsonResponse({ sync: { status: 'synced', indexedBlock: 10 } })
      }
      calls += 1
      return jsonResponse({
        data: {
          settlementServices: {
            items: [],
            totalCount: 1,
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      })
    },
  }), /incomplete Antscan pagination/)
  assert.equal(calls, 1)
})

test('rejects rows outside the captured epoch and block snapshot', async () => {
  await assert.rejects(resolveAntscanTrafficShare({
    sellerAddress: SELLER,
    serviceHash: SERVICE,
    epochWindow: WINDOW,
  }, {
    fetchImpl: async (url) => String(url).endsWith('/api/overview')
      ? jsonResponse({ sync: { status: 'synced', indexedBlock: 100 } })
      : jsonResponse({
        data: {
          settlementServices: {
            items: [{
              id: 'outside',
              seller: SELLER,
              serviceId: SERVICE,
              deltaAmountUsdc: '1',
              blockNumber: 101,
              timestamp: WINDOW.startedAt,
            }],
            totalCount: 1,
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      }),
  }), /outside the requested snapshot/)
})
