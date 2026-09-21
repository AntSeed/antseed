# Generic quantity billing

This is PR 1/6 (#1039) of the unreleased routing stack. It defines the billing contract,
quantity adapters, buyer verification, seller estimates, discovery pricing, and
local configuration migration. Router selection, preference schemas, conversation
behavior, reasoning controls, and shared request-lifecycle changes are separate PRs.
[Reasoning-effort announcements](protocol/reasoning-efforts.md) are PR 2/6 (#1040),
[routing protocol/discovery](protocol/routing.md) is PR 3/6 (#1034), and
[routing-critical paid execution](router-per-call-billing.md) is PR 4/6 (#1035).
Buyer routing integration follows in PR 5/6 (#1036); independent generic payment
fixes follow that integration in PR 6/6, not as its prerequisite.

## Contract

An offer advertises `{ "version": 2, "components": [{ "priceMicroUsdc": "40000" }] }`.
A usage report contains `{ "version": 2, "quantity": "4" }`. Cost is the sum of
matching component prices multiplied by quantity: 160,000 micro-USDC in this
example. Component prices are canonical uint32 decimal strings; sums and products
use integer arithmetic without uint32 truncation. Quantities are canonical
nonnegative safe-integer decimal strings. There are no offer-level unit labels.

Components can carry `match` conditions. Every condition within a component must
match; all matching components are additive, independent of order. An absent or
empty `match` is unconditional. A nonempty model with no matching component rejects
the request before provider execution; an empty component list is free. Zero
fulfilled quantity never creates a fee.

```json
{
  "version": 2,
  "components": [
    { "priceMicroUsdc": "40000" },
    { "priceMicroUsdc": "20000", "match": { "quality": "hd", "size": "1536x1024" } }
  ]
}
```

This offer charges 60,000 micro-USDC per delivered image when both conditions
match, otherwise 40,000. `openai-images` supports `model`, `size`, `quality`, and
`resolution`. The image adapter captures trimmed request values from JSON or
multipart bodies; omitted size/quality on image endpoints retain the existing
`auto` defaults. It does not infer upstream choices for `auto`. Buyer and seller
match the same network request before upstream model rewriting. Chat and routing
adapters currently support only unconditional components.

Catalog entries retain `kind: "per_quantity"`, include the canonical `model`, and
distinguish `pricing: "fixed"` from `pricing: "conditional"`. Only fixed entries
include `amountMicroUsdc` and numeric image price summaries. Conditional entries
retain all rules with no numeric range; missing summaries mean unknown, never
free or token-priced. Exact pricing is resolved from request attributes.

The selected API protocol determines quantity. `openai-images` counts nonempty
delivered images, bounded by requested `n` (default 1). Non-streaming
`openai-chat-completions` and `antseed-routing` count a fulfilled response as one,
otherwise zero. Registering the routing protocol identifier and its quantity
adapter here does not activate a router endpoint or buyer routing. Full routing
response validation belongs to the protocol contract; paid acceptance and its
buyer integration follow in #1035 and #1036 respectively.

Buyer and seller independently measure fulfillment. Buyer validation rejects
positive claims without observed output, quantities above the captured request
limit or observation, and unit costs above exact price times quantity. Token
charges remain separate. Payment authorization and execution ordering are not
redesigned here; [routing-critical paid execution](router-per-call-billing.md)
supplies request-scoped acceptance, concurrent accounting, and cancellation
semantics required by buyer integration.

## Migration and compatibility

Seller config loading and the provider environment parser convert a compatible v1
model before provider construction, preserving every compatible component and
condition. Legacy `output_images` components map to the image adapter;
`successful_requests` components map to request-counting adapters. Empty models
remain free. Prices must be exactly representable in uint32 micro-USDC. Incompatible
units, unsupported conditions, mixed formats, and inexact prices fail explicitly.
The interim local flat-v2 shape is normalized to one unconditional component.
The config file is not rewritten automatically.

Metadata encodes at most 255 components per model, each with a uint32 price and
adapter-supported condition keys/values. Conditions use the existing one-byte
UTF-8 lengths (at most 255 bytes per key/value); sorted condition keys give stable
signing bytes. Duplicate keys, malformed values, unsupported conditions, truncated
payloads, and metadata exceeding 128 KiB are rejected. The superseded flat-v2
wire layout is not retained as a second decoder.

Signed quantity offers use metadata v13. Legacy billing advertisements and usage
reports are rejected rather than reinterpreted; supported token-only older metadata
continues to work. Metadata v13 is an unreleased stack format whose complete routing
descriptor extension is finalized in PR 3/6 (#1034), after reasoning-effort announcements
in PR 2/6 (#1040). These are review boundaries, not
separate protocol releases: deploy the completed stack together. Historical
receipts, SQLite columns, and released database migrations are not rewritten.

## Verification

Tests cover exact integer arithmetic, malformed and old wire payloads, signature
coverage, partial fulfillment, overdelivery, free offers, startup migration,
unsupported adapters, and existing image/payment regressions.
