import { describe, expect, it } from 'vitest';
import { validateVideoGenerationRequest, type VideoCapabilities } from './video.js';

const capabilities: VideoCapabilities = {
  generationModes: ['text_to_video', 'image_to_video'],
  minDurationSeconds: 4,
  maxDurationSeconds: 8,
  allowedDurationsSeconds: [4, 6, 8],
  resolutions: ['720p', '1080p'],
  aspectRatios: ['16:9', '9:16'],
  generateAudio: true,
  outputFormats: ['mp4'],
  maxFirstFrameBytes: 1_000_000,
};

describe('validateVideoGenerationRequest', () => {
  it('accepts portable text and first-frame requests', () => {
    expect(validateVideoGenerationRequest({
      model: 'veo-3.1-generate-preview',
      prompt: 'Sunrise over a mountain observatory',
      duration_seconds: 8,
      aspect_ratio: '16:9',
      resolution: '1080p',
      generate_audio: true,
      output_format: 'mp4',
      metadata: { project: 'launch' },
      extensions: { veo: { negativePrompt: 'rain' } },
    }, { capabilities })).toEqual([]);

    expect(validateVideoGenerationRequest({
      model: 'veo-3.1-generate-preview',
      prompt: 'Animate the supplied frame',
      input_assets: [{ type: 'image', role: 'first_frame', asset_id: 'asset_123' }],
      duration_seconds: 6,
    }, { capabilities })).toEqual([]);
  });

  it('rejects unknown fields, invalid metadata, and extension namespaces', () => {
    const errors = validateVideoGenerationRequest({
      model: 'model',
      prompt: 'prompt',
      duration_seconds: 4,
      remote_url: 'https://example.com/image.png',
      metadata: { invalid: 1 },
      extensions: { other: {} },
    }, { capabilities });
    expect(errors).toContain('unknown parameter "remote_url"');
    expect(errors).toContain('metadata keys and string values exceed the supported limits');
    expect(errors).toContain('unsupported extension namespace "other"');
  });

  it('enforces generation modes and model capabilities', () => {
    const imageOnly = { ...capabilities, generationModes: ['image_to_video'] as const };
    expect(validateVideoGenerationRequest({ model: 'model', prompt: 'prompt', duration_seconds: 4 }, { capabilities: imageOnly }))
      .toContain('text_to_video is not supported by this model');
    expect(validateVideoGenerationRequest({ model: 'model', prompt: 'prompt', duration_seconds: 5 }, { capabilities }))
      .toContain('duration_seconds is not supported by this model');
    expect(validateVideoGenerationRequest({ model: 'model', prompt: 'prompt', duration_seconds: 4, resolution: '4k' }, { capabilities }))
      .toContain('resolution is not supported by this model');
  });
});
