# Opt-in fixed-fee services

This extension adds explicit paid-service requests without changing metadata
v12, image unit billing/report v1, token prices, or the payment contracts.
The Levanto plugin supplies the `levanto-routing-v1` contract. Other plugins
can supply their own endpoints and validators without adding schemas to core.

## Responsibilities

- **Provider plugin:** declare `fixedFeeServices` with a local `path`, validate
  requests and successful backend responses, and return a complete response.
  It does not manage buyer deposits or sign payments.
- **Seller SDK:** advertise the signed fee, enforce buyer capability and exact
  contract/price/endpoint agreement, check reserve headroom, then
  record the fee and request authorization.
- **Buyer SDK:** verify seller metadata, enforce the caller's price cap and its
  configured per-request budget, validate delivered fulfillment, and sign exactly
  that fee once in its existing cumulative SpendingAuth.

No token counts are fabricated. Routing cost predictions in the JSON response
describe possible downstream inference; they are never used to price the routing
service or automatically authorize a downstream purchase.

## Discovery and compatibility

Sellers advertise `payments.fixed-fee.v1` and use the existing signed
`offerings` representation:

```json
{
  "capability": "agent",
  "name": "fixed-fee.v1:levanto:levanto-routing-v1",
  "description": "Fixed fee per fulfilled response",
  "services": ["levanto-route"],
  "pricing": { "unit": "request", "pricePerUnit": 0.001, "currency": "USD" }
}
```

The wire price uses the existing float32 encoding; the resolver recovers integer
micro-USDC and rejects prices that cannot round-trip. Displayed decimal values
may differ slightly from the binary float representation. The agreed request fee
is always the canonical integer micro-USDC string.

Fixed-fee services are excluded from `providers[].services`, associated
inference metadata, `/v1/models`, and inference health probes. Existing inference
providers remain advertised in the same correctly signed v12 representation.
There is no whole-seller v13 switch. Fixed-only providers do not become empty
wildcard inference providers.

## Request and payment lifecycle

1. The plugin constructs a normal request and calls `node.sendRequest(peer,
   request, { fixedFee: offer, maxFeeMicroUsdc, acceptResponse, signal })`.
   The SDK verifies the metadata signature, identity, capability, unique offer,
   expected contract, and exact fee before dispatch. A synchronous acceptance
   callback is mandatory; only the literal `true` accepts a response. It receives
   a defensive copy of the response. There is no separate paid-service API.
2. The request is authenticated and nonstreaming, with a unique request ID,
   native `service`, provider header, `x-antseed-fixed-fee-contract`, and
   `x-antseed-fixed-fee-price` (integer micro-USDC).
3. The seller requires the fixed-fee connection capability and an exact offer
   match. A paid request cannot execute without an active funded channel and
   enough confirmed reserve remaining for the entire fee.
4. On the initial pre-execution 402, the buyer uses normal ReserveAuth/channel
   setup and retries once. The initial cumulative spending amount is zero.
5. The provider validates the complete successful response; the seller records precisely the
   fixed fee, and sends normal NeedAuth with zero token counts. The buyer
   independently accepts delivery through the plugin callback and signs the same fee. NeedAuth can arrive
  before or after the response without causing a second charge.
6. The existing settlement flow claims the cumulative authorization. Existing
   reserve top-up behavior is reused after an authorized response.

A seller's `requiredCumulativeAmount` is not permission to inflate a fixed fee.
Uncorrelated fixed-fee claims, token/image surcharges, and claims for an incorrect
channel are rejected. Failed, canceled, or malformed responses do not earn a
buyer authorization. Streaming and externally supplied spending-auth headers
are not supported for this flow.

## Concurrency, retries, and limits

Once a buyer opts into fixed fees on a seller, requests sharing that buyer's
payment channel are serialized, including its inference requests, to prevent
concurrent requests from consuming the same reserve headroom. Already-running
requests drain before the first fixed-fee request. Other buyers are independent.
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
completed entries; unresolved entries are not evicted to make room. This is not
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

After building the SDK, run `node scripts/check-response-fee-compatibility.mjs`.
It loads the frozen pre-change metadata decoder, validator, buyer request handler,
and image billing calculator from commit `172e4fc986484c9c1adbbfccd076427850dd57c7`
through `git show` (the commit must be present in local history). It verifies the
new signed offering with the old decoder, detects signature tampering, and runs
an old image request against a mixed-service metadata/transport fixture: two
$0.04 images still cost 80000 micro-USDC with a v1 `output_images` report.

The seller tests separately exercise legacy-capability image requests and
unchanged image charges/concurrency on the updated mixed seller. These fixtures
do not replace live-chain settlement or verification of Levanto's private backend.
