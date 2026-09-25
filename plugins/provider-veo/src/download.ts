import { nativeVideoRoute, requestService, videoContentRange, VIDEO_DOWNLOAD_CHUNK_BYTES } from '@antseed/api-adapter';
import type { Provider, SerializedHttpResponse } from '@antseed/node';

const GOOGLE_ORIGIN = 'https://generativelanguage.googleapis.com';

async function readBounded(response: Response, limit: number): Promise<Uint8Array> {
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel();
    throw new Error('Response exceeds video download limit');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Empty upstream response');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw new Error('Response exceeds video download limit');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

export function withVeoDownloads(provider: Provider, baseUrl: string, apiKey: string): Provider {
  let activeDownloads = 0;
  return {
    ...provider,
    async handleRequest(request): Promise<SerializedHttpResponse> {
      const route = nativeVideoRoute(request);
      if (route?.action !== 'download') return provider.handleRequest(request);
      const error = (statusCode: number, code: string, message: string): SerializedHttpResponse => ({
        requestId: request.requestId, statusCode, headers: { 'content-type': 'application/json' },
        body: Buffer.from(JSON.stringify({ error: { code, message } })),
      });
      if (!provider.services.includes(requestService(request) ?? '')) return error(400, 'unsupported_video_request', 'Unsupported video service');
      if (new URL(baseUrl).origin !== GOOGLE_ORIGIN) return error(400, 'unsupported_video_download', 'Downloads require the direct Gemini endpoint');
      const rangeHeader = Object.entries(request.headers).find(([key]) => key.toLowerCase() === 'range')?.[1];
      const range = /^bytes=([0-9]+)-([0-9]+)$/.exec(rangeHeader ?? '');
      const start = Number(range?.[1]);
      const end = Number(range?.[2]);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end - start >= VIDEO_DOWNLOAD_CHUNK_BYTES) {
        return error(400, 'invalid_video_range', 'A bounded video byte range is required');
      }
      if (activeDownloads >= 2) return error(429, 'video_download_busy', 'Too many concurrent video downloads');
      activeDownloads += 1;
      const signal = AbortSignal.timeout(15_000);
      try {
        const status = await fetch(`${GOOGLE_ORIGIN}/v1beta/${route.resourceId}`, {
          headers: { 'x-goog-api-key': apiKey }, redirect: 'error', signal,
        });
        if (!status.ok) {
          await status.body?.cancel();
          return error(status.status === 404 ? 404 : 502, 'video_status_unavailable', 'Video status is unavailable');
        }
        const operation = JSON.parse(Buffer.from(await readBounded(status, 1024 * 1024)).toString());
        if (operation.error) return error(409, 'video_failed', 'Video generation failed');
        if (operation.done !== true) return error(409, 'video_not_ready', 'Video is not ready');
        const uri = operation.response?.generateVideoResponse?.generatedSamples?.[route.resultIndex!]?.video?.uri;
        if (typeof uri !== 'string') return error(404, 'video_result_not_found', 'Video result not found');
        const url = new URL(uri);
        if (url.origin !== GOOGLE_ORIGIN || url.username || url.password || url.hash
          || !/^\/v1beta\/files\/[A-Za-z0-9_-]+:download$/.test(url.pathname)
          || [...url.searchParams].some(([key, value]) => key !== 'alt' || value !== 'media')) {
          return error(502, 'unsafe_video_url', 'Upstream returned an unsupported video URL');
        }
        const download = await fetch(url, {
          headers: { 'x-goog-api-key': apiKey, range: `bytes=${start}-${end}`, 'accept-encoding': 'identity' },
          redirect: 'error', signal,
        });
        const contentRange = download.headers.get('content-range') ?? undefined;
        const parsed = videoContentRange(contentRange);
        if (download.status !== 206 || !parsed || parsed.start !== start || parsed.end !== Math.min(end, parsed.total - 1)
          || download.headers.get('content-type')?.split(';')[0] !== 'video/mp4'
          || ![null, 'identity'].includes(download.headers.get('content-encoding'))) {
          await download.body?.cancel();
          return error([404, 410, 416].includes(download.status) ? download.status : 502, 'video_download_unavailable', 'Video is unavailable or exceeds download limits');
        }
        const body = await readBounded(download, VIDEO_DOWNLOAD_CHUNK_BYTES);
        if (body.length !== parsed.end - parsed.start + 1) return error(502, 'video_download_truncated', 'Incomplete video range');
        return { requestId: request.requestId, statusCode: 206, headers: {
          'content-type': 'video/mp4', 'content-range': contentRange!, 'content-length': String(body.length),
          'cache-control': 'no-store', 'x-antseed-video-file': url.pathname.split('/').at(-1)!.replace(':download', ''),
        }, body };
      } catch {
        return error(signal.aborted ? 504 : 502, 'video_download_failed', 'Could not download video from Gemini');
      } finally {
        activeDownloads -= 1;
      }
    },
  };
}
