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
2. The buyer verifies the signature, request hash, advertised price, `payment_trigger: "upstream_accepted"`, expiry, and local caps.
3. Normal AntSeed payment negotiation supplies a SpendingAuth covering the full quote and retries the exact body with the same idempotency key.
4. The seller persists the pending authorization, submits upstream once, records the full execution charge only after receiving an upstream job ID, and returns `202 Accepted`.

Concurrent or repeated requests with the same buyer, idempotency key, and body resolve to one generation. Reusing the key with another body returns `409`.

Creation responses include `Location` and `Retry-After`. Follow-up resources are pinned to the original seller; they never fail over to another peer.

## Status and cancellation

```text
GET  /v1/video/generations/{generation_id}
GET  /v1/video/generations?limit=100
POST /v1/video/generations/{generation_id}/cancel
```

Public states are `queued`, `in_progress`, `succeeded`, `failed`, `canceled`, and `expired`. Internal submission, artifact-fetch, cancellation, and reconciliation states are not exposed.

Cancellation is best effort. Cancellation before upstream submission costs nothing. A provider rejection before returning a job ID costs nothing. Failure after upstream acceptance leaves the full execution charge payable. Cancellation after completion does not erase an earned execution charge.

Seller and buyer state is durable. Sellers recover accepted work using SQLite worker leases and provider polling. A crash during an uncertain create response is marked `reconciliation_required` and is never blindly resubmitted. Buyers persist generation-to-seller route affinity in `buyer.state.json` until expiry.

## Artifacts

Successful resources include AntSeed artifact IDs, MIME type, byte length, SHA-256, expiry, content link, and available media metadata. Provider URLs are never returned.

```text
HEAD /v1/video/generations/{generation_id}/artifacts/{artifact_id}/content
GET  /v1/video/generations/{generation_id}/artifacts/{artifact_id}/content
```

The content endpoint supports `Range`, `206 Partial Content`, `Content-Range`, `Accept-Ranges: bytes`, an SHA-256 response header, and bounded-memory streaming. Sellers hash provider bytes while writing a temporary file and atomically rename only a complete artifact. The default retention is 24 hours; the default single-artifact limit is 2 GiB.

After download, the buyer verifies byte length and SHA-256 and atomically renames the output file. There is no delivery receipt endpoint or additional payment for status, cancellation, or download.

The resource's `payment` object contains `currency`, `total_amount`, `trigger: "upstream_accepted"`, and `status` (`pending`, `authorized`, or `earned`). Payment state is independent of generation success: an accepted attempt can fail while its execution charge remains earned.

## Payment risk model

Each generation has one fixed-price execution charge. The buyer authorizes 100% before submission; the seller records the charge as earned once the upstream provider returns a job ID. This purchases an accepted generation attempt, not guaranteed delivery or subjective quality. A definitive rejection before acceptance does not earn a charge. An uncertain submission remains pending reconciliation and is never blindly retried.

The buyer bears the full quoted-price risk if an accepted job fails, the seller disappears, or the artifact cannot be delivered. Recovery requires a seller-operated refund; v1 has no automatic refunds or subjective-quality disputes. The seller bears upstream costs above its quote and costs it voluntarily refunds.

Authorization is not escrow: the application-level acceptance rule does not cryptographically prevent a malicious seller from using a valid SpendingAuth early. Signed quotes and audit records provide evidence, not guaranteed delivery. Buyer total-price and duration caps remain enforced.

## Upgrading from the split-payment draft

The previous draft's split quotes and delivery receipts are incompatible with this single-charge flow. Upgrade buyers and sellers together. Remove `buyer.video.maxUpfrontBps`, seller `videoPayment`, and `ANTSEED_VIDEO_UPFRONT_BPS` only after accepting the new full-price policy; these obsolete settings fail explicitly rather than silently increasing buyer exposure. The `--max-upfront-percent` option is removed.

Unsubmitted split-payment intents cannot be reused; cancel them and request a new quote. Finish or reconcile previously accepted split-payment jobs before upgrading: the new flow does not collect their former delivery balance. Existing SQLite migrations and historical payment evidence are retained; the legacy delivery column is no longer used by the runtime.

## Security requirements

- Enforce buyer ownership on generation, cancellation, artifact, and receipt routes.
- Reject remote input URLs and path traversal.
- Reject extensions that override canonical provider fields.
- Permit HTTPS artifact locators; permit HTTP only on the configured same-origin development endpoint.
- Never forward Gemini API keys to a provider-supplied external origin.
- Redact prompts, credentials, and signed URLs from provider error text and logs.
- Bound input size, active jobs, provider concurrency, artifact size, disk usage, queues, and stream buffers.

## Operations

`antseed seller doctor` reports configured video pricing/capabilities, API-key presence, disk capacity, orphaned upstream state, pending execution authorization evidence, and jobs requiring reconciliation. `antseed seller doctor --video-live` performs provider-access checks that may use live credentials.

Operators must investigate `reconciliation_required` jobs against the upstream dashboard before taking manual action. Do not resubmit an uncertain create automatically: it may duplicate a billable generation.
