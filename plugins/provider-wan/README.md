# @antseed/provider-wan

Relays native Wan video requests to a seller-operated API.

## Configuration

Install with `antseed plugin add @antseed/provider-wan`, then configure:

- `DASHSCOPE_BASE_URL`: seller API base URL
- `DASHSCOPE_API_KEY`: seller API credential, sent as a bearer token
- `ANTSEED_ALLOWED_SERVICES`: native model names
- `ANTSEED_SERVICE_UNIT_BILLING_MODELS_JSON`: `wan-video` pricing using `video_generations` or `video_seconds`

## Buyer API

Send native requests to the local buyer proxy:

```text
POST /api/v1/services/aigc/video-generation/video-synthesis

{"model":"wan2.7-t2v","input":{"prompt":"A cat in a garden"},"parameters":{"resolution":"720P","duration":5}}
```

Poll with `GET /api/v1/tasks/{task_id}`. The seller relay adds `X-DashScope-Async: enable`. See [native video integration](../../docs/protocol/spec/10-native-video.md) for billing, routing, ownership, and retry behavior.
