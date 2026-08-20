import { afterEach, describe, expect, it, vi } from 'vitest';
import plugin, { RunwayVideoAdapter, RUNWAY_MODEL_PRESETS } from './index.js';

afterEach(() => vi.unstubAllGlobals());

describe('RunwayVideoAdapter', () => {
  it('uses the current Gen-4.5 text-to-video contract', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 'task-1' }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new RunwayVideoAdapter('secret', 'https://api.dev.runwayml.com', ['gen4.5'], 5000);
    await adapter.create({
      model: 'gen4.5', prompt: 'A cinematic sunrise', duration_seconds: 4,
      aspect_ratio: '16:9', resolution: '720p', output_format: 'mp4', seed: 12,
    }, { idempotencyKey: 'idem', generationId: 'vg_1' });

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.pathname).toBe('/v1/text_to_video');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer secret');
    expect(new Headers(init.headers).get('x-runway-version')).toBe('2024-11-06');
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: 'gen4.5', promptText: 'A cinematic sunrise', duration: 4,
      ratio: '1280:720', seed: 12, outputFormat: 'mp4',
    });
  });

  it('does not allow extensions to override canonical request fields', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 'task-1' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new RunwayVideoAdapter('secret', 'https://api.dev.runwayml.com', ['gen4.5'], 5000);
    const request = {
      model: 'gen4.5', prompt: 'canonical prompt', duration_seconds: 4,
      extensions: { runway: { promptText: 'overridden prompt', duration: 10, watermark: false } },
    };
    expect(adapter.validateRequest(request)).toEqual([
      'extensions.runway.promptText cannot override a canonical video field',
      'extensions.runway.duration cannot override a canonical video field',
    ]);
    await adapter.create(request, { idempotencyKey: 'idem', generationId: 'vg_1' });
    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(body).toMatchObject({ promptText: 'canonical prompt', duration: 4, watermark: false });
  });

  it('maps task fixtures and consumes signed outputs seller-side', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'task-1', status: 'SUCCEEDED', progress: 1,
        output: ['https://cdn.runway.example/video.mp4'],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new RunwayVideoAdapter('secret', 'https://api.dev.runwayml.com', ['gen4.5'], 5000);
    const status = await adapter.getStatus('task-1');
    expect(status).toMatchObject({ status: 'succeeded', nativeStatus: 'SUCCEEDED', progress: 100 });
    expect(status.artifacts?.[0]?.locator).toBe('https://cdn.runway.example/video.mp4');
    await adapter.openArtifact(status.artifacts![0]!);
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe('https://cdn.runway.example/video.mp4');
  });

  it('advertises only tested modality-safe presets', () => {
    expect(RUNWAY_MODEL_PRESETS['gen4.5']?.generationModes).toEqual(['text_to_video', 'image_to_video']);
    expect(RUNWAY_MODEL_PRESETS['gen4_turbo']?.generationModes).toEqual(['image_to_video']);
    expect(RUNWAY_MODEL_PRESETS['gen4.5']?.minDurationSeconds).toBe(2);
  });

  it('rejects insecure artifact locators and redacts provider errors', async () => {
    const adapter = new RunwayVideoAdapter('super-secret', 'https://api.dev.runwayml.com', ['gen4.5'], 5000);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      status: 'SUCCEEDED', output: ['http://cdn.runway.example/video.mp4'],
    }), { status: 200 })));
    await expect(adapter.getStatus('task-1')).rejects.toThrow('insecure artifact URL');

    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      error: 'prompt canonical prompt failed; api_key=super-secret; https://signed.example/video?token=abc',
    }), { status: 400 })));
    await expect(adapter.create({
      model: 'gen4.5', prompt: 'canonical prompt', duration_seconds: 4,
    }, { idempotencyKey: 'idem', generationId: 'vg_1' })).rejects.toThrow(
      'prompt [redacted] failed; api_key=[redacted]; [redacted-url]',
    );
  });

  it('maps failed tasks and treats missing cancellation targets as canceled', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'FAILED', failureCode: 'SAFETY', failure: 'Blocked' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new RunwayVideoAdapter('secret', 'https://api.dev.runwayml.com', ['gen4.5'], 5000);
    expect(await adapter.getStatus('task-1')).toMatchObject({
      status: 'failed', error: { code: 'SAFETY', message: 'Blocked', retryable: false },
    });
    expect(await adapter.cancel('task-1')).toEqual({ accepted: true, status: 'canceled' });
  });

  it('requires explicit video billing for every configured model', () => {
    expect(() => plugin.createProvider({ RUNWAY_API_KEY: 'secret', ANTSEED_ALLOWED_SERVICES: 'gen4.5' }))
      .toThrow('ANTSEED_SERVICE_UNIT_BILLING_MODELS_JSON is required');
  });
});
