# Shared payments and request execution

This is PR 3/4 of the routing stack: the shared execution machinery used by node
and browser buyers. PR 2/4 defines the routing contract and complete signed metadata
v13; PR 4/4 wires network selection and buyer policy into this machinery. Intermediate
slices are not intended for standalone deployment. There are no temporary
execution guards, new metadata versions, or database migrations in this slice.

## Quantity accounting

The contract and configuration migration are supplied by [PR 1/4](quantity-billing.md).

The billing model is `{ "version": 2, "components": [{ "priceMicroUsdc": "40000" }] }` and the usage
report is `{ "version": 2, "quantity": "4" }`. This example costs 160,000 micro-USDC.
There are no named units. Conditional components remain supported by the image adapter, and matching prices are additive. `captureUnitBillingContext`
captures the selected seller, provider, service, protocol, and request limit before
execution. `computeFinalUnitBilling` uses that context and the final response to
calculate quantity and cost with integer arithmetic.

The advertised service API protocol selects the adapter, rather than an offer's
unit label. `openai-images` counts delivered, nonempty image outputs, at most the
requested `n` (default 1). `antseed-routing` and non-streaming
`openai-chat-completions` count a fulfilled response as 1, otherwise 0. An HTTP 2xx
alone is not sufficient. Buyer and seller independently measure the response;
claims above the request limit or buyer-observed quantity are rejected. Routing
response acceptance also validates the complete recommendation list before payment.

The same helpers serve buyer accounting and seller reserve estimates. Token usage
is recorded separately, including fresh/cached input attribution. The generic payment
runtime can combine token and unit charges; routing-specific pricing policy is
the responsibility of the integration slice.

### Local configuration migration and compatibility

Seller configuration loading and the shared provider config parser normalize old
v1 models to v2 before provider construction. Image components (`output_images`)
map to the image adapter with conditions and additive behavior intact;
`successful_requests` components map to supported request-counting adapters.
Empty models remain free. Prices must be exactly representable as uint32
micro-USDC. Incompatible units, unsupported conditions, mixed formats, and inexact
prices fail explicitly. Interim local flat-v2 models normalize to one unconditional
component. Migration does not automatically rewrite the config file.

Only v2 models and usage reports are accepted on the network. The v2 billing
discriminator prevents old component models/reports from being interpreted as the
new quantity contract; it is separate from metadata v13 and routing request v1.
There is no legacy runtime billing engine. Historical receipts and SQLite columns
are left intact rather than rewritten.

## Execution options

`BuyerRequestHandler.sendRequest` accepts `RequestExecutionOptions`:

- `acceptResponse` receives a cloned successful response and must synchronously
  return literal `true`. False values, thrown exceptions, and promise return values
  fail acceptance. A failed acceptance rejects the request before its successful
  response is accounted and post-response authorization is sent.
- `signal` cancels execution, including waits for responses and authorization.
  Request-scoped billing is cleaned up on success, rejection, or cancellation.
- `attribution: { purpose: 'routing', parentRequestId }` associates spend events
  with the parent inference request without selecting a router or changing policy.

Acceptance is opt-in and applies to 2xx responses. It is not a built-in routing
parser or buyer-policy engine. The integration slice supplies those decisions.
For per-call work requiring acceptance, a rejected response does not earn the
quantity of 1. This does not promise that all rejected token-priced
work is free: token authorization can already have occurred during execution.

The contract-to-payment tests use PR 2/4's recommendation eligibility helper with
the actual shared payment manager, negotiator, and request handler. An accepted
recommendation authorizes the advertised 5,000 micro-USDC; an ineligible one does
not authorize that per-call charge.

## Concurrent requests and recovery

Billing entries are keyed by request ID, isolating usage, acceptance, attribution,
and cleanup when several requests target the same seller. Channel updates are
serialized per seller so cumulative SpendingAuth updates do not race. Accounting
and authorization tests cover cancellation during signing, duplicate accounting,
channel rollover, persistence failures, and reserve retries.

Reserve top-ups retain the current policy: remaining headroom at 35% of the initial
reserve triggers the first top-up; subsequent top-ups use a $0.50 threshold. The
existing top-up increments are unchanged.

Released SQLite channel schema v5 and its existing records/signatures remain
unchanged. The manager uses the recovery state supported by each store: the
browser's existing IndexedDB store retains reserve-replay fields, while this slice
does not add those fields to SQLite. Persisted cumulative authorizations and
in-memory request tracking do not guarantee exactly-once billing across process
restarts. Obsolete source tests for removed SQLite recovery columns are documented in the
[extraction ledger](protocol/routing-split-provenance.md).

## Retained-channel reconnect

Retained payment channels support reconnecting with the existing cumulative
SpendingAuth: sellers validate and acknowledge the replay without increasing the
bill or resetting delivered usage. Disconnected and disk-restored channels must
pass on-chain validation before acknowledgment; closed, blocked, closing, or
superseded channels are not reactivated. A disconnect during validation prevents
reactivation without discarding a valid authorization for already-delivered work.

Run the buyer/seller reconnect regression with
`pnpm --filter @antseed/node exec vitest run tests/payment-reconnect.test.ts`.
After building protocol, API adapter, and buyer-core, run
`pnpm --filter @antseed/e2e run flow:local-chain-payment-reconnect` to repeat the
cases against freshly deployed local contracts. This requires Anvil, Forge, and
the repository's `forge-std` dependency. The fixture uses temporary test wallets
and a local image provider, checks successful request delivery after reconnect,
and verifies final settlement, released reserves, and unchanged ghost counts.

## Routing integration

The network adapter accepts free, token-priced, or fixed-per-call routing services.
Per-call services must advertise zero token rates: the adapter rejects mixed
per-call/token pricing even though the shared payment runtime supports hybrid
accounting for other services. Routing uses existing authenticated dispatch and
payment policies, not a separate wallet, grant, subscription, or seller lock.

The buyer checks signed metadata, preferences, schema hash, candidate eligibility,
usage context, and advertised prices before invocation. The seller validates the
structured request before negotiation and provider execution. The adapter wires
the complete ranked-list validator into per-call response acceptance; malformed,
duplicate, or partially ineligible lists do not earn a successful-request charge.

Identical routing attempts for one parent request share an operation. A schema
mismatch or failed routing response does not trigger a second paid routing call.
An eligible continuation reuses its decision. A ranked list incurs one routing
fee, independent of the number of inference attempts; an inference failure does
not undo that fee or other already-incurred charges. Each inference attempt gets
a distinct billing request ID, even when models share a seller. Conversation
spend and router result callbacks retain the originating user-request identity.

## Local-chain scenarios

After building the workspace, these fixtures deploy to an isolated local Anvil
chain. They require Foundry (`anvil`, `forge`, `cast`) and the repository's pinned
`forge-std` submodule; they do not use real funds.

```sh
node e2e/scripts/local-chain-routing-flow.mjs --same-peer
node e2e/scripts/local-chain-routing-flow.mjs --same-peer --per-call
node e2e/scripts/local-chain-routing-flow.mjs --per-call --invalid-route
node e2e/scripts/local-chain-routing-flow.mjs --same-peer --per-call --concurrent
node e2e/scripts/local-chain-routing-flow.mjs --same-peer --ranked-fallback
node e2e/scripts/local-chain-routing-flow.mjs --same-peer --per-call --ranked-fallback
```
