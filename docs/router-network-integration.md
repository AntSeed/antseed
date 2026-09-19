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
`/metadata` discovery. Announcements containing descriptors use v14. Other announcements
retain their previous version selection. Updated buyers accept supported older versions;
buyers supporting only v13 or earlier cannot consume a v14 peer announcement, including
its non-routing services.

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
  }],
  "preferences": { "position": "last" }
}
```

The buyer supplies eligible candidates and advertised USD-per-million-token prices;
null means unknown, not free. The original request body is shared with the router.
Transport credentials and payment headers are not included as routing inputs.

Response:

```json
{ "version": 1, "recommendation": { "serviceId": "model-a" } }
```

Optional `peerId` selects an exact eligible seller. Without it the buyer selects an
eligible seller for that model. Exactly one recommendation is accepted. There is no
chat envelope, generated JSON text or implicit list of fallback models. A service with
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
There is no silent router/model fallback. Existing seller selection for a model-only
recommendation remains available.

Identical calls for one parent request share one routing operation; different input is
rejected. Normal payments, cancellation and parent attribution apply. Routing and
inference can share a seller. Their charges remain separate: inference failure does not
erase an incurred routing fee. Per-call acceptance requires a valid recommendation.

The former chat-classifier package and `plugin:classifier` settings are retired. Select
a structured service and put its advertised values in `selection.preferences`. Old
`instructions` are not silently migrated. Local plugins using the optional invocation
hook must pass `RoutingRequestV1` rather than chat messages.

See `docs/protocol/templates/routing-provider` for a generic reference provider, fixtures
and offline compatibility checker. Production vendor adapters and subscription billing
are outside this change.
