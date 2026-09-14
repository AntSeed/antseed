# Fixed-price routing with simple acceptance checks

Per-call is a billing mode, not a new funding method. It uses the existing
payment-channel authorization and settlement path. No new contract, migration,
acceptance message, refund system, or automatic paid retry is introduced.

## The rule

Authorize one advertised fixed fee only after all three checks pass:

1. The classifier response is complete and HTTP 2xx.
2. The router plugin can parse it into a nonempty list of exact model/peer routes.
3. Every returned route belongs to the host's eligible candidate snapshot for
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

## One parser, before payment

The shared hook is `context.invokeService(messages, parseResponse)`. The parser
is mandatory for per-call routing and optional for token-priced routing. It is
synchronous and should be pure: it returns routes or throws. It must not perform
network requests or invent a fallback when a response cannot be parsed.
Prepayment validation uses this parser only in per-call mode; token-priced
routing retains its existing billing behavior.

For example, a plugin whose classifier returns `{ "selected_model": "..." }`
can use this adapter (that payload format is only an example, not a protocol):

```ts
const parseResponse = (response: SerializedHttpResponse) => {
  const result = JSON.parse(new TextDecoder().decode(response.body));
  const selected = context.candidates?.find(
    (candidate) => candidate.serviceId === result.selected_model,
  );
  return selected
    ? [{ peerId: selected.peerId, serviceId: selected.serviceId }]
    : [];
};

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

A provider advertises zero token rates and a fixed unit price:

```ts
provider.pricing = {
  defaults: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 },
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

Buyer configuration:

```json
{
  "buyer": {
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
This does not add a desktop billing selector or convert Levanto's private
day-pass integration into a per-call service automatically.

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

Use Node 20 for the worktree's installed native dependencies. The two per-call
scenarios distinguish malformed JSON from a parseable but unadvertised model.
Each settles four accepted classifications at 5,000 micro-USDC each; the rejected
classification, HTTP error, blocked retry, and reused decision add no fee.

Validation on September 14, 2026: buyer-core/SDK/CLI builds and workspace
typechecks passed; SDK 1,168 tests passed, buyer-core 11 passed, Levanto plugin
106 passed. CLI 583 passed with the previously documented conversation-affinity
failure (`conversation routing keeps the actual peer as a soft preference and
fails over when needed`). All three local-chain scenarios passed. Desktop UI and
production deployment validation remain outside this billing change.
