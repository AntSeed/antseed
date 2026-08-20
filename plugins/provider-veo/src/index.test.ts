import { afterEach, describe, expect, it, vi } from 'vitest';
import { VeoVideoAdapter } from './index.js';

afterEach(() => vi.unstubAllGlobals());

describe('VeoVideoAdapter', () => {
  it('uses Gemini Developer predictLongRunning request shapes', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ name: 'models/veo/operations/op-1' }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new VeoVideoAdapter('secret', 'https://generativelanguage.googleapis.com', ['veo-3.1-generate-preview'], 5000);
    await adapter.create({
      model: 'veo-3.1-generate-preview', prompt: 'A cinematic sunrise', duration_seconds: 8,
      aspect_ratio: '16:9', resolution: '1080p', generate_audio: true,
    }, {
      idempotencyKey: 'idem', generationId: 'vg_1', firstFrame: new Uint8Array([1, 2]), firstFrameMimeType: 'image/png',
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new URL(url).pathname).toBe('/v1beta/models/veo-3.1-generate-preview:predictLongRunning');
    const body = JSON.parse(String(init.body));
    expect(body).toEqual({
      instances: [{ prompt: 'A cinematic sunrise', image: { bytesBase64Encoded: 'AQI=', mimeType: 'image/png' } }],
      parameters: { durationSeconds: 8, aspectRatio: '16:9', resolution: '1080p' },
    });
  });

  it('rejects Gemini Developer parameters that are not controllable', () => {
    const adapter = new VeoVideoAdapter('secret', 'https://generativelanguage.googleapis.com', ['veo-3.1-generate-preview'], 5000);
    expect(adapter.validateRequest({ model: 'veo-3.1-generate-preview', prompt: 'test', duration_seconds: 8, seed: 1 }))
      .toContain('seed is not supported by Veo through the Gemini Developer API');
    expect(adapter.validateRequest({ model: 'veo-3.1-generate-preview', prompt: 'test', duration_seconds: 8, generate_audio: false }))
      .toContain('Veo 3.1 always returns video with audio through the Gemini Developer API');
    expect(adapter.validateRequest({
      model: 'veo-3.1-generate-preview', prompt: 'test', duration_seconds: 8,
      extensions: { veo: { durationSeconds: 4 } },
    })).toContain('extensions.veo.durationSeconds cannot override a canonical video field');
  });

  it('polls the v1beta operation and discovers generated samples', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      done: true,
      response: {
        generateVideoResponse: {
          generatedSamples: [{ video: { uri: 'files/video-1', encoding: 'video/mp4' } }],
        },
      },
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new VeoVideoAdapter('secret', 'https://generativelanguage.googleapis.com', ['veo-3.1-generate-preview'], 5000);
    const status = await adapter.getStatus('models/veo-3.1-generate-preview/operations/op-1');
    expect(new URL(String(fetchMock.mock.calls[0]?.[0])).pathname).toBe('/v1beta/models/veo-3.1-generate-preview/operations/op-1');
    expect(status).toMatchObject({ status: 'succeeded', progress: 100 });
    expect(status.artifacts?.[0]).toMatchObject({ locator: 'files/video-1', mimeType: 'video/mp4', hasAudio: true });
  });

  it('downloads generated files through the authenticated Files endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new VeoVideoAdapter('secret', 'https://generativelanguage.googleapis.com', ['veo-3.1-generate-preview'], 5000);
    await adapter.openArtifact({ locator: 'files/video-1', mimeType: 'video/mp4' });
    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.pathname).toBe('/v1beta/files/video-1:download');
    expect(url.searchParams.get('alt')).toBe('media');
    expect(url.searchParams.get('key')).toBe('secret');
  });

  it('never sends the API key to an external artifact origin', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(new Uint8Array([1]), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new VeoVideoAdapter('secret', 'https://generativelanguage.googleapis.com', ['veo-3.1-generate-preview'], 5000);
    await expect(adapter.openArtifact({
      locator: 'https://attacker.example/video.mp4', mimeType: 'video/mp4',
    })).rejects.toThrow('unexpected origin');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('redacts prompts, keys, and signed URLs from API errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: {
      message: 'prompt private prompt failed token=secret https://signed.example/video?key=secret',
    } }), { status: 400 })));
    const adapter = new VeoVideoAdapter('secret', 'https://generativelanguage.googleapis.com', ['veo-3.1-generate-preview'], 5000);
    await expect(adapter.create({
      model: 'veo-3.1-generate-preview', prompt: 'private prompt', duration_seconds: 8,
    }, { idempotencyKey: 'idem', generationId: 'vg_1' })).rejects.toThrow(
      'prompt [redacted] failed token=[redacted] [redacted-url]',
    );
  });

  it('maps operation errors and missing cancellation targets', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        done: true, error: { status: 'INVALID_ARGUMENT', message: 'Rejected' },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new VeoVideoAdapter('secret', 'https://generativelanguage.googleapis.com', ['veo-3.1-generate-preview'], 5000);
    expect(await adapter.getStatus('models/veo/operations/op-1')).toMatchObject({
      status: 'failed', error: { code: 'INVALID_ARGUMENT', message: 'Rejected', retryable: false },
    });
    expect(await adapter.cancel('models/veo/operations/op-1')).toEqual({ accepted: true, status: 'canceled' });
  });
});
