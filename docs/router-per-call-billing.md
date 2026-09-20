# Shared payments and request execution

This is PR 2 of the routing stack: the shared execution machinery used by node
and browser buyers. PR 1 defines the routing contract and complete signed metadata
v14; PR 3 wires network selection and buyer policy into this machinery. Intermediate
slices are not intended for standalone deployment. There are no temporary
execution guards, new metadata versions, or database migrations in this slice.

## Per-call accounting

`successful_requests` measures a successful HTTP response as one unit, capped by
the captured request limit. A fixed per-call price is an integer number of
micro-USDC. `captureUnitBillingContext` captures the selected seller, provider,
service, protocol, and request limits before execution. `computeFinalUnitBilling`
uses that context and the final response to calculate unit usage and cost.

The same helpers serve buyer accounting and seller reserve estimates. Existing
image-unit billing remains supported. Token usage is recorded separately from
per-call units, including fresh/cached input attribution. The generic payment
runtime can combine token and unit charges; routing-specific pricing policy is
the responsibility of the later integration slice.

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
successful-request unit. This does not promise that all rejected token-priced
work is free: token authorization can already have occurred during execution.

The contract-to-payment tests use PR 1's recommendation eligibility helper with
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

## Deferred routing integration

PR 3 supplies CLI/config selection, the network adapter, routing request/schema
dispatch, buyer-policy checks, ranked fallback, usage-observation collection,
reasoning overrides, continuation reuse, and local-chain routing end-to-end
fixtures. The optional result telemetry fields introduced here define the
reporting contract; they do not activate those behaviors.
