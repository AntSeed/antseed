# @antseed/provider-runway

Relays native Runway video requests to a seller-operated API.

## Configuration

Install with `antseed plugin add @antseed/provider-runway`, then configure:

- `RUNWAY_BASE_URL`: seller API base URL
- `RUNWAY_API_KEY`: seller API credential
- `ANTSEED_ALLOWED_SERVICES`: native model names
- `ANTSEED_SERVICE_UNIT_BILLING_MODELS_JSON`: `runway-video` pricing using `video_generations` or `video_seconds`

## Buyer API

Send native requests to the local buyer proxy:

```text
POST /v1/text_to_video

{"model":"gen4.5","promptText":"A cat in a garden","duration":8}
```

Poll with `GET /v1/tasks/{id}`. See [native video integration](../../docs/protocol/spec/10-native-video.md) for billing, routing, ownership, and retry behavior.
