# Structured routing contract

This document describes the protocol/discovery contract of the five-PR routing
stack. Generic quantity billing is PR 1/5; [reasoning-effort announcements](reasoning-efforts.md)
are PR 2/5; this protocol/discovery slice is PR 3/5. Shared payments (PR 4/5)
supply request execution and per-call accounting; buyer integration (PR 5/5)
connects selection, policy, fallback, observations, and reasoning
to this contract. See [buyer integration](../router-network-integration.md).
The early slices are review boundaries, not standalone deployments; the stack
contains no temporary execution guards.

## Advertisement and compatibility

A structured routing provider advertises the `antseed-routing` service API protocol,
the `routing: true` service capability, and a `serviceRouting[serviceId]` descriptor:

```ts
const metadata = createRoutingServiceMetadata({
  type: 'object',
  additionalProperties: false,
  properties: { position: { type: 'string', enum: ['first', 'last'], description: 'Candidate preference', default: 'first' } },
});
```

The descriptor contains `version: 1`, `preferencesSchema`, and
`preferencesSchemaHash`. The hash is SHA-256 of canonical JSON with recursively
sorted object keys. The descriptor and optional `reasoningEfforts` capabilities
are part of the signed binary **metadata v13** payload. This PR introduces the
complete v13 representation; subsequent slices use the same metadata version.

Routing descriptors propagate through provider announcements, peer discovery, and
service catalogs. Routing offers are excluded from ordinary inference model lists
and are not sent billable health probes. Existing TypeSafe decision services and
verifier advertisements remain supported.
Routing descriptors follow the existing discovery convention for an empty service
list: their named entries are preserved, but must still advertise the routing
protocol and capability. A nonempty list restricts descriptors to its named
services. This does not change seller startup requirements or request matching.
Health probes skip services marked `routing: true` or advertising `antseed-routing`
anywhere in their protocol list, regardless of protocol order.

Routing providers advertise their routing service names (for example, `selector`),
not a list of inference models they know how to route. The descriptor defines their
preferences, not model coverage. Buyers supply eligible inference models and sellers
in each request's `candidates`; recommendations must stay within that list. This
contract does not advertise model-specific routing expertise or coverage guarantees.

Seller startup validates the configured provider announcements before starting
networking. Invalid pricing, concurrency, capabilities, routing schemas or schema
hashes, and descriptors for unadvertised services prevent startup with field-specific
errors. Services advertising `antseed-routing` must provide a routing descriptor and
the `routing: true` capability. Metadata encoding limits are checked before networking
as well. Request and response validation still runs for each routing exchange; passing
startup validation cannot guarantee that future requests or responses are valid.

Updated discovery accepts supported older metadata versions. Announcements without
new fields retain their existing version selection. An older buyer that only accepts
v12 or earlier cannot consume a v13 announcement, including its non-routing services.
Encoding rejects attempts to place descriptors or reasoning-effort lists in an
older format that cannot sign those fields.

## Request and response

The request is JSON sent to `POST /v1/route`:

```json
{
  "version": 1,
  "service": "selector",
  "preferencesSchemaHash": "<hash from the signed descriptor>",
  "request": { "path": "/v1/chat/completions", "body": { "messages": [] } },
  "candidates": [
    { "serviceId": "model-a", "peerId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "inputUsdPerMillion": 1, "outputUsdPerMillion": 2, "reasoningEfforts": ["adaptive", "deep-analysis"] }
  ],
  "preferences": { "position": "first" }
}
```

`validateRoutingRequest` checks the descriptor, schema hash, preferences, candidates,
and optional usage context. Candidate prices may be `null` when unknown; optional
`cachedInputUsdPerMillion` is not a guarantee of cache availability. The routing
endpoint is not adapted to a chat endpoint.

The response is a nonempty ranked list:

```json
{
  "version": 1,
  "recommendations": [
    { "serviceId": "model-a", "peerId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    { "serviceId": "model-a", "inference": { "reasoningEffort": "adaptive" } }
  ],
  "usage": { "input_tokens": 20, "output_tokens": 4 }
}
```

An entry may name a model only or an exact eligible seller. Duplicate model/seller
pairs, ineligible entries, unsupported inference fields, and malformed usage are
rejected. `parseRoutingResponse` in `@antseed/router-core` validates the complete
list and preserves rank without invoking a service. Optional usage counts are
nonnegative safe integers, including `cached_input_tokens` when supplied.

Reasoning labels are opaque, seller-defined strings, not a protocol-wide enum. Sellers
advertise their supported choices in `serviceCapabilities[serviceId].reasoningEfforts`;
buyers carry those choices into routing candidates. Lists allow at most 32 unique
labels, each nonempty and at most 64 UTF-8 bytes, without surrounding whitespace or
control characters. An empty or missing list allows no routing-supplied override.
When `reasoning` is explicitly false, its effort list must be empty or omitted.
Recommendations must match an advertised choice exactly. For model-only recommendations,
at least one eligible candidate must advertise that choice, and subsequent seller
selection must preserve that restriction. Applying a supported setting to a backend
API, and retrying/continuing inference, belong to buyer integration rather than this
validator. An accepted label is not a universal backend parameter mapping.

## Preferences and observations

AntSeed defines and validates a deliberately small JSON schema subset in
`packages/protocol/src/routing.ts`. The root requires `type: 'object'`,
`properties`, and `additionalProperties: false`, with an optional `required` list.
Every field requires `type: 'string'` and a nonempty `enum` of unique string values.
Fields may include `description` and a `default` that belongs to the enum. There is
no `title`, `enumLabels`, free text, numeric/boolean field, array, or nested object.
Providers choose their field names and enum values, then translate those values to
their backend settings. Buyers can inspect the same signed contract without
provider-specific code or a frontend change.

Unknown keywords, undeclared preferences, invalid defaults, and prototype-related
keys are rejected. Schemas and preference values are each bounded to 16 KiB.
`resolveRoutingPreferences` applies defaults without mutating the input. This
restriction applies only to preferences, not to the inference request's JSON body.
Flat string enums eliminate recursive default expansion: array/object defaults and
nested enum values are rejected rather than expanded. The schema, supplied values,
and resolved values retain the 16 KiB UTF-8 JSON limit, bounding the number of fields
and enum choices validated without a separate recursive-expansion engine.

Optional `context` contains `conversationRef`, `usageObservations`, and
`historyTruncated`. Each observation has an opaque `id`, an `offer` identifying
peer/provider/service, `inputTokens`, optional `cachedInputTokens`, and `ageMs`.
Missing cache counts mean unknown, not zero. The context is bounded to 64
observations and 16 KiB; IDs must be unique within the snapshot. This slice defines
and validates that shape; it does not collect or persist observations.

## Quantity billing dependency

`createUnitBillingModel` accepts a canonical integer micro-USDC string from `0`
through `4294967295` and produces `{ version: 2, components: [{ priceMicroUsdc }] }`.
A usage report is `{ version: 2, quantity: '1' }`. Cost is the sum of matching
component prices times quantity, with no offer-level unit label. Image adapters
support conditional components; routing and chat pricing is unconditional. The service API protocol selects the
quantity adapter: delivered images for `openai-images`, or one fulfilled response
for `antseed-routing` and non-streaming `openai-chat-completions`.

Metadata v13 encodes the billing model version, components, uint32 prices, and conditions. Legacy network
billing advertisements/reports are rejected, not reinterpreted. Older token-only
announcements remain supported. Compatible legacy seller configuration is
migrated before provider construction by [PR 1/5](../quantity-billing.md).

Catalog `billingByProtocol` exposes fixed prices or conditional rules without treating
them as token prices or inventing numeric summaries for conditional offers. The shared payments slice adds response-acceptance hooks,
request-scoped accounting, cancellation cleanup, and serialized channel updates;
see [shared payment execution](../router-per-call-billing.md). Buyer integration
wires these hooks to network-router selection and buyer policy.

## Conformance example

See `templates/routing-provider/` for a deterministic provider and valid/invalid
fixtures. The router-core routing-response tests validate those fixtures and exercise
the example provider without contacting an external service or authorizing payment.
There is no separate compatibility script or manual validation step required to start
a seller.
