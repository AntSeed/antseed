# Shared unit billing and routing

## What gets counted

| Purchase | Measurement | Example |
| --- | --- | --- |
| Images | Delivered images, capped at the requested number | 2 × $0.04 = $0.08 |
| Completed requests | One accepted successful response, otherwise zero | 1 × $0.001 = $0.001 |
| Token inference | Existing input, cached-input and output usage | Existing token rates, unchanged |

A routing response with five recommendations is one completed request, not five
requests or five images. Predicted downstream tokens/prices are not routing usage.
The unit calculator and payment channels are shared; measurement differs.

## Provider configuration

API format and pricing are separate. A Levanto seller supplies `handleRequest`
and ordinary provider configuration:

```ts
services: ['levanto-route'],
serviceApiProtocols: { 'levanto-route': ['levanto-routing'] },
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

There is no `serviceExecution` map or separate execution-contract configuration.
The Levanto buyer plugin validates its `POST /_antseed/levanto-route` body and
the response, including `v: 1`, before accepting recommendations. The shared API
adapter only identifies the protocol. Providers are responsible for validating
their own API requests and returning non-success responses for rejected work;
the generic seller handler does not inspect Levanto's payload schema.

`1000` micro-USDC is 0.001 USDC; `'0'` makes the service free. The current Levanto
buyer supports completed-request pricing, not token-priced routing. Nonzero token
surcharges are rejected because the completed-request adapter does not measure
backend tokens. Supporting token-priced routing requires actual usage reporting.

## Request and payment flow

1. The seller advertises a signed offer identifying provider, service, API format
   and unit price. The buyer verifies it and applies its own maximum price.
2. The buyer sends the normal request with `unitBilling: offer` and a synchronous
   `acceptResponse` callback. Only literal `true` accepts delivery. The SDK adds the
   existing provider header; no unit-price or service-contract header is sent.
3. The seller checks capability and confirmed reserve, then executes. Initial
   pre-execution 402 negotiation uses the existing channel handshake and retries
   once. It does not prepay the routing charge.
4. The seller measures successful provider responses; the buyer additionally
   validates and accepts delivery. The shared calculator computes the charge;
   version-2 usage reports contain
   `{version: 2, units: {completed_requests: '1'}}` (or `'0'`).
5. The existing payment manager signs, persists and settles cumulative
   SpendingAuth. Failed, cancelled and rejected responses receive no buyer
   authorization; duplicate response/NeedAuth processing cannot charge twice.

Buyer price limits, channel correlation and exact charge validation remain.
A provider that returns HTTP success with an invalid payload can cause a seller
charge that the buyer refuses to authorize. Providers must validate their own
responses; buyer validation is not a substitute for seller-side validation.
A seller price change after discovery can cause disagreement after execution;
the buyer does not automatically increase its authorization or replay the work.

## Concurrency and retries

Routing uses ordinary request dispatch, without a separate seller queue, busy
guard or executed-request cache. Existing channel-close and payment checks stay
in place. Reserve checks do not reserve funds for in-flight work, so concurrent
requests can pass against the same remaining balance.

Ambiguous transport failures must not be replayed automatically: the seller does
not guarantee exactly-once provider execution. Buyer duplicate-charge protection
remains separate and uses request correlation and the durable channel store.

## Compatibility

Existing image-v1 metadata, prices, rounding and `output_images` reports are
unchanged. Token billing is unchanged. New completed-request purchases require
upgraded peers advertising `payments.completed-requests.v1`.

Discovery keeps signed metadata v12. Offers use
`unit-billing.v2:<provider>:<api-protocol>` with the existing per-request pricing
field; float32 prices must round-trip to the exact micro-USDC amount. Routing and
new billing modes stay out of legacy inference listings. Old buyers can still
buy existing token/image services from an upgraded mixed seller. Routing health
probes are skipped based on API format, not pricing.

The unreleased generic execution API and contract-based offering names are not
preserved. Buyers and sellers using those branch-only formats must upgrade.

## Verification

After building, run `node scripts/check-unit-billing-compatibility.mjs`. It loads
frozen pre-change code from `172e4fc986484c9c1adbbfccd076427850dd57c7` and checks
metadata signatures and legacy image billing: two $0.04 images still cost 80000
micro-USDC with a v1 usage report. Tests additionally cover schema validation,
price limits, acceptance, ordinary concurrency and mixed-service operation.
Live settlement and Levanto's private backend still need an authenticated smoke
test. See the router README for selection, fallback and conversation accounting.
