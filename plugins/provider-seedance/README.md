# @antseed/provider-seedance

Relays native Seedance video requests to a seller-operated API.

## Configuration

Install with `antseed plugin add @antseed/provider-seedance`, then configure:

- `ARK_BASE_URL`: seller API base URL
- `ARK_API_KEY`: seller API credential, sent as a bearer token
- `ANTSEED_ALLOWED_SERVICES`: native model names
- `ANTSEED_SERVICE_UNIT_BILLING_MODELS_JSON`: `seedance-video` pricing using `video_generations` or `video_seconds`

## Buyer API

Send native requests to the local buyer proxy:

```text
POST /api/v3/contents/generations/tasks

{"model":"seedance-2-0","content":[{"type":"text","text":"A cat in a garden"}],"resolution":"720p","duration":5}
```

Poll with `GET /api/v3/contents/generations/tasks/{id}` and cancel queued tasks with `DELETE` on the same path. Per-second pricing needs an explicit positive `duration`; `duration: -1` and `frames` requests need `video_generations` pricing. See [native video integration](../../docs/protocol/spec/10-native-video.md) for billing, routing, ownership, and retry behavior.
