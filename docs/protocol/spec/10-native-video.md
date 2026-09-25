# Native video API integration

AntSeed relays native Runway, Veo, MiniMax, Wan, and Seedance video requests to seller-operated APIs. Sellers own execution, storage, and refund policy. AntSeed does not cache artifacts.

Direct Gemini Veo downloads are relayed through the original seller; its API key never leaves the seller. Other providers and seller-hosted result URLs remain unchanged and must be accessible to buyers without seller credentials.

## Supported requests

| Protocol | Method | Native path |
| --- | --- | --- |
| `runway-video` | POST | `/v1/text_to_video`, `/v1/image_to_video` |
| `runway-video` | GET, DELETE | `/v1/tasks/{id}` |
| `veo-video` | POST | `/v1beta/models/{model}:predictLongRunning` |
| `veo-video` | GET | `/v1beta/{operation-name}` |
| `veo-video` | GET | `/v1beta/{operation-name}/videos/{index}:download` (AntSeed endpoint) |
| `minimax-video` | POST | `/v2/video_generation` |
| `minimax-video` | GET | `/v2/query/video_generation/{task_id}` |
| `minimax-video` | DELETE | `/v2/video_generation/{task_id}` |
| `wan-video` | POST | `/api/v1/services/aigc/video-generation/video-synthesis` |
| `wan-video` | GET | `/api/v1/tasks/{task_id}` |
| `seedance-video` | POST | `/api/v3/contents/generations/tasks` |
| `seedance-video` | GET, DELETE | `/api/v3/contents/generations/tasks/{id}` |

Veo uses the path model as the service; every other API uses the body `model`. Each API's paths, job ID field, and billing fields are declared in one table in `packages/api-adapter/src/native-video.ts`. Service names must equal seller model names. Request bodies are forwarded byte-for-byte, and chat aliases, pins, and model rewrites are not applied. Video services appear in `GET /v1/models?type=videos`.

## Billing

A create is charged when the seller returns an accepted job ID: Runway and Seedance `id`, Veo `name`, MiniMax `task_id`, or Wan `output.task_id`. Polling and cancellation are free. Pricing uses `video_generations` or `video_seconds`; per-second pricing requires an explicit positive duration (`duration`, Veo `parameters.durationSeconds`, Wan `parameters.duration`). Runway `auto`, Seedance `-1`, and Seedance `frames` requests have no explicit duration, so they need `video_generations` pricing. Veo reads `numberOfVideos` or `sampleCount`; every other API bills one video per create.

## Routing and ownership

### Veo downloads

For completed Veo operations, the buyer proxy replaces Google file URLs with local download URLs containing the operation name and zero-based result index. Fetch the returned URI directly; no Google API key is needed on the buyer. The Google JavaScript SDK's `files.download()` reconstructs a Google Files API path instead of fetching local HTTP URIs, so use `fetch(video.uri)` for this step rather than that helper.

The seller checks the existing operation ownership for every download request, fetches the operation status from Gemini, and resolves the file URL itself. Arbitrary buyer-supplied URLs, other Google endpoints, embedded credentials, and redirects are rejected. No new ownership table or file cache is needed. Both buyer and seller must support the download endpoint.

The local HTTP response is streamed using sequential 64 KiB byte-range requests over the existing P2P request/response protocol. Each range retains the normal response-authentication path and stays below TCP and WebRTC frame limits. The buyer waits for the local client to drain before requesting more data. Downloads are limited to 64 MiB, two concurrent downloads per buyer process, two concurrent range fetches per Veo provider, 15 seconds per upstream range operation, and five minutes overall. Closing the local connection stops subsequent range requests; an already-dispatched seller range may finish within its 15-second deadline. Interrupted downloads close the response rather than adding JSON or SSE to the video bytes. Browser seeking and resumable client ranges are not supported yet.

Downloads and repeated downloads are free; they do not create a new job or change acceptance-based billing. Expired or missing files, unfinished jobs, and upstream failures return errors instead of switching sellers or generating another video. Retaining a job route does not extend Gemini's file retention.

The buyer proxy stores accepted job routes in `buyer.state.json` for 30 days, so status and cancel requests go back to the same seller, provider, and service. Unknown jobs return `404`.

The seller node stores `(protocol, job ID) -> buyer peer ID` in `resources.db`. Status and cancel requests from another buyer return `404` before reaching the seller API. Video requests are refused if this storage is unavailable.

## Duplicate charge protection

The buyer proxy sends an `x-antseed-idempotency-key` on every create. A client-supplied `x-antseed-idempotency-key` or `Idempotency-Key` is reused; otherwise the proxy generates one and returns it in the response. The seller stores accepted responses by buyer, protocol, and key. Resending the same key returns the stored acceptance with no new job or charge. If the same key is still being processed, the seller returns `409 idempotency_in_progress`.

The proxy does not retry creates automatically. After an uncertain failure, clients should retry with the returned or supplied key.
