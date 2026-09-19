# Structured routing contract

This document describes the protocol/discovery slice of the three-PR routing stack.
It does not enable automatic buyer routing or fixed-per-call execution. Those are
implemented by the payments and buyer-integration slices. This intermediate slice
is for review and testing, not standalone deployment; there are deliberately no
temporary execution guards.

## Advertisement and compatibility

A structured routing provider advertises the `antseed-routing` service API protocol,
the `routing: true` service capability, and a `serviceRouting[serviceId]` descriptor:

```ts
const metadata = createRoutingServiceMetadata({
  type: 'object',
  additionalProperties: false,
  properties: { position: { type: 'string', enum: ['first', 'last'], default: 'first' } },
});
```

The descriptor contains `version: 1`, `preferencesSchema`, and
`preferencesSchemaHash`. The hash is SHA-256 of canonical JSON with recursively
sorted object keys. The descriptor and optional `reasoningEfforts` capabilities
are part of the signed binary **metadata v14** payload. This PR introduces the
complete v14 representation; subsequent slices do not require v15.

Routing descriptors propagate through provider announcements, peer discovery, and
service catalogs. Routing offers are excluded from ordinary inference model lists
and are not sent billable health probes. Existing TypeSafe decision services and
verifier advertisements remain supported.

Updated discovery accepts supported older metadata versions. Announcements without
new fields retain their existing version selection. An older buyer that only accepts
v13 or earlier cannot consume a v14 announcement, including its non-routing services.
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
    { "serviceId": "model-a", "peerId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "inputUsdPerMillion": 1, "outputUsdPerMillion": 2 }
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
    { "serviceId": "model-a", "inference": { "reasoningEffort": "high" } }
  ],
  "usage": { "input_tokens": 20, "output_tokens": 4 }
}
```

An entry may name a model only or an exact eligible seller. Duplicate model/seller
pairs, ineligible entries, unsupported inference fields, and malformed usage are
rejected. `parseRoutingResponse` in `@antseed/router-core` validates the complete
list and preserves rank without invoking a service. Optional usage counts are
nonnegative safe integers, including `cached_input_tokens` when supplied.

Reasoning labels are `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`.
An explicit candidate effort list is restrictive; an empty list allows no override.
Missing candidate effort metadata allows a valid best-effort choice, not a backend
support guarantee. For model-only recommendations at least one eligible candidate
must permit the chosen effort. Applying an override and retrying/continuing inference
are intentionally outside this slice.

## Preferences and observations

The schema supports `object`, `array`, `string`, `number`, `integer`, and `boolean`;
`title`, `description`, `default`, and `enum`; object `properties`/`required`;
array `items`/`minItems`/`maxItems`; string `minLength`/`maxLength`; and numeric
`minimum`/`maximum`. Objects require `additionalProperties: false`. Unknown
keywords, undeclared preferences, invalid defaults, and prototype-related keys
are rejected. Schemas and preference values are bounded to 16 KiB and depth 8.
`resolveRoutingPreferences` applies schema defaults without mutating the input.

Optional `context` contains `conversationRef`, `usageObservations`, and
`historyTruncated`. Each observation has an opaque `id`, an `offer` identifying
peer/provider/service, `inputTokens`, optional `cachedInputTokens`, and `ageMs`.
Missing cache counts mean unknown, not zero. The context is bounded to 64
observations and 16 KiB; IDs must be unique within the snapshot. This slice defines
and validates that shape; it does not collect or persist observations.

## Price representation, not payment execution

The protocol recognizes the `successful_requests` unit. `createPerCallBillingModel`
accepts a canonical integer micro-USDC string from `0` through `4294967295` and
produces one unconditional fixed-price component. Metadata encodes that price
exactly as uint32 micro-USDC; existing image-unit bytes remain unchanged.

Catalog `billingByProtocol` exposes advertised per-call prices without treating
them as token prices. This does not implement response acceptance, charging,
settlement, cancellation accounting, or payment-channel concurrency. Do not use
per-call execution until the payments slice is included.

## Conformance example

See `templates/routing-provider/` for a deterministic provider and valid/invalid
fixtures. After building protocol, node, and router-core:

```sh
node docs/protocol/templates/routing-provider/check-compatibility.mjs
```

The checker validates captured data locally; it never contacts a provider or
authorizes a payment. Pass metadata, request, and response JSON paths to validate
another capture.
