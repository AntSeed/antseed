import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import type { ServerResponse } from 'node:http'
import { videoContentRange, VIDEO_DOWNLOAD_CHUNK_BYTES, type SerializedHttpRequest, type SerializedHttpResponse } from '@antseed/api-adapter'

type SendRange = (request: SerializedHttpRequest, signal: AbortSignal) => Promise<SerializedHttpResponse>
let activeDownloads = 0

export async function downloadVideo(request: SerializedHttpRequest, response: ServerResponse, sendRange: SendRange, clientSignal: AbortSignal): Promise<void> {
  const error = (status: number, code: string, message: string) => {
    response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    response.end(JSON.stringify({ error: { code, message } }))
  }
  if (activeDownloads >= 2) {
    error(429, 'video_download_busy', 'Too many concurrent video downloads')
    return
  }
  activeDownloads += 1
  const signal = AbortSignal.any([clientSignal, AbortSignal.timeout(5 * 60_000)])
  const headers = Object.fromEntries(Object.entries(request.headers).filter(([key]) => !['range', 'if-range', 'content-length', 'accept-encoding'].includes(key.toLowerCase())))
  let total: number | undefined
  let file: string | undefined
  let offset = 0
  try {
    do {
      signal.throwIfAborted()
      const end = Math.min(offset + VIDEO_DOWNLOAD_CHUNK_BYTES, total ?? Number.MAX_SAFE_INTEGER) - 1
      const range = await sendRange({ ...request, requestId: randomUUID(), headers: { ...headers, range: `bytes=${offset}-${end}` }, body: new Uint8Array(0) }, signal)
      signal.throwIfAborted()
      if (range.statusCode !== 206) {
        if (response.headersSent) throw new Error('Video download interrupted')
        const status = [400, 404, 409, 410, 413, 416, 429, 503, 504].includes(range.statusCode) ? range.statusCode : 502
        error(status, 'video_download_unavailable', 'Video is unavailable, not ready, or the seller does not support downloads')
        return
      }
      const parsed = videoContentRange(range.headers['content-range'])
      const identity = range.headers['x-antseed-video-file']
      if (!parsed || parsed.start !== offset || parsed.end !== Math.min(end, parsed.total - 1)
        || range.body.length !== parsed.end - offset + 1 || range.headers['content-type'] !== 'video/mp4'
        || (total !== undefined && parsed.total !== total) || (file !== undefined && identity !== file)
        || typeof identity !== 'string' || !/^[A-Za-z0-9_-]+$/.test(identity)) {
        throw new Error('Invalid video download range')
      }
      total = parsed.total
      file = identity
      if (!response.headersSent) {
        response.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(total), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
      }
      offset += range.body.length
      if (!response.write(Buffer.from(range.body))) await once(response, 'drain', { signal })
    } while (offset < total!)
    response.end()
  } catch {
    if (response.headersSent || clientSignal.aborted) response.destroy()
    else error(signal.aborted ? 504 : 502, 'video_download_failed', 'Video download failed')
  } finally {
    activeDownloads -= 1
  }
}
