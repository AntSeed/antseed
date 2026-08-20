# `@antseed/provider-veo`

Beta Google Veo 3.1 video-generation provider for `antseed-video-jobs-v1`, using the Gemini Developer API and an API key.

## Supported presets

- `veo-3.1-generate-preview`
- `veo-3.1-fast-generate-preview`
- text-to-video and one first-frame image
- 4, 6, or 8 seconds; `16:9` or `9:16`; 720p/1080p MP4

Veo through the Gemini Developer API always returns audio. Explicit `seed` and `generate_audio: false` are rejected. Vertex AI projects, regions, service accounts, and IAM are intentionally out of scope.

## Configuration

```bash
export GEMINI_API_KEY=<key>
antseed seller setup
antseed seller start
```

Runtime keys are:

```text
GEMINI_API_KEY
GEMINI_BASE_URL
ANTSEED_ALLOWED_SERVICES
ANTSEED_SERVICE_UNIT_BILLING_MODELS_JSON
ANTSEED_SERVICE_CAPABILITIES_JSON
ANTSEED_VIDEO_UPFRONT_BPS
ANTSEED_MAX_CONCURRENCY
```

The adapter submits `predictLongRunning`, polls the returned Gemini operation, and retrieves output through the authenticated Gemini Files API. It rejects external artifact origins so the Gemini API key cannot be forwarded to an attacker-controlled URL.

Run `antseed seller doctor --video-live` before production use.
