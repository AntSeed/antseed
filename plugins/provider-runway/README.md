# `@antseed/provider-runway`

Beta Runway video-generation provider for `antseed-video-jobs-v1`.

## Supported presets

- `gen4.5`: text-to-video and first-frame image-to-video, 2–10 seconds, `16:9` or `9:16`, 720p MP4
- `gen4_turbo`: first-frame image-to-video, 2–10 seconds, tested Runway ratios, 720p MP4

Only explicit tested presets are advertised. Unknown Runway model IDs are rejected.

## Configuration

```bash
export RUNWAY_API_KEY=<key>
antseed seller setup
antseed seller start
```

The setup wizard writes services, capabilities, fixed/per-second pricing, and the upfront payment split to `config.json`. Runtime keys are:

```text
RUNWAY_API_KEY
RUNWAY_BASE_URL
ANTSEED_ALLOWED_SERVICES
ANTSEED_SERVICE_UNIT_BILLING_MODELS_JSON
ANTSEED_SERVICE_CAPABILITIES_JSON
ANTSEED_VIDEO_UPFRONT_BPS
ANTSEED_MAX_CONCURRENCY
```

Run `antseed seller doctor --video-live` to validate credentials, model access, task polling, artifact access, disk capacity, and durable-job state.

The adapter never returns Runway's signed output URL to a buyer. The seller downloads it into the bounded AntSeed artifact cache, hashes it, and serves it through the canonical content endpoint.
