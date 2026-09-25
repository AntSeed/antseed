import { once } from 'node:events'
import type { ServerResponse } from 'node:http'
import { VIDEO_DOWNLOAD_STREAM_HEADER, VIDEO_DOWNLOAD_STREAM_VERSION, VIDEO_DOWNLOAD_MAX_BYTES, type RequestStreamCallbacks, type SerializedHttpRequest, type SerializedHttpResponse } from '@antseed/node'

type SendDownload = (request: SerializedHttpRequest, callbacks: RequestStreamCallbacks, signal: AbortSignal) => Promise<SerializedHttpResponse>
let activeDownloads = 0

export async function downloadVideo(request: SerializedHttpRequest, response: ServerResponse, send: SendDownload, clientSignal: AbortSignal): Promise<void> {
  const error = (status: number, code: string) => {
    response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    response.end(JSON.stringify({ error: { code, message: 'Video download unavailable' } }))
  }
  if (activeDownloads >= 2) { error(429, 'video_download_busy'); return }
  activeDownloads += 1
  const controller = new AbortController()
  const signal = AbortSignal.any([clientSignal, controller.signal, AbortSignal.timeout(5 * 60_000)])
  const headers = Object.fromEntries(Object.entries(request.headers).filter(([key]) => !['range', 'if-range', 'content-length', 'accept-encoding'].includes(key.toLowerCase())))
  let length = 0
  let received = 0
  try {
    const result = await send({ ...request, headers: { ...headers, [VIDEO_DOWNLOAD_STREAM_HEADER]: VIDEO_DOWNLOAD_STREAM_VERSION }, body: new Uint8Array(0) }, {
      onResponseStart: (start, metadata) => {
        if (!metadata.streaming) return
        length = Number(start.headers['content-length'])
        if (start.statusCode !== 200 || start.headers['content-type'] !== 'video/mp4' || !Number.isSafeInteger(length) || length <= 0 || length > VIDEO_DOWNLOAD_MAX_BYTES) throw new Error('Invalid video stream')
        response.writeHead(200, { 'content-type': 'video/mp4', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
      },
      onResponseChunk: async chunk => {
        signal.throwIfAborted()
        received += chunk.data.length
        if (!length || received > length) throw new Error('Invalid video size')
        if (chunk.data.length && !response.write(Buffer.from(chunk.data))) await once(response, 'drain', { signal })
      },
    }, signal)
    signal.throwIfAborted()
    if (!response.headersSent) {
      error([400, 404, 409, 410, 413, 429, 503, 504].includes(result.statusCode) ? result.statusCode : 502, 'video_download_unavailable')
      return
    }
    if (result.statusCode !== 200 || received !== length) throw new Error('Incomplete video')
    response.end()
  } catch {
    if (response.headersSent || clientSignal.aborted) response.destroy()
    else error(signal.aborted ? 504 : 502, 'video_download_failed')
  } finally {
    controller.abort()
    activeDownloads -= 1
  }
}
