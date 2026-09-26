# @antseed/provider-venice

Relays native Venice video requests to the Venice API.

## Configuration

Install with `antseed plugin add @antseed/provider-venice`, then configure:

- `VENICE_API_KEY`: Venice API key, sent as a bearer token
- `VENICE_BASE_URL`: optional, defaults to `https://api.venice.ai`
- `ANTSEED_ALLOWED_SERVICES`: Venice video model names, for example `wan-2.5-preview-text-to-video`
- `ANTSEED_SERVICE_UNIT_BILLING_MODELS_JSON`: `venice-video` pricing using `video_generations` or `video_seconds`

Check that Venice's terms allow your offering. AntSeed sellers must add value rather than resell raw API access.

## Buyer API

Send native Venice requests to the local buyer proxy:

```text
POST /api/v1/video/queue
{"model":"wan-2.5-preview-text-to-video","prompt":"A cat in a garden","duration":"5s","resolution":"720p"}

POST /api/v1/video/retrieve
{"model":"wan-2.5-preview-text-to-video","queue_id":"<queue_id>"}
```

The queue call is charged once when Venice returns a `queue_id`. Retrieve is free: it returns Venice's JSON status while the job runs, then streams the finished MP4 from the same seller. Private models return JSON `COMPLETED` and deliver the file through the `download_url` from the queue response. `POST /api/v1/video/complete` deletes the stored media. Chat and image models on Venice continue to use `@antseed/provider-openai`.

See [native video integration](../../docs/protocol/spec/10-native-video.md) for billing, routing, ownership, and retry behavior.
