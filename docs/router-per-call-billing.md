# Routing-critical paid execution

This is PR 4/6 (#1035) of the unreleased routing stack. It retains the shared
accounting and execution machinery required by node and browser buyer integration,
not a separate routing payment engine. The review order is:

1. #1039: [quantity billing](quantity-billing.md).
2. #1040: [reasoning-effort announcements](protocol/reasoning-efforts.md).
3. #1034: [routing protocol/discovery](protocol/routing.md).
4. #1035: routing-critical paid execution, attribution, and contract acceptance tests.
5. #1036: buyer routing integration.
6. A new generic payment follow-up, based on updated #1036 (PR number not yet assigned).

These are review boundaries, not separate releases or standalone deployments.
There are no temporary execution guards, new metadata versions, or database
migrations in this slice. The split preserves existing runtime behavior rather
than redesigning payments or fixing unrelated bugs.

## Quantity accounting

See [quantity billing](quantity-billing.md) for the v2 contract, protocol adapters,
conditional/additive pricing, and configuration migration. Before execution,
`captureUnitBillingContext` captures the selected seller, provider, service,
protocol, and request limit. Request-scoped billing snapshots retain the billing
model and token prices; negotiation rejects token rates above the snapshot.
`computeFinalUnitBilling` uses the captured context and final response to calculate
quantity and cost with integer arithmetic.

Buyer and seller independently measure fulfillment. Claims above the request limit
or buyer-observed quantity are rejected. A fulfilled per-call response counts as 1,
otherwise 0; HTTP 2xx alone is insufficient. Routing validation can be supplied
through the acceptance hook below, rather than being built into generic accounting.

The same helpers serve buyer accounting and seller reserve estimates. Token usage
is recorded separately, including fresh/cached input attribution. The generic payment
runtime can combine token and unit charges; routing-specific pricing policy is
the responsibility of the integration slice.

## Execution options

`BuyerRequestHandler.sendRequest` accepts `RequestExecutionOptions`:

- `acceptResponse` receives a cloned successful response and must synchronously
  return literal `true`. False values, thrown exceptions, and promise return values
  fail acceptance. A failed acceptance rejects the request before its successful
  response is accounted and post-response authorization is sent.
- `signal` cancels execution, including waits for responses and authorization.
  Request-scoped billing is finalized on success, rejection, or cancellation;
  inactive context is subject to bounded cache cleanup, not durable retention.
- `attribution: { purpose: 'routing', parentRequestId }` associates spend events
  with the parent inference request without selecting a router or changing policy.

Acceptance is opt-in and applies to 2xx responses. It is not a built-in routing
parser or buyer-policy engine. #1036 will supply the production integration.
For per-call work requiring acceptance, a rejected response does not earn the
quantity of 1. This does not promise that all rejected token-priced
work is free: token authorization can already have occurred during execution.

The contract-to-payment tests use #1034's recommendation eligibility helper with
the actual shared payment manager, negotiator, and request handler. An accepted
recommendation authorizes the advertised 5,000 micro-USDC; an ineligible one does
not authorize that per-call charge.

`Router.onResult` exposes optional request ID, token-breakdown, and estimated-cost
fields for downstream reporting. #1036 will connect them to buyer routing and
conversation attribution.

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
restarts or complete recovery of pending work. A known pre-existing issue remains:
failed pending authorization can lose its billing context after five minutes,
causing cooperative close to fail. Fixing that expiry/close behavior is a separate
follow-up, not part of this split.

## Downstream boundaries

Buyer integration in #1036 (5/6) will apply routing pricing policy: free,
token-priced, or fixed-per-call services, with zero token rates required for
per-call routing even though the shared runtime supports hybrid accounting.
It will wire signed metadata, preferences, schema and candidate checks, and the
complete ranked-list validator into dispatch and acceptance using existing payment
policies, not a separate wallet, grant, subscription, or seller lock.

That integration will own shared routing operations for identical parent requests,
continuation reuse, and fallback: one ranked list earns one routing fee regardless
of inference attempts; already-incurred fees are not undone by inference failure.
Each inference attempt will use a distinct billing ID, while conversation spend
and result callbacks retain the originating request identity. Its local-chain
scenarios belong to #1036, not this slice.

The independent generic follow-up (6/6), based on updated #1036, will carry the
retained seller-channel reconnect fix and its buyer/seller regression and local-chain
fixture, SQLite schema regression tests, and seller billing type-alias cleanup.
Those changes are deferred, not prerequisites for buyer integration. No reconnect
implementation or complete-recoverability guarantee is claimed by this slice.
