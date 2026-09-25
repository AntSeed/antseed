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

## Result delivery

With `GEMINI_BASE_URL=https://generativelanguage.googleapis.com`, the plugin advertises `videoDownload: "veo-stream-v1"` for its services. Updated buyers only rewrite completed Google video URLs when that capability is present; older sellers and custom base-URL origins keep their original URLs. Each local download checks ownership once, looks up the operation once, and streams one Google file fetch using the seller's private key. Downloads are free and limited to 64 MiB, two concurrent transfers, and five minutes. The upstream must provide a valid `Content-Length`; missing lengths and truncated/oversized files fail safely. Client disconnects cancel seller-side fetching. No public download server, cloud storage, or extra database is required.

Fetch the returned `video.uri` directly, including when using the Gemini SDK for generation and polling. The Google JavaScript SDK's `files.download()` rebuilds a Google Files API path and does not handle these local HTTP URLs.

```typescript
const response = await fetch(video.uri);
if (!response.ok) throw new Error(`Video download failed: ${response.status}`);
```

Seller-operated APIs that return their own hosted result URLs continue to work unchanged; those URLs must be accessible without seller credentials. Never share the seller's API key with buyers. See the protocol guide for timeouts, concurrency limits, and cancellation behavior.
