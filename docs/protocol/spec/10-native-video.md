# Native video API integration

AntSeed relays requests to seller-operated services implementing either the Runway or Veo API contract. It does not run a video job service. Sellers must provide their own value-added service and enforce buyer isolation, execution, storage, result delivery, and refund policy. Raw credential resale is not the product.

## Supported requests

| Protocol | Method | Native path |
| --- | --- | --- |
| `runway-video` | POST | `/v1/text_to_video` |
| `runway-video` | POST | `/v1/image_to_video` |
| `runway-video` | GET, DELETE | `/v1/tasks/{id}` |
| `veo-video` | POST | `/v1beta/models/{model}:predictLongRunning` |
| `veo-video` | GET | `/v1beta/{operation-name}` |

Veo operation names have the form `operations/{id}` or `models/{model}/operations/{id}`. Bodies, task IDs, operation names, and native status values are preserved. Other account, Files, upload, and cancellation APIs are not exposed. No conversion to chat or between the two video APIs occurs.

Runway selects the service from the request body `model`; Veo selects it from the model path. Advertised service names must match the seller API's model identifiers; model aliases are not supported in this release. Services advertise `outputs: ["video"]` and appear in `/v1/models?type=videos`. Health checks do not submit paid video generations.

Native request bodies are forwarded byte-for-byte, including whitespace and extension fields such as `service`. Chat aliases, peer-prefixed model syntax, and global chat model pins do not rewrite video payloads. The video wrapper validates exact service names; both plugins enable the relay's optional `preserveRequestBody` setting and bypass its chat-style body validation. The setting defaults to `false` for other providers. Authentication replacement, header filtering, timeouts, and concurrency limits still apply.

## Seller endpoint obligations

Both plugins require an explicit seller API base URL and endpoint credential. Runway uses bearer authentication; Veo uses `x-goog-api-key`. These are credentials for the seller-operated endpoint, not buyer credentials and not an assurance that directly connecting a shared upstream account is safe.

The node overwrites any caller-supplied `x-antseed-buyer-peer-id` with the authenticated P2P identity. The endpoint must trust this header only from its authenticated relay and check it on every creation, status, and cancellation request. A job ID or buyer-local route record alone is not proof of ownership. The endpoint must not allow a buyer to retrieve or cancel another buyer's jobs.

Sellers return buyer-usable result URLs in the native output fields, with suitable authorization and expiry. Buyers download those results directly; they never receive a seller's account credentials. AntSeed does not proxy authenticated Gemini Files downloads, fetch remote inputs itself, cache artifacts, or promise file retention. Inputs use the native request body's supported fields; the seller validates and processes them.

## Routing and persistence

New submissions use ordinary seller selection. A successful Runway response `id` or Veo response `name` is associated with the selected seller peer, provider, and service. Independent jobs can select different sellers concurrently.

The buyer proxy keeps the records in memory and persists `resourceRoutes` in its data directory's `buyer.state.json`, using serialized read-merge-write operations and a temporary-file rename. On startup, it restores unexpired records. No job status, prompt, video bytes, worker leases, or payment state is stored in this section. There is no background polling or execution queue. One buyer proxy must own each data directory; the state writer is not a multi-process lock or a power-loss durability guarantee.

Follow-ups recover their seller/provider/service from the record. A global preference change cannot redirect an existing job. An unavailable seller or a recorded provider that no longer supports the service produces an error, never failover to another seller or provider. Records expire after 30 days without access. At most 10,000 records or in-flight submission reservations are retained; capacity exhaustion rejects new submissions rather than silently evicting routes.

IDs are namespaced by protocol. Collisions across sellers retain both associations and require `x-antseed-pin-peer` to disambiguate. A conflicting explicit pin is rejected. For a missing or expired record, supply `x-antseed-pin-peer` and `x-antseed-service` on each follow-up; seller-side authorization remains mandatory.

Responses include `x-antseed-seller-peer`. If writing an accepted route fails, the native accepted response still reaches the caller with `x-antseed-route-persistence: failed`; the record remains in memory and the failure is logged. Save the seller header for recovery. Retrying a submission just because local persistence failed can create another paid job.

## Billing

Every service must advertise explicit unit pricing; an empty component list explicitly offers it free. Token rates are zero. Available units are `video_generations` and `video_seconds`, representing accepted requested work, not proven output delivery. Rates can match model or explicit resolution using the existing unit-billing model.

- Runway: one generation, with seconds from `duration`.
- Veo: `parameters.sampleCount` generations (default one), multiplied by `parameters.durationSeconds` for seconds.
- Counts and supplied durations must be positive safe integers. Per-second pricing requires explicit duration. Resolution-dependent pricing requires a matching request resolution; unpriceable requests are rejected before submission.
- A successful submission with a valid native resource identifier and no immediate error is billable. Rejected or malformed responses are not.
- Status and cancellation requests are free, including when the payment budget is exhausted. Result downloads are supplied by the seller without another AntSeed generation charge.
- Later failure, expiry, or cancellation does not undo the acceptance charge. Refunds are seller-operated; this is not escrow or a cryptographic guarantee of execution or delivery.

The buyer and seller derive the same quantities from the request and acceptance response, using existing payment-channel authorization and usage reports. Existing buyer spend limits apply; there is no separate signed video quote or completion settlement flow.

After submission dispatch, AntSeed does not automatically retry or fail over. Only recognized pre-execution payment negotiation can replay the same request to the same seller. A connection loss without an acceptance response is ambiguous: inspect it with the seller rather than automatically creating a second job. Idempotency and recovery across caller-initiated retries are seller API responsibilities.

## Compatibility

Protocol and billing-unit identifiers are appended without renumbering existing IDs. The metadata layout remains unchanged. Updated peers still decode existing offers; older clients can reject announcements containing unfamiliar video unit-billing entries. Upgrade clients before depending on these offers, especially on sellers advertising mixed workloads.

This replaces the unreleased managed-video draft. `/v1/video/*`, `antseed video`, video-job databases, background workers, cached artifacts, and split/full signed video quotes are not supported. Existing draft jobs are not migrated; recover them through the seller's upstream system. Previously released payment/storage migrations are unchanged.
