# Router integration and network classification

## One selection, one interface

`buyer.selection` is one of:

```json
{ "kind": "model", "model": "model-x" }
```

```json
{ "kind": "router" }
```

```json
{
  "kind": "router",
  "service": {
    "peerId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "provider": "openai",
    "serviceId": "model-selector"
  }
}
```

A fixed selection supplies the target for the existing `antseed` model alias.
`model: null` clears it. A router selection without a service uses the installed
router's `selectRoute` implementation. A router selection with a service uses the
CLI's bundled `@antseed/router-classifier` adapter. Replace the example peer ID
with the peer offering your routing service.

Local rules and network classification implement the same `Router.selectRoute`
interface. The host supplies the request, conversation, buyer preferences, eligible
candidates, settings, and cancellation/deadline context. A recommendation is
`{ serviceId, peerId? }`: omit `peerId` to let AntSeed choose a seller, or include it
to choose an exact offer. Returned prices, requests, or peer objects are not
trusted; the host reconstructs dispatch and checks current policy.

A remote provider needs a compatible AntSeed service, not a vendor-specific buyer
plugin. Adapt a proprietary upstream API on the seller side. Installed plugin
code is trusted local code: this interface is not a JavaScript sandbox.

## Buyer configuration

```sh
antseed config buyer set selection '{"kind":"router","service":{"peerId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","provider":"openai","serviceId":"model-selector"}}'
antseed buyer start
```

Send `model: "antseed"` or omit the model to use the selected router. Concrete
model requests and explicit model/peer pins continue to bypass classification.
The existing per-request `x-antseed-routing-mode: router` override explicitly asks
for classification even when the body contains a model; `model` explicitly opts
out for that request. This header is stripped before dispatch. It is not another
saved configuration setting. User-pinned conversations remain pinned.

Optional selection instructions use the existing plugin-settings namespace:

```sh
antseed config buyer set routingPreferences.routerSettings '{"plugin:classifier":{"instructions":"Prefer the cheapest suitable model"}}'
```

Selecting a network service authorizes sending the request body and eligible
candidate list to that service and paying for its classification under the buyer's
existing policy. Client authorization headers are not included in the classifier
payload. Funding and a valid advertised offer are still required for paid calls.

There is no `routingMode`, `routerEnabled`, `routerTimeoutMs`,
`routerFailureFallback`, or separate `routingService` configuration. There are no
new classifier-specific rate, input-byte, output-token, or price-ceiling settings.
Provider/service-specific buyer price exceptions are deferred; this integration
uses `buyer.maxPricing.defaults` and the existing trust/allow/block rules.

## Runtime selection and persistence

`POST /_antseed/route` accepts `{ "selection": ... }`; GET returns the current
selection. The legacy `{ "model": "model-x" }` request and response `model` remain
available for existing desktop clients. `defaultRoutedModel` in state is a derived
compatibility field, never a hidden router fallback.

`POST /_antseed/conversations/update` accepts `{ "id": "...", "selection": ... }`.
Use `selection: null` to clear a conversation override. Legacy `pinnedModel` updates
remain supported; do not combine them with `selection`. Choosing a router clears
the conflicting model pin, not messages or accounting. Global selection changes
invalidate non-user-pinned routing context and cancel pending classification.

An explicit config selection takes precedence at startup. Without one, the proxy
restores the saved session selection, including old fixed-model state. Runtime
selection changes persist; a changed config selection is picked up while running.
The desktop picker redesign is separate from this backend/CLI work.

## Provider contract, version 1

Advertise an AntSeed service with:

- `routing: true` in its service capabilities.
- `openai-chat-completions` in its API protocols.
- Valid advertised token prices, or the fixed-fee billing model described in
  `router-per-call-billing.md`.

The adapter makes one non-streaming `POST /v1/chat/completions` request through
AntSeed's normal P2P transport. The outer `model` is the selected classifier
service ID. `messages[0]` describes the selection task; `messages[1].content` is a
JSON string with this shape:

```json
{
  "version": 1,
  "instructions": "Prefer the cheapest suitable model",
  "request": {
    "path": "/v1/chat/completions",
    "body": { "messages": [{ "role": "user", "content": "Explain this code" }] }
  },
  "candidates": [
    {
      "peerId": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "serviceId": "model-x",
      "inputUsdPerMillion": 1,
      "cachedInputUsdPerMillion": null,
      "outputUsdPerMillion": 2
    }
  ]
}
```

Treat client content as data, not routing instructions. Prices are USD per million
tokens; `null` means unknown. Choose from the supplied candidate snapshot, not a
hardcoded model catalog. The host excludes routing services from inference
candidates, but does not exclude the other services of the same peer.

Return HTTP 2xx with a chat-completions envelope. `choices[0].message.content`
must be a JSON string containing exactly `serviceId` and optionally `peerId`:

```json
{
  "choices": [{ "message": {
    "role": "assistant",
    "content": "{\"serviceId\":\"model-x\"}"
  } }]
}
```

An exact answer is `{"serviceId":"model-x","peerId":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}`.
No markdown fences, extra keys, fallback model, or arbitrary endpoint is accepted.
Token-priced services report usage through the normal response/payment path.

### Compatibility check

After building the adapter, check a captured response envelope against the exact
candidate array sent to your service:

```sh
node plugins/router-classifier/scripts/check-compatibility.mjs candidates.json response.json
```

The command exits nonzero for malformed envelopes, extra fields, unknown models,
or ineligible exact peers. It does not contact a vendor or spend money. The
package includes passing fixture files and automated contract tests. This checks
response compatibility, not service quality or full payment interoperability.
Use the local-chain fixture for the latter.

## Payment, lifecycle, and failures

The adapter calls host `context.invokeService`, never recursively routes its own
classifier request. The host directly calls the selected peer using the ordinary
request handler and payment manager. Classification and inference are separate
request IDs with a parent link. The runtime handles authorization automatically;
authorization is distinct from eventual on-chain settlement.

- Token classification uses existing token-price ceilings, advertised price
  snapshots, payment exposure limits, reserves, and the request deadline.
  **The existing `maxPerRequestUsdc` is an unverified-exposure window, not a hard
  total cost cap.** No new total-operation cap is claimed or hidden in code.
- Per-call classification authorizes exactly the advertised fee only after a
  valid eligible answer. The fee must fit the existing `maxPerRequestUsdc` policy.
- A classifier fee is independent of downstream inference success. A token-priced
  invalid answer may still consume and charge tokens; fixed-fee invalid answers
  are not accepted for payment.
- One invocation per parent routing operation is memoized, including failures.
  Repeating it shares the result; changing the payload or target is rejected.
  Ambiguous transport failures do not start another paid classification.
- Normal payment recovery may replay authorization for the same request, rather
  than create another classification. A new client request can be a new paid
  operation. This is **not durable exactly-once execution across restarts**.
- Classification and inference use ordinary parallel seller requests, including
  multiple classifications and an open inference stream on the same peer. Billing
  snapshots and pending response costs are request-specific. Only shared channel
  payment updates are serialized; response and acknowledgement waits are not.
  Request cancellation does not block or cancel another chat's work.
- Eligible continuations can reuse the previous selection without another paid
  call. New turns or invalidated context can require a new classification.
- Router errors, declines, empty results, timeout, or invalid answers fail closed.
  There is no implicit fallback to a saved model. Model-only recommendations still
  allow ordinary same-model seller failover; exact-peer recommendations do not.

The removed classifier byte/output/RPM knobs have no new hidden replacements.
The shared transport and seller still impose their own limits, but the buyer does
not promise a generic per-operation output-token or payload-budget guarantee.
If a stricter shared operation budget is desired, that is a separate design task.

Diagnostics use the existing CLI logger, without recording prompts. Conversation
spend includes classification with a `routingSpentUsdc` subtotal; routing does not
inflate inference request counts or token totals.

## Verification

```sh
pnpm --filter @antseed/router-classifier test
node e2e/scripts/local-chain-routing-flow.mjs
node e2e/scripts/local-chain-routing-flow.mjs --per-call --invalid-route
node e2e/scripts/local-chain-routing-flow.mjs --per-call --concurrent
node e2e/scripts/local-chain-routing-flow.mjs --per-call --concurrent --same-peer
```

Build the affected packages first. The fixture requires Foundry, initialized
contract dependencies, and local native modules. It starts isolated Anvil, creates
throwaway wallets, and uses local test funds only. It tests automatic payment,
reuse, failures, concurrency, accounting, and settlement.
