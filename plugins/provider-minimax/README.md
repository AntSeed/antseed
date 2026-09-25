# @antseed/provider-minimax

Relays native MiniMax video requests to a seller-operated API.

## Configuration

Install with `antseed plugin add @antseed/provider-minimax`, then configure:

- `MINIMAX_BASE_URL`: seller API base URL
- `MINIMAX_API_KEY`: seller API credential, sent as a bearer token
- `ANTSEED_ALLOWED_SERVICES`: native model names
- `ANTSEED_SERVICE_UNIT_BILLING_MODELS_JSON`: `minimax-video` pricing using `video_generations` or `video_seconds`

## Buyer API

Send native requests to the local buyer proxy:

```text
POST /v2/video_generation

{"model":"MiniMax-H3","content":[{"type":"text","text":"A cat in a garden"}],"resolution":"768P","duration":5}
```

Poll with `GET /v2/query/video_generation/{task_id}` and cancel queued tasks with `DELETE /v2/video_generation/{task_id}`. See [native video integration](../../docs/protocol/spec/10-native-video.md) for billing, routing, ownership, and retry behavior.
