# Video Jobs (`antseed-video-jobs-v1`)

## Scope

`antseed-video-jobs-v1` is AntSeed's durable asynchronous protocol for video generation. The first release supports Runway Gen-4-family presets and Google Veo 3.1 through the Gemini Developer API, using text-to-video or one uploaded first-frame image.

The canonical HTTP resource is `/v1/video/generations`. `/v1/videos`, remote input URLs, Vertex AI, video-to-video, last-frame conditioning, reference videos, refunds, and subjective-quality disputes are not part of v1.

## Discovery and pricing

A video service advertises `antseed-video-jobs-v1`, `outputs: ["video"]`, and a `video` capability object containing:

- `generationModes`: `text_to_video` and/or `image_to_video`
- minimum, maximum, and optionally enumerated durations
- resolutions and aspect ratios
- generated-audio support
- output formats
- maximum first-frame bytes
- `upfrontBps`, the execution milestone share

Pricing uses `output_videos` and/or `output_video_seconds`. Components may match `model`, `resolution`, `aspect_ratio`, `audio`, and `output_format`. The quote is fixed from the requested duration and options; successful completion never silently raises it.

Peers that predate discovery metadata v13 remain readable, but they do not qualify for capability-aware video routing.

## Input assets

Remote URLs are forbidden. Upload an image to the selected seller first:

```http
POST /v1/video/assets
Content-Type: image/png
X-Antseed-Model: gen4.5

<binary image bytes>
```

The response contains an opaque `asset_*` ID, size, hash, and expiry. Asset ownership is scoped to the buyer peer. Creation accepts at most one `input_assets` entry with `type: "image"` and `role: "first_frame"`.

## Create and quote flow

```http
POST /v1/video/generations
Content-Type: application/json
Idempotency-Key: <unguessable stable key>
X-Antseed-Provider: runway
```

```json
{
  "model": "gen4.5",
  "prompt": "A cinematic sunrise above an alpine observatory",
  "duration_seconds": 8,
  "aspect_ratio": "16:9",
  "resolution": "720p",
  "output_format": "mp4",
  "metadata": {}
}
```

`model`, `prompt`, and `Idempotency-Key` are required. Unknown fields, unsupported options, multiple first frames, and provider-incompatible extensions return a structured `422`.

Paid creation deliberately takes two HTTP attempts:

1. The seller persists a local intent and returns `402` with a signed `video_quote`.
2. The buyer verifies the signature, request hash, advertised price, split, expiry, and local caps.
3. Normal AntSeed payment negotiation supplies an execution SpendingAuth and retries the exact body with the same idempotency key.
4. The seller persists the pending authorization, submits upstream once, records the execution milestone only after receiving an upstream job ID, and returns `202 Accepted`.

Concurrent or repeated requests with the same buyer, idempotency key, and body resolve to one generation. Reusing the key with another body returns `409`.

Creation responses include `Location` and `Retry-After`. Follow-up resources are pinned to the original seller; they never fail over to another peer.

## Status and cancellation

```text
GET  /v1/video/generations/{generation_id}
GET  /v1/video/generations?limit=100
POST /v1/video/generations/{generation_id}/cancel
```

Public states are `queued`, `in_progress`, `succeeded`, `failed`, `canceled`, and `expired`. Internal submission, artifact-fetch, cancellation, and reconciliation states are not exposed.

Cancellation is best effort. Cancellation before upstream submission costs nothing. A provider rejection before returning a job ID costs nothing. Failure after upstream acceptance leaves the execution milestone payable. Cancellation after completion does not erase an earned milestone.

Seller and buyer state is durable. Sellers recover accepted work using SQLite worker leases and provider polling. A crash during an uncertain create response is marked `reconciliation_required` and is never blindly resubmitted. Buyers persist generation-to-seller route affinity in `buyer.state.json` until expiry.

## Artifacts

Successful resources include AntSeed artifact IDs, MIME type, byte length, SHA-256, expiry, content link, and available media metadata. Provider URLs are never returned.

```text
HEAD /v1/video/generations/{generation_id}/artifacts/{artifact_id}/content
GET  /v1/video/generations/{generation_id}/artifacts/{artifact_id}/content
```

The content endpoint supports `Range`, `206 Partial Content`, `Content-Range`, `Accept-Ranges: bytes`, an SHA-256 response header, and bounded-memory streaming. Sellers hash provider bytes while writing a temporary file and atomically rename only a complete artifact. The default retention is 24 hours; the default single-artifact limit is 2 GiB.

After download, the buyer verifies byte length and SHA-256, then submits:

```text
POST /v1/video/generations/{generation_id}/artifacts/{artifact_id}/receipt
```

The buyer proxy signs `DeliveryReceiptV1` over the generation ID, artifact ID, hash, byte count, timestamp, and buyer peer ID. The seller requests the final cumulative SpendingAuth when needed and records the delivery milestone exactly once.

## Payment risk model

The default split is 50% at upstream acceptance and 50% after verified plaintext delivery. Sellers may configure any `upfrontBps` from 0 through 10000; buyers can reject high splits and high totals automatically.

This is risk splitting, not trustless escrow:

- a malicious seller that receives a valid pending authorization may try to misuse it;
- a malicious buyer may receive plaintext and withhold the signed receipt;
- creative dissatisfaction is not a delivery failure;
- v1 has no automatic refund or subjective dispute mechanism.

Signed quotes, delivery receipts, provider/job audit events, channel records, and reputation provide evidence and reduce exposure. Contract-enforced milestones and encrypted artifact key release are future work.

## Security requirements

- Enforce buyer ownership on generation, cancellation, artifact, and receipt routes.
- Reject remote input URLs and path traversal.
- Reject extensions that override canonical provider fields.
- Permit HTTPS artifact locators; permit HTTP only on the configured same-origin development endpoint.
- Never forward Gemini API keys to a provider-supplied external origin.
- Redact prompts, credentials, and signed URLs from provider error text and logs.
- Bound input size, active jobs, provider concurrency, artifact size, disk usage, queues, and stream buffers.

## Operations

`antseed seller doctor` reports configured video pricing/capabilities, API-key presence, disk capacity, orphaned upstream state, pending milestone evidence, and jobs requiring reconciliation. `antseed seller doctor --video-live` performs provider-access checks that may use live credentials.

Operators must investigate `reconciliation_required` jobs against the upstream dashboard before taking manual action. Do not resubmit an uncertain create automatically: it may duplicate a billable generation.
