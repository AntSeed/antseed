# Generic quantity billing

This is PR 1/4 of the unreleased routing stack. It defines the billing contract,
quantity adapters, buyer verification, seller estimates, discovery pricing, and
local configuration migration. Router selection, preference schemas, conversation
behavior, reasoning controls, and shared request-lifecycle changes are separate PRs.

## Contract

An offer advertises `{ "version": 2, "priceMicroUsdc": "40000" }`. A usage report
contains `{ "version": 2, "quantity": "4" }`. Cost is exactly price multiplied by
quantity: 160,000 micro-USDC in this example. Prices are canonical uint32 decimal
strings, and quantities are canonical nonnegative safe-integer decimal strings.
There is no offer-level unit, conditional price component, or second billing engine.

The selected API protocol determines quantity. `openai-images` counts nonempty
delivered images, bounded by requested `n` (default 1). Non-streaming
`openai-chat-completions` and `antseed-routing` count a fulfilled response as one,
otherwise zero. Registering the routing protocol identifier and its quantity
adapter here does not activate a router endpoint or buyer routing. Full routing
response validation and acceptance are provided by the following PRs.

Buyer and seller independently measure fulfillment. Buyer validation rejects
positive claims without observed output, quantities above the captured request
limit or observation, and unit costs above exact price times quantity. Token
charges remain separate. Payment authorization and execution ordering are not
redesigned here; the shared-execution PR supplies request-scoped acceptance,
concurrent-accounting, and cancellation semantics.

## Migration and compatibility

Seller config loading and the provider environment parser convert a compatible v1
model before provider construction. One unconditional `output_images` component
maps to the image adapter. One unconditional `successful_requests` component maps
to a request-counting adapter. Empty models become free. Prices must be exactly
representable in uint32 micro-USDC. Multiple components, conditional tiers,
incompatible units, and inexact prices fail explicitly; configure a fixed v2 price.
The config file is not rewritten automatically.

Signed quantity offers use metadata v13. Legacy billing advertisements and usage
reports are rejected rather than reinterpreted; supported token-only older metadata
continues to work. Metadata v13 is an unreleased stack format whose complete routing
descriptor extension is finalized in PR 2/4. These are review boundaries, not
separate protocol releases: deploy the completed stack together. Historical
receipts, SQLite columns, and released database migrations are not rewritten.

## Verification

Tests cover exact integer arithmetic, malformed and old wire payloads, signature
coverage, partial fulfillment, overdelivery, free offers, startup migration,
unsupported adapters, and existing image/payment regressions.
