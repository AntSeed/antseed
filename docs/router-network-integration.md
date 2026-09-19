# Structured network routing

## Selection and CLI

Use `buyer.selection` for one model or router. `{ "kind": "router" }` selects an
installed local router. A network selection identifies a peer/provider/service
and stores its typed preferences alongside that identity:

```json
{
  "kind": "router",
  "service": {
    "peerId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "provider": "example-router",
    "serviceId": "selector"
  },
  "preferences": { "position": "last" }
}
```

`position` is defined by the example service, not by AntSeed. Configure the selection
with `antseed config buyer set selection '<JSON>'`, start the buyer, and inspect:

```bash
antseed buyer router describe --json
```

The output includes the target, signed routing metadata and effective preferences.
Defaults live in the advertised schema. Numbers, booleans, arrays and nested objects
stay typed. Offline saves check structure; the buyer validates the service schema
before any routing request. Unknown fields, missing required values and wrong types
are errors. This release provides CLI/config support, not generated desktop forms.

Inspection still returns the schema when configured values are invalid or required
values are missing. In that case it includes `configuredPreferences` and
`preferencesError`, and omits effective `preferences`, so you can correct the config
without first making a valid routing request.

`GET /_antseed/router/metadata` is the local inspection endpoint. Existing
`GET/POST /_antseed/route` manages selection; it is not the network routing API.
Conversation selections persist their own preferences. Installed-plugin settings
remain separate.

## Signed metadata

Each routing service advertises protocol `antseed-routing`, capability `routing: true`,
and `serviceRouting[serviceId]` containing `{ version: 1, preferencesSchema,
preferencesSchemaHash }`. Use `createRoutingServiceMetadata(schema)` to generate it.
The hash is SHA-256 of deterministic JSON with recursively sorted object keys.

Descriptors are included in binary metadata signing, decoding, validation and discovery,
not attached as unsigned HTTP JSON. They arrive through existing authenticated
`/metadata` discovery. Announcements containing routing descriptors or inference
reasoning efforts use the same v14 extension. Other announcements
retain their previous version selection. Updated buyers accept supported older versions;
buyers supporting only v13 or earlier cannot consume a v14 peer announcement, including
its non-routing services.

## Router-selected reasoning

Each recommendation may include one allowlisted inference control:

```json
{
  "version": 1,
  "recommendations": [
    { "serviceId": "model-a", "inference": { "reasoningEffort": "high" } },
    { "serviceId": "model-b", "inference": { "reasoningEffort": "none" } }
  ]
}
```

Inference sellers advertise accepted `reasoningEfforts` in their per-service
capabilities, for example `["none", "low", "high"]`. These values are signed in
metadata v14 and reach the router on each candidate; buyers supporting only v13 or
earlier cannot consume such announcements. Older metadata without effort labels is
still supported, but a bare `reasoning: true` does not promise any effort value.
Valid labels are `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`.
Sellers must advertise only values their inference implementation actually accepts.
The buyer additionally filters labels that cannot be represented by the target protocol.

- A router's explicit choice overrides client/app reasoning controls, including a
  conflicting client thinking budget. It cannot alter output limits, prices or buyer policy.
- `none` explicitly disables reasoning. It is not omission and does not restore the
  client's setting. A service advertising `reasoning: false` has client reasoning controls
  removed rather than receiving unsupported reasoning parameters.
- Omission preserves the client's compatible settings. Numeric thinking budgets are
  not converted into effort labels. Effort choices do not enable arbitrary body overrides.
- A model-only recommendation needs at least one eligible seller supporting that effort;
  an exact recommendation needs that exact seller/model pair. Invalid efforts are rejected
  before accepting a successful per-call routing result.

The shared adapter writes the choice in the actual inference protocol:
`reasoning_effort` for chat, `reasoning.effort` for responses, or
`output_config.effort` with adaptive thinking for messages. For messages, `none`
uses disabled thinking without an effort field. Unsupported conversions fail instead
of silently dropping the choice. Each ranked attempt is rebuilt from the original
client request with that recommendation's own effort.

### Existing continuation reuse

The buyer caches the recommendation and its effort together in the existing in-memory
conversation tracker. For example, a tool-result continuation keeps `model-a/high`
without another network routing call; a new user turn asks the router again. If the
first model fails and `model-b/none` succeeds, continuations retain that remaining choice,
not the failed model's effort. Changes to available capabilities invalidate unsupported
choices before reuse. Existing router identity, schema and preferences invalidation
still applies. Cached choices do not survive a buyer restart.

Further router-call avoidance and router-controlled reuse directives remain deferred;
this change does not introduce another cache policy or a separate paid routing call.

## Preference schemas

Schemas support object, array, string, number, integer and boolean. The root is an
object; objects require declared `properties` and `additionalProperties: false`, with
optional `required`. Arrays require one `items` schema. Supported keywords also include
`enum`, `minimum`, `maximum`, `minLength`, `maxLength`, `minItems`, `maxItems`, `title`,
`description` and `default`. Other keywords, remote references, regular expressions,
composition and executable extensions are rejected. Each schema/value has a 16 KiB
limit and depth limit 8; the overall metadata limit still applies.

Defaults fill absent fields only. An absent optional object is not constructed unless
its own default supplies it. Preferences never override buyer spending or trust policy.

## Routing API

Send non-streaming `POST /v1/route` directly to the selected service through ordinary
AntSeed authenticated, metered transport. Select the provider with the existing
`x-antseed-provider` header. Request:

```json
{
  "version": 1,
  "service": "selector",
  "preferencesSchemaHash": "<advertised hash>",
  "request": { "path": "/v1/chat/completions", "body": { "messages": [] } },
  "candidates": [{
    "serviceId": "model-a",
    "peerId": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "inputUsdPerMillion": 1,
    "outputUsdPerMillion": 2
  }, {
    "serviceId": "model-b",
    "peerId": "cccccccccccccccccccccccccccccccccccccccc",
    "inputUsdPerMillion": 2,
    "outputUsdPerMillion": 4
  }],
  "preferences": { "position": "last" }
}
```

The buyer supplies eligible candidates and advertised USD-per-million-token prices;
null means unknown, not free. The original request body is shared with the router.
Transport credentials and payment headers are not included as routing inputs.

### Usage observations

For recognized conversations the buyer optionally adds `context`, separately from
router-defined `preferences`:

```json
{
  "context": {
    "conversationRef": "opaque-router-scoped-reference",
    "usageObservations": [{
      "id": "opaque-observation-id",
      "offer": {
        "peerId": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "provider": "example-provider",
        "serviceId": "model-a"
      },
      "inputTokens": 10000,
      "cachedInputTokens": 8000,
      "ageMs": 15000
    }],
    "historyTruncated": false
  }
}
```

These are seller-reported inference usage observations, not cache predictions or proof
that an upstream cache still exists. `inputTokens` is total logical input, including
cached input. `cachedInputTokens` is an optional subset: an omitted field means unknown,
whereas zero means a reported zero. Estimated usage is not recorded. Each successful
completed inference attempt contributes at most one observation; errors, interrupted or
cancelled requests, routing-service usage, and responses without recognized input usage
are excluded. Streaming usage is collected from the completed response, not counted once
per chunk. Native upstream usage is read before client-protocol conversion.

History is scoped to the exact tool conversation (subagents remain separate) and each
seller/provider/service offer. Only currently eligible offers are included. No prompts,
credentials, raw session IDs or raw request IDs are stored in this history. Conversation
references and observation IDs are opaque and scoped to the selected routing service;
repeated snapshots retain IDs so a stateful router can deduplicate observations. IDs for
another routing service differ. Installed routers receive the same context through
`RouteSelectionContext.usageContext`.

This is a bounded recent-history snapshot, not an acknowledged event queue or a complete
lifetime ledger. The buyer retains at most 500 conversations and 64 observations per
conversation in memory, expires observations and idle conversations after 30 minutes,
and limits encoded context to 16 KiB. Oldest observations are removed first.
`historyTruncated` marks count-, age- or byte-truncated history within a retained
conversation. An evicted conversation, shutdown or restart starts a fresh reference;
routers must treat it as a new history epoch. No history is persisted to disk.

Inference responses continue to accumulate while existing continuation reuse skips
routing calls. The next routing request carries the retained observations without a
separate reporting call or charge. Routers own their estimation algorithms; observations
do not alter payments, preference defaults, eligibility, or decision-reuse policy.
Routers requiring estimates over an entire conversation must maintain their own state
and account for missing/truncated observations. A bounded snapshot alone cannot provide
exact lifetime-history parity. The seller validates the context shape, count and size
before dispatch, and the buyer's executor rejects changes to its captured context.

Response:

```json
{
  "version": 1,
  "recommendations": [
    { "serviceId": "model-a", "peerId": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
    { "serviceId": "model-b" }
  ]
}
```

Optional `peerId` selects an exact eligible seller. Without it the buyer selects an
eligible seller for that model. The nonempty `recommendations` array is ranked: the
buyer tries entries in order, including different models, after retryable inference
failures. Every entry must match the supplied eligible candidates.
Duplicate entries, unknown fields and partially invalid
lists are rejected as a whole. The list cannot exceed the number of candidate offers
plus distinct candidate models. There is no chat envelope or generated JSON text. A service with
no route returns an HTTP error containing `{ "error": { "code": "no_route", "message":
"..." } }`. Token billing can use `usage.input_tokens`, `usage.output_tokens` and
optional `usage.cached_input_tokens`; fresh input and cached input are separate counts.

The seller SDK validates schema hash and preferences before payment negotiation and
provider execution. Stale schemas require refreshing metadata, not an automatic second
paid call. Only the selected router makes the model decision. Routing cannot recursively
route itself or be converted to chat. Buyer validation remains authoritative.

## Lifecycle and migration

Eligible continuations reuse decisions only for the same service, effective preferences
and schema hash. Selection changes cancel affected work. Metadata refresh cancels calls
when their schema changes or disappears. Invalid metadata and preferences fail closed.
Only router-listed models are tried. Exact recommendations do not expand to other sellers;
model-only entries use normal eligible-seller ordering before moving to the next entry.
Each inference attempt rechecks buyer policy. Failover stops on cancellation, buyer faults,
non-retryable errors (including payment-required responses), or after response streaming
has started. Exhausting the list returns an error without another router call or an
unlisted model. Existing bounded same-seller rate-limit retries remain in effect.
Continuations retain the current recommendation and the remaining ranked choices, without
restarting earlier failed recommendations or buying the same routing decision again.

Identical calls for one parent request share one routing operation; different input is
rejected. Normal payments, cancellation and parent attribution apply. Routing and
inference can share a seller. Their charges remain separate: inference failure does not
erase an incurred routing fee. Per-call acceptance requires a valid ranked list; the list
is one routing decision, not a separate routing charge for each recommendation.

The former chat-classifier package and `plugin:classifier` settings are retired. Select
a structured service and put its advertised values in `selection.preferences`. Old
`instructions` are not silently migrated. Local plugins using the optional invocation
hook must pass `RoutingRequestV1` rather than chat messages. Routing providers must return
`recommendations`, including a one-element array for a single choice; the earlier draft's
singular `recommendation` field is not accepted.

See `docs/protocol/templates/routing-provider` for a generic reference provider, fixtures
and offline compatibility checker. Production vendor adapters and subscription billing
are outside this change.
