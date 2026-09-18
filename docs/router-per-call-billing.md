# Fixed-price routing with simple acceptance checks

Per-call is a billing mode, not a new funding method. It uses the existing
payment-channel authorization and settlement path. No new contract, migration,
acceptance message, refund system, or automatic paid retry is introduced.

## The rule

Authorize one advertised fixed fee only after all three checks pass:

1. The classifier response is complete and HTTP 2xx.
2. The router plugin can parse it into a nonempty list of model-only or exact
   model/seller recommendations.
3. Every exact pair belongs to the host's eligible candidate snapshot, and
   every model-only recommendation has at least one eligible seller there for
   that request. The snapshot includes pricing, trust, capabilities, cooldown,
   and router policy checks and is separate from the plugin's mutable copy.

There are no quality scores, required forecasts, subjective satisfaction checks,
or universal router preferences. A later inference failure does not invalidate
a classification that already passed these checks. The host rechecks routes
against current policy before forwarding inference; acceptance uses the original
routing request's candidate snapshot, not a promise of continued availability.

Reusing a routing decision without invoking the classifier authorizes no new
classification fee. Calling the classifier again is a new billable operation,
even if it selects the same model. Inference charges remain separate.

## Shared unit measurement

The shared unit-billing helpers consume normalized request attributes and
`UnitBillingContext.unitLimits`, not image-specific request objects. Image parsing
stays at the API-format boundary; `estimatedPromptTokens` is kept separately for
existing usage attribution. `extractUnitResponseUsage` accepts a unit-limit map
and optional billable-unit list; `computeFinalUnitBilling` takes the billing model,
context, and response. The helpers emit the applicable measured units directly.
Image and per-call prices, usage reports, and payment encoding are unchanged.
Token prices still use the separate `computeCostUsdc` path.

## One parser, before payment

The shared hook is `context.invokeService(messages, parseResponse)`. The parser
is mandatory for per-call routing and optional for token-priced routing. It is
synchronous and should be pure: it returns routes or throws. It must not perform
network requests or invent a fallback when a response cannot be parsed.
Prepayment validation uses this parser only in per-call mode; token-priced
routing retains its existing billing behavior.

The private classifier plugin returns `{ "serviceId": "model-x" }` as the JSON string
in `choices[0].message.content`. Its exported parser checks that envelope and
returns one model-only recommendation, leaving seller selection to the host:

```ts
import { parseClassificationResponse } from '@antseed/router-classifier';

const parseResponse = (response: SerializedHttpResponse) =>
  parseClassificationResponse(response, context.candidates ?? []);

const response = await context.invokeService!(messages, parseResponse);
return parseResponse(response);
```

The plugin owns vendor-specific parsing and model-ID mapping. AntSeed compares
the parsed routes with its private candidate snapshot; the plugin cannot expand
that snapshot by modifying `context.candidates`.

Internally the host supplies `routingAuthorization.validateResponse` to the SDK.
The buyer request handler runs it on a copy of the response before recording
billable observed usage or signing SpendingAuth, including after initial 402
payment negotiation. Only a synchronous `true` accepts. Exceptions, false,
missing validators, and cancellation cannot authorize the per-call fee. Raw
parser exceptions are replaced with a generic classification error.

The shared `successful_requests` unit still meters completed HTTP 2xx responses;
the routing acceptance check is an additional buyer-side requirement, not a
vendor-specific definition embedded in the generic unit calculator.

## Configuration

A classifier provider advertises the routing capability, zero token rates,
and a fixed unit price for the requested protocol:

```ts
provider.pricing = {
  defaults: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 },
};
provider.serviceCapabilities = {
  classifier: { routing: true },
};
provider.serviceUnitBillingModels = {
  classifier: {
    'openai-chat-completions': createPerCallBillingModel('5000'),
  },
};
```

`5000` micro-USDC is USD 0.005. Amount strings must be canonical unsigned
integers within uint32 bounds. Pricing is encoded exactly in micro-USDC; no
synthetic token counts are needed. Forecasts and token usage can be absent.

Seller configuration expresses the capability as
`service.capabilities.routing: true`. The buyer rejects classifier offers
without it and excludes routing-capable services from inference listings and
candidates, regardless of service name. Metadata v13 carries this field;
ordinary announcements without it remain v12, with v10–v12 wire baselines
unchanged. Routing capability cannot be encoded by downgrading to v12.

Buyer configuration:

```json
{
  "buyer": {
    "routingMode": "router",
    "routingPreferences": { "routerEnabled": true },
    "routingService": {
      "routerKey": "instance:my-router",
      "peerId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "provider": "openai",
      "serviceId": "classifier",
      "billing": { "kind": "per_call", "maxAmountMicroUsdc": "5000" },
      "allowPromptSharing": true,
      "maxAdditionalAuthorizationUsdc": "5000",
      "maxRequestsPerMinute": 10,
      "maxInputBytes": 4096,
      "maxOutputTokens": 64
    }
  }
}
```

AntSeed authorizes the exact advertised fee, not the full configured allowance.
The fee must fit both caps. Mixed token charges and fixed routing fees are
rejected. Without `billing`, existing token-priced routing remains the default.
This does not add a desktop billing selector or automatically convert any
private vendor billing implementation into a per-call service.

Send `x-antseed-routing-mode: router` to classify a request with any model or
without a model. Alternatively, `model: "antseed"` follows the saved
conversation/session mode. Concrete model requests remain fixed without the
router override, even when `buyer.routingMode` is `router`;
`x-antseed-routing-mode: model` explicitly bypasses classification.
The private classifier plugin returns `{ "serviceId": "model-x" }` in its
chat-completions message content, not a list of routes.

Unit billing is checked for the requested API protocol rather than unrelated
protocols advertised by the same service. Seller preflight includes the
`successful_requests` unit in its fixed-fee reserve estimate. The SDK rejects
streaming requests with `routingAuthorization`; ordinary inference streaming
remains supported after classification.

## Invalid responses: stop safely, do not pay to unblock

A seller that returns an invalid classification with HTTP 200 may already have
recorded that response as delivered spend. The buyer refuses to authorize it.
The seller's existing payment gate can then refuse subsequent requests on the
same channel until that disagreement is resolved. AntSeed must not pay the
invalid fee as a catch-up payment merely to make the next request work.

This implementation deliberately preserves that safe stop rather than adding
a new dispute/rejection/recovery protocol. Providers should validate their
classifier output and return non-2xx for malformed results or no valid route
before recording a successful request. Buyer validation remains the backstop.
Automatic recovery from a disputed invalid-200 response is not implemented.

The host uses configured policy-safe fallback or reports routing failure. No
automatic paid retry follows an invalid classification. Duplicate invocations
for one parent request reuse the same in-process operation; this is not durable
exactly-once behavior across restarts. Dedicated routing sellers and the
distinction between spending authorization and reserved collateral remain.

Reserve recovery may replay an existing authorization but does not advance
cumulative spending to pay an unaccepted classification. Optional reserve
top-up failures after payment do not discard an accepted classification that
has already been paid. Neither behavior authorizes disputed catch-up fees.

## Tests

- Unit price precision, metadata advertisement/round-trips, exact fee caps, and
  independent image/token pricing regressions.
- SDK validation-before-observation-before-authorization, missing validators,
  malformed results, cancellation, response-copy isolation, and 402 negotiation.
- Host parser requirements, candidate snapshot isolation, invalid model/peer
  selection, configuration loading, and duplicate calls without extra fees.
- Payment manager observed-delivery checks, overcharge rejection, and racing
  buyer/seller authorization paths.
- Isolated-chain fixtures exercise successful classifications, reuse, HTTP
  errors, invalid classifications, rejection of catch-up fees, and settlement:

```sh
pnpm --filter @antseed/e2e run flow:local-chain-routing
pnpm --filter @antseed/e2e run flow:local-chain-routing --per-call
pnpm --filter @antseed/e2e run flow:local-chain-routing --per-call --invalid-route
```

Use the repository's pinned Node 24 runtime and matching native dependencies. The two per-call
scenarios distinguish malformed JSON from a parseable but unadvertised model.
Each settles five accepted classifications at 5,000 micro-USDC each; the rejected
classification, HTTP error, blocked retry, and reused decision add no fee.

The fixture plugin reuses the accepted route for a tool continuation, then
classifies again when the latest user text changes, including after a context
rewrite. A refresh header alone does not invalidate reuse.
Those accepted classifications are charged even when the selected model stays
the same. See `router-network-integration.md` for the plugin-controlled policy.
