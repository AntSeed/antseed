# Levanto paid routing service

`@antseed/provider-levanto` contains a thin seller adapter and a buyer router
adapter. The seller alias is `levanto`; the buyer alias is `levanto-router`.
The plugin loader selects the appropriate export from the same package.
Levanto's backend owns the routing algorithm. The buyer adapter translates its
recommendations and uses AntSeed's existing inference execution.

The plugin relays and validates routing JSON. AntSeed core handles the reserve,
per-response spending authorization, and settlement. No payment contract,
day-pass callback, or payment database belongs in this plugin.

## Backend prerequisite

The request/response shape is based on `model-routing-clean-v2` in
`levantolabs/antseed-levanto-router`. That branch is a buyer client, not the
private Levanto backend. This adapter requires a backend that accepts
`POST /_antseed/route` using a seller-owned bearer API key and returns a complete
recommendation **without day-pass renewal**. `renewalDue`, errors, empty rankings,
and malformed success responses are rejected and do not earn a fixed fee.

Live compatibility with the private backend has not been verified. Its
authentication and per-response mode must be confirmed before deployment.

## Buyer setup

Use the matching SDK and CLI from this change, with the plugin installed:

```bash
export ANTSEED_MAX_ROUTING_FEE_MICRO_USDC=1000
antseed buyer start --router levanto-router
```

Send a messages-style inference request with `model: "levanto-auto"` (or the
`antseed` automatic alias). Concrete models and explicit user pins retain the
existing inference path without purchasing a recommendation. The buyer role
does not require `LEVANTO_BASE_URL` or `LEVANTO_API_KEY`.

`LEVANTO_SELLER_PEER_ID` optionally restricts the routing-service seller;
otherwise the adapter chooses the cheapest compatible advertised offer within
the fee cap. `ANTSEED_MAX_ROUTING_FEE_MICRO_USDC` is required and has no default;
the example's 1000 is a buyer limit, not a default or the amount automatically
charged. The seller's exact advertised fee is charged for an accepted response.
`LEVANTO_CQT` accepts 1, 3, 5, 7, or 9 and defaults to 5. Existing
local-router reputation, pricing, failure, and staleness policies also apply.
The buyer hook additionally enforces `buyer.routingPreferences.maxInputUsdPerMillion`
(CLI default: 25) against discovered inference input prices. This is an existing
AntSeed preference, not the recommendation price. The adapter sends eligible peer
IDs to Levanto; the buyer checks the returned model/peer against its eligible offers.

The buyer calls the routing service through normal `sendRequest`. Its acceptance
callback parses Levanto's response and requires an eligible inference destination
before authorizing the fee. Estimated prices returned by Levanto do not establish
the actual inference price. The original messages, tools, and streaming settings
then go through normal inference execution against the selected seller/model.

The buyer tries eligible ranked destinations in order, without another routing
purchase. Each inference attempt starts from the original payload with a new
billing request ID and freshly checked buyer policy, availability, and required
verification. Explicit retryable responses (401, 403, 429, 500, 502, 503) can
advance to the next destination, but buyer-attributed errors, payment-required
responses, HTTP timeouts (408/504), ambiguous transport failures, cancellation,
and started streams stop fallback. Exhausting the list returns an error; the
buyer never adds an unlisted model or switches routers. Each exact destination
is attempted at most once per inference request. Already-incurred inference
charges are not refunded by fallback.

The shared buyer hook also accepts model-only recommendations and orders eligible
sellers using the existing buyer policy. Levanto's current contract still requires
both `model` and `peer`; its plugin owns any future vendor-format changes.

Recommendations are reused for unchanged latest user text within the same
identified conversation, subject to current eligibility. The cache is in memory
and bounded to 500 conversations. Unidentified conversations route each request.
There is no day-pass logic, usage-observation ledger, UI, or
reasoning-capability metadata. Router-added reasoning overrides fail closed until
the selected seller's exact supported choices can be verified. The original
client's inference parameters are preserved by normal request adaptation.

This initial adapter accepts `messages` with user text, not Responses API `input`.
Unsupported input fails before a paid routing call. Routing failures do not
silently switch to another router. An accepted recommendation is billed even
if the subsequent, separately billed inference fails.
Routing charges are included in the originating conversation's spend, including
late authorization and inference-failure cases. They do not add inference tokens
or count as another inference request. Requests without a tracked user conversation
remain billed normally without creating a synthetic chat.

## Seller setup

Build and use the matching SDK/provider packages from this change. An older
SDK does not implement fixed-fee service payments. Once the package is published,
install it with `antseed plugin add @antseed/provider-levanto`.

```bash
export LEVANTO_BASE_URL=https://your-levanto-backend.example
export LEVANTO_API_KEY=your-seller-api-key
export ANTSEED_REQUEST_PRICE_MICRO_USDC=1000

antseed config seller add-provider levanto --plugin levanto
antseed config seller add-service levanto levanto-route --input 0 --output 0
antseed seller start --provider levanto
```

The normal seller registration, staking, and payment configuration are still
required. The zero token prices above are not the service price: the only fee is
`ANTSEED_REQUEST_PRICE_MICRO_USDC` (1000 means $0.001 per fulfilled response).
Use precisely `levanto-route`; this plugin does not implement aliases or a
configurable inference catalog.

| Setting | Required | Meaning |
| --- | --- | --- |
| `LEVANTO_BASE_URL` | Yes | Backend base URL; no production default |
| `LEVANTO_API_KEY` | Yes | Seller-owned backend bearer credential |
| `ANTSEED_REQUEST_PRICE_MICRO_USDC` | Yes | Nonnegative integer micro-USDC fee |
| `ANTSEED_MAX_CONCURRENCY` | No | Positive integer; default 10 |

Prices must round-trip exactly in micro-USDC through the existing signed
offering's float32 price field. An unrepresentable price is rejected, not rounded
to a different fee. Buyer credentials and AntSeed control headers are not
forwarded to the backend. Upstream failures are not retried automatically.

## Buyer usage

Given a started buyer `AntseedNode` with payments enabled and a discovered `peer`:

```ts
import { randomUUID } from 'node:crypto';
import { resolveFixedFeeOffer, FIXED_FEE_CONTRACT_HEADER, FIXED_FEE_PRICE_HEADER } from '@antseed/node';
import { LEVANTO_ROUTING_CONTRACT, LEVANTO_ROUTING_PATH, validateFixedFeeResponse } from '@antseed/provider-levanto/contract';

const payload = {
    v: 1,
    cqt: 5,
    inputMessage: 'Help with a TypeScript task',
    promptTokens: 10,
    expectedCachedTokens: [],
    constraints: {},
};
const offer = resolveFixedFeeOffer(peer.metadata?.offerings, 'levanto', 'levanto-route');
if (offer.contract !== LEVANTO_ROUTING_CONTRACT) throw new Error('Unsupported Levanto contract');
const response = await buyer.sendRequest(peer, {
  requestId: randomUUID(), method: 'POST', path: LEVANTO_ROUTING_PATH,
  headers: {
    'content-type': 'application/json', 'x-antseed-provider': offer.provider,
    [FIXED_FEE_CONTRACT_HEADER]: offer.contract, [FIXED_FEE_PRICE_HEADER]: offer.priceMicroUsdc,
  },
  body: new TextEncoder().encode(JSON.stringify({ ...payload, service: offer.service })),
}, {
  fixedFee: offer, maxFeeMicroUsdc: '1000',
  acceptResponse(response) {
    validateFixedFeeResponse(offer.contract, JSON.parse(new TextDecoder().decode(response.body)), payload);
    return true;
  },
});

if (response.statusCode !== 200) throw new Error(`Routing failed: ${response.statusCode}`);
const recommendation = JSON.parse(new TextDecoder().decode(response.body));
```

`cqt` must be 1, 3, 5, 7, or 9. Recommendations contain `v`, `router`, and a
nonempty `ranked` array with `model`, `peer`, `estimate`, and `price` fields.
This SDK-only example purchases a structurally valid recommendation without
executing inference. The `levanto-router` integration additionally requires an
eligible destination under the buyer's actual pricing, trust, and peer policy
before authorizing the fee and executing inference. The backend's predicted
prices and claimed recommendation quality are not trusted as payment evidence.

Existing image/chat buyers continue using their existing interfaces. They do
not see `levanto-route` in inference lists and need no upgrade unless they want
to purchase recommendations. There is no new desktop integration or UI in this change.

See `docs/protocol/fixed-fee-services.md` for the payment and retry rules.
