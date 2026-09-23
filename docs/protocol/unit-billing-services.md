# Shared unit billing

This extension adds explicit paid-service requests without changing metadata
v12, image unit billing/report v1, token prices, or the payment contracts.
The buyer-only Levanto router validates the `levanto-routing-v1` contract;
its seller integration is operated externally. Other integrations can use their
own API protocols, endpoints and validators without changing the billing calculator.

## The simple version

A measurement adapter answers **how much was delivered?** The pricing model
answers **what does each unit cost?** The existing payment channel collects the
result. Routing is a service type, not a billing mode.

| Service | Measurement | Example charge |
| --- | --- | --- |
| Image generation | Delivered output images, capped at the requested count | 2 images × $0.04 = $0.08 |
| Completed-request service | 1 accepted successful response, otherwise 0 | 1 routing response × $0.001 = $0.001 |
| Token inference | Actual input, cached-input and output token usage | Existing token rates and accounting, unchanged |

Five recommendations in one routing response count as **one completed request**,
not five requests or five images. Routing predictions are not backend usage.

## Responsibilities

- **Provider plugin:** declare `serviceExecution` with a service kind, local
  endpoint, schema identifier and response validator. Configure pricing separately
  in `serviceUnitBillingModels`. Validate incoming requests and return a complete response.
  It does not manage buyer deposits or sign payments.
- **Seller SDK:** advertise the signed fee, enforce buyer capability and matching
  contract/endpoint, check reserve headroom, then
  record the fee and request authorization.
- **Buyer SDK:** verify seller metadata, enforce the caller's price cap and its
  configured per-request budget, validate delivered fulfillment, and sign exactly
  that fee once in its existing cumulative SpendingAuth.

Execution and pricing are independent. Health probing uses the execution type,
not the price. There is no `fixedFeeServices` API or separate fixed-fee ledger.
The shared evaluator and payment manager handle both image and completed-request
units, with different measurement adapters. Existing token metering is unchanged.

`levanto-routing` identifies Levanto's API format, just as `typesafe-systemone`
identifies TypeSafe's format. Neither selects a billing unit. The configured
billing model selects measurement; completed requests can use either protocol.
When a completed-request service supports multiple API protocols, they must use
the same unit price because the signed offer is per service.

For example, these fields on a provider configure a $0.001 routing request
(the provider also supplies `handleRequest`):

```ts
services: ['levanto-route'],
serviceApiProtocols: { 'levanto-route': ['levanto-routing'] },
serviceExecution: {
  'levanto-route': {
    kind: 'routing',
    contract: 'levanto-routing-v1',
    path: '/_antseed/levanto-route',
    acceptResponse: validateDeliveredRoutingResponse,
  },
},
serviceUnitBillingModels: {
  'levanto-route': {
    'levanto-routing': {
      version: 2,
      components: [{ unit: 'completed_requests', priceMicroUsdc: '1000' }],
    },
  },
},
pricing: { defaults: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 } },
```

`validateDeliveredRoutingResponse(request, response)` is the provider's own
synchronous schema/fulfillment validator. Only literal `true` accepts the response.
The buyer independently validates delivery; seller acceptance alone never
authorizes buyer money. `levanto-routing-v1` names the application's JSON schema,
not a blockchain contract or pricing mode.

The current Levanto buyer supports completed-request pricing, including zero for
a free service. This does not make all routers per-request services. Token-priced
routing would need actual backend token measurements and a compatible
discovery/request path. Nonzero token surcharges are rejected for completed-request
pricing because its adapter does not measure tokens.

No token counts are fabricated. Routing cost predictions in the JSON response
describe possible downstream inference; they are never used to price the routing
service or automatically authorize a downstream purchase.

The Levanto buyer validates the response envelope and filters ranked entries
individually against its existing eligible model/peer candidates. One unusable
entry does not reject an otherwise usable ranking. No eligible entries means
no response acceptance. See `plugins/router-levanto/README.md` for selection,
generic preference schemas and cache-observation behavior.

## Discovery and compatibility

Sellers advertise `payments.completed-requests.v1` and use the existing signed
`offerings` representation:

```json
{
  "capability": "agent",
  "name": "unit-billing.v2:levanto:levanto-routing-v1",
  "description": "Price per completed request",
  "services": ["levanto-route"],
  "pricing": { "unit": "request", "pricePerUnit": 0.001, "currency": "USD" }
}
```

The wire price uses the existing float32 encoding; the resolver recovers integer
micro-USDC and rejects prices that cannot round-trip. Displayed decimal values
may differ slightly from the binary float representation. The agreed request fee
is always the canonical integer micro-USDC string.

Routing/custom execution services are excluded from `providers[].services`, associated
inference metadata, `/v1/models`, and inference health probes. Existing inference
providers remain advertised in the same correctly signed v12 representation.
There is no whole-seller v13 switch. Execution-only providers do not become empty
wildcard inference providers.

Images retain version-1 models, dollar prices, rounding, request limits and
`output_images` reports. Completed requests use version-2 models and usage
reports; they are not disguised as images or added to the v1 unit table.
Upgraded peers must explicitly support the new billing capability. Old image/token
buyers can continue using ordinary services on the same seller.

## Request and payment lifecycle

1. The plugin constructs a normal request and calls `node.sendRequest(peer,
   request, { unitBilling: offer, maxFeeMicroUsdc, acceptResponse, signal })`.
   The SDK verifies the metadata signature, identity, capability, unique offer,
   expected contract, and exact fee before dispatch. A synchronous acceptance
   callback is mandatory; only the literal `true` accepts a response. It receives
   a defensive copy of the response. There is no separate paid-service API.
2. The request is authenticated and nonstreaming, with a unique request ID and
   native `service`. The SDK supplies the provider and `x-antseed-service-contract`
   headers. There is no per-request price header or new quote exchange: the buyer
   keeps the selected advertised price locally.
3. The seller requires the completed-request connection capability and a matching
   service contract. A paid request cannot execute without an active funded channel and
   enough confirmed reserve remaining for the entire fee.
4. On the initial pre-execution 402, the buyer uses normal ReserveAuth/channel
   setup and retries once. The initial cumulative spending amount is zero.
5. The provider validates the complete successful response. The measurement
   adapter produces one completed request and the shared evaluator computes its
   price. Normal NeedAuth carries zero tokens and
   `billingUsage: {version: 2, units: {completed_requests: '1'}}` (or `'0'` for
   no accepted completion). The buyer independently accepts delivery through the
   plugin callback and uses the same evaluator/signing path as other unit bills.
   NeedAuth can arrive before or after the response without a second charge.
6. The existing settlement flow claims the cumulative authorization. Existing
   reserve top-up behavior is reused after an authorized response.

Without a per-request price agreement, a seller price change after discovery can
be discovered only after execution. The buyer does not increase its authorization
to match a new seller price; it retains the selected price and spending limits.
This can leave a payment disagreement after the seller has done the work. There
is no automatic repricing or replay to resolve it.

A seller's `requiredCumulativeAmount` is not permission to inflate a unit charge.
Uncorrelated completed-request claims, token/image surcharges, and claims for an incorrect
channel are rejected. Failed, canceled, or malformed responses do not earn a
buyer authorization. Streaming and externally supplied spending-auth headers
are not supported for this flow.

## Concurrency, retries, and limits

Once a buyer opts into completed requests on a seller, requests sharing that buyer's
payment channel are serialized, including its inference requests, to prevent
concurrent requests from consuming the same reserve headroom. Already-running
requests drain before the first completed-request request. Other buyers are independent.
There are at most 32 queued requests per opted-in buyer. Ordinary image/chat
buyers retain their previous scheduling behavior, even on a mixed seller.
Image pricing and billing payloads are unchanged; only opted-in buyers may see
lower same-seller concurrency.

Only the initial pre-execution payment negotiation is automatically retried.
For an existing channel, a 402 is returned rather than signing a seller-selected
catch-up amount or blindly replaying work. Exhausted or expired channels may
therefore require caller-managed recovery through the existing channel lifecycle.
Never automatically replay a request after an ambiguous timeout/disconnection.

Duplicate execution protection is in memory: the seller remembers executed IDs
for 24 hours, with a 10,000-entry limit (new executions receive 429 when full).
The buyer bounds its in-memory correlation cache to 512 entries and evicts
authorized or rejected entries; unresolved/unpaid accepted entries are not evicted to make room. This is not
durable exactly-once execution across restarts. SpendingAuth itself retains the
existing durable channel-store behavior. No database migration is introduced.

## Ranked inference fallback

The buyer proxy can use additional destinations from an already accepted router
response without another routing purchase. Each inference attempt has a distinct
request ID and is billed separately through normal inference execution. Attempts
are linked to the originating conversation without counting extra user turns.
Routing-service requests are linked to that conversation before dispatch, using
the existing local request-ID-to-conversation map and signed-spend events. Their
fees contribute to conversation spend, but not inference token totals or request
counts. An accepted routing fee remains attributed if inference subsequently
fails. Late authorizations use the same bounded tracking map; no new wire fields,
payment API, or database migration is introduced.

Fallback only uses accepted destinations that still satisfy current buyer policy
and required verification. Exact peer recommendations never expand to other peers;
model-only recommendations use the eligible sellers resolved for that model.
Duplicate destinations are removed. Cancellation, buyer faults, payment-required
responses, HTTP timeouts, ambiguous transport failures, and started streams stop
fallback. Neither another router call nor an unlisted destination is used when
the list is exhausted. No changes apply to ordinary token/image routing.

## Compatibility verification

After building the SDK, run `node scripts/check-unit-billing-compatibility.mjs`.
This is a regression check, not runtime compatibility code.
It loads the frozen pre-change metadata decoder, validator, buyer request handler,
and image billing calculator from commit `172e4fc986484c9c1adbbfccd076427850dd57c7`
through `git show` (the commit must be present in local history). It verifies the
new signed offering with the old decoder, detects signature tampering, and runs
an old image request against a mixed-service metadata/transport fixture: two
$0.04 images still cost 80000 micro-USDC with a v1 `output_images` report.

The seller tests separately exercise legacy-capability image requests and
unchanged image charges/concurrency on the updated mixed seller. These fixtures
do not replace live-chain settlement or verification of Levanto's private backend.
