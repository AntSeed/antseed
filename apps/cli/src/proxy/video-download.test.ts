import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { downloadVideo } from './video-download.js'
import { VIDEO_DOWNLOAD_CHUNK_BYTES, type SerializedHttpRequest, type SerializedHttpResponse } from '@antseed/api-adapter'

const request: SerializedHttpRequest = { requestId: 'download', method: 'GET', path: '/v1beta/operations/task/videos/0:download', headers: {}, body: new Uint8Array() }
const video = Buffer.alloc(VIDEO_DOWNLOAD_CHUNK_BYTES * 3 + 17, 42)
function part(request: SerializedHttpRequest): SerializedHttpResponse {
  const [start, end] = request.headers.range!.slice(6).split('-').map(Number) as [number, number]
  const last = Math.min(end, video.length - 1)
  return { requestId: request.requestId, statusCode: 206, headers: { 'content-type': 'video/mp4', 'content-range': `bytes ${start}-${last}/${video.length}`, 'x-antseed-video-file': 'file' }, body: video.subarray(start, last + 1) }
}

async function serve(send: (request: SerializedHttpRequest, signal: AbortSignal) => Promise<SerializedHttpResponse>, run: (url: string) => Promise<void>) {
  const server = createServer((_incoming, response) => {
    const abort = new AbortController()
    response.on('close', () => abort.abort())
    void downloadVideo(request, response, send, abort.signal)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address() as { port: number }
    await run(`http://127.0.0.1:${address.port}`)
  } finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
}

test('streams a complete file using sequential bounded responses and unique request IDs', async () => {
  const ids = new Set<string>()
  let offset = 0
  await serve(async request => {
    assert.ok(!ids.has(request.requestId))
    ids.add(request.requestId)
    assert.equal(request.headers.range, `bytes=${offset}-${Math.min(offset + VIDEO_DOWNLOAD_CHUNK_BYTES, offset ? video.length : Number.MAX_SAFE_INTEGER) - 1}`)
    const response = part(request)
    offset += response.body.length
    return response
  }, async url => {
    const response = await fetch(url)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'video/mp4')
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), video)
  })
  assert.equal(ids.size, 4)
})

test('returns clear errors before starting a download', async () => {
  for (const status of [404, 409, 410, 429, 504]) {
    await serve(async request => ({ requestId: request.requestId, statusCode: status, headers: {}, body: new Uint8Array() }), async url => {
      const response = await fetch(url)
      assert.equal(response.status, status)
      const body = await response.json() as { error: { code: string } }
      assert.equal(body.error.code, 'video_download_unavailable')
    })
  }
})

test('rejects malformed and oversized ranges before returning bytes', async () => {
  for (const contentRange of ['bytes 1-65536/100000', 'bytes 0-65535/999999999', 'bad']) {
    await serve(async request => ({ ...part(request), headers: { ...part(request).headers, 'content-range': contentRange } }), async url => {
      const response = await fetch(url)
      assert.equal(response.status, 502)
      await response.arrayBuffer()
    })
  }
})

test('aborts partial downloads instead of appending JSON errors or switching files', async () => {
  let calls = 0
  await serve(async request => {
    calls += 1
    const result = part(request)
    if (calls === 2) result.headers['x-antseed-video-file'] = 'other-file'
    return result
  }, async url => {
    await assert.rejects(async () => {
      const response = await fetch(url)
      await response.arrayBuffer()
    })
  })
  assert.equal(calls, 2)
})

test('stops requesting ranges when the client disconnects', async () => {
  let calls = 0
  let cancelled!: () => void
  const cancellation = new Promise<void>(resolve => { cancelled = resolve })
  await serve(async (request, signal) => {
    calls += 1
    if (calls === 2) {
      await new Promise<void>(resolve => signal.addEventListener('abort', () => { cancelled(); resolve() }, { once: true }))
    }
    return part(request)
  }, async url => {
    const response = await fetch(url)
    await response.body!.cancel()
    await cancellation
  })
  assert.equal(calls, 2)
})
