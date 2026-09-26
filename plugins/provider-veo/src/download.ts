import { nativeVideoRoute, requestService } from '@antseed/api-adapter';
import { VIDEO_DOWNLOAD_STREAM_HEADER, VIDEO_DOWNLOAD_STREAM_VERSION, type Provider, type SerializedHttpResponse } from '@antseed/node';
import { streamVideoResponse, videoDownloadError, videoDownloadSignal } from '@antseed/provider-core';

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
    async handleRequest(request) {
      if (nativeVideoRoute(request)?.action !== 'download') return provider.handleRequest(request);
      return videoDownloadError(request, 400, 'unsupported_video_download', 'A streaming video download is required');
    },
    serviceCapabilities: Object.fromEntries(provider.services.map(service => {
      const { videoDownload: _download, ...capabilities } = provider.serviceCapabilities?.[service] ?? {};
      return [service, { ...capabilities, ...(new URL(baseUrl).origin === GOOGLE_ORIGIN ? { videoDownload: VIDEO_DOWNLOAD_STREAM_VERSION } : {}) }];
    })),
    async handleRequestStream(request, callbacks): Promise<SerializedHttpResponse> {
      const route = nativeVideoRoute(request);
      if (route?.action !== 'download') return provider.handleRequestStream ? provider.handleRequestStream(request, callbacks) : provider.handleRequest(request);
      const error = (statusCode: number, code: string, message: string) => videoDownloadError(request, statusCode, code, message);
      if (!provider.services.includes(requestService(request) ?? '')) return error(400, 'unsupported_video_request', 'Unsupported video service');
      if (new URL(baseUrl).origin !== GOOGLE_ORIGIN) return error(400, 'unsupported_video_download', 'Downloads require the direct Gemini endpoint');
      if (request.headers[VIDEO_DOWNLOAD_STREAM_HEADER] !== VIDEO_DOWNLOAD_STREAM_VERSION || !callbacks.signal) return error(400, 'unsupported_video_download', 'A streaming video download is required');
      if (activeDownloads >= 2) return error(429, 'video_download_busy', 'Too many concurrent video downloads');
      activeDownloads += 1;
      const download = videoDownloadSignal(callbacks.signal);
      const { signal } = download;
      let streaming = false;
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
        const file = await fetch(url, {
          headers: { 'x-goog-api-key': apiKey, 'accept-encoding': 'identity' },
          redirect: 'error', signal,
        });
        streaming = true;
        return await streamVideoResponse(request, file, callbacks, download);
      } catch (cause) {
        if (streaming) throw cause;
        return error(signal.aborted ? 504 : 502, 'video_download_failed', 'Could not download video from Gemini');
      } finally {
        download.done();
        activeDownloads -= 1;
      }
    },
  };
}
