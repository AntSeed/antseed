# @antseed/provider-veo

Relays native Veo video requests to a seller-operated API.

## Configuration

Install with `antseed plugin add @antseed/provider-veo`, then configure:

- `GEMINI_BASE_URL`: seller API base URL
- `GEMINI_API_KEY`: seller API credential
- `ANTSEED_ALLOWED_SERVICES`: native model names
- `ANTSEED_SERVICE_UNIT_BILLING_MODELS_JSON`: `veo-video` pricing using `video_generations` or `video_seconds`

## Buyer API

Send native requests to the local buyer proxy:

```text
POST /v1beta/models/veo-3.1-generate-preview:predictLongRunning

{"instances":[{"prompt":"A cat in a garden"}],"parameters":{"durationSeconds":8}}
```

Poll with `GET /v1beta/{operation-name}`. See [native video integration](../../docs/protocol/spec/10-native-video.md) for billing, routing, ownership, and retry behavior.
