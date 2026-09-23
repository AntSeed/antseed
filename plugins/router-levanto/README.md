# Levanto buyer router

`@antseed/router-levanto` is a buyer-only plugin. It asks a selected AntSeed
routing-service peer for ranked recommendations, then uses normal AntSeed
inference execution. The registry alias is `levanto-router`.

The remote recommendation endpoint is `POST /_antseed/levanto-route`. This is
separate from the generic local `/_antseed/route` control API, which changes the
buyer's selection rather than purchasing a recommendation.

Levanto operates its own seller integration and private backend outside this
repository. This package does not host their service, forward backend credentials,
or require `LEVANTO_BASE_URL` / `LEVANTO_API_KEY`. Seller-to-backend authentication
is not part of the buyer interface. Generic completed-request transport remains unchanged.

## Select the router

Install the matching SDK/CLI and this plugin. Once published:

```bash
antseed plugin add @antseed/router-levanto
antseed config buyer set selection '{"kind":"router","service":{"peerId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","provider":"levanto","serviceId":"levanto-route"},"preferences":{"cqt":"5"}}'
export ANTSEED_MAX_ROUTING_FEE_MICRO_USDC=1000
antseed buyer start --router levanto-router
```

Replace the example peer ID with the selected routing-service peer's actual ID.
The buyer never substitutes another routing-service peer because it is cheaper.
The selected peer must advertise a compatible `levanto-routing-v1` completed-request
offer. `ANTSEED_MAX_ROUTING_FEE_MICRO_USDC` is a required buyer limit, not a price.

This is a limitation of the current Levanto payment adapter, not a requirement
of the generic router interface. Routing selects an inference destination;
billing determines how a remote service is paid. The adapter currently does not
support selecting token-based or other billing modes for the recommendation.

`LEVANTO_SELLER_PEER_ID` can provide the default routing-service target when
`buyer.selection.service` is not set. Otherwise select the target through
configuration or the local route endpoint; there is no cheapest-peer default.
The remaining plugin settings are the existing local-router policy settings.

In router mode, messages-style requests using `model: "antseed"` or
`model: "levanto-auto"` use the selected router, ignoring an old fixed-model
default. System-proxy-marked connected-app requests also use the selected mode,
not their connect-time model. Explicit client model choices and user conversation
pins remain overrides. Automatic conversation affinity is not a user pin.

Choose model mode to stop using the router:

```json
{ "kind": "model", "model": "your-model" }
```

The buyer plugin requires `messages` containing user text. Responses API `input`
is not supported by this adapter. Failures do not silently switch routers.

## Live selection and generic preferences

`buyer.selection` stores either a model or a routing-service target and its
preferences. Config changes are watched while the buyer runs. The local control
API also supports changes without restarting:

```http
POST /_antseed/route
Content-Type: application/json

{
  "selection": {
    "kind": "router",
    "service": {
      "peerId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "provider": "levanto",
      "serviceId": "levanto-route"
    },
    "preferences": { "cqt": "9" }
  }
}
```

`GET /_antseed/route` returns the current selection. The existing `{ "model":
"your-model" }` update remains supported and selects model mode. Selections are
saved in `buyer.state.json`. Updating selection cancels in-flight router-directed
requests and invalidates cached decisions. Explicit state selections survive
restart; a changed config selection is applied by the running config watcher.

`GET /_antseed/router/metadata` exposes the loaded plugin's generic schema,
schema hash, selection and effective preferences for a future UI. No new desktop
controls are included. For Levanto, the schema is:

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "cqt": {
      "type": "string",
      "enum": ["1", "3", "5", "7", "9"],
      "default": "5",
      "description": "Cost/quality preference"
    }
  }
}
```

The shared enum validation/hash machinery follows the former routing PRs 3/5:
router-defined flat string choices, optional defaults/descriptions/required fields,
unknown-value rejection, and a 16 KiB schema/value bound. It is not a global CQT
enum. `Router.routingMetadata` supplies the installed plugin's descriptor;
`RouteSelectionContext` carries current effective preferences, its schema hash,
and the selected service. Levanto converts the string choice to its numeric
backend `cqt`. `LEVANTO_CQT` is replaced by these live preferences.

This descriptor comes from the installed plugin, not unsigned seller HTTP data.
This change does not reintroduce metadata v13 or claim remote schema negotiation.
The Levanto wire request retains its existing fields; no new backend schema is
required for enum preferences or exact-candidate filtering.

## Per-conversation router settings

Each existing conversation can save its own routing-service peer and preferences
through the local control API:

```http
POST /_antseed/conversations/update
Content-Type: application/json

{
  "id": "vpr:your-session-id",
  "routingSelection": {
    "kind": "router",
    "service": {
      "peerId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "provider": "levanto",
      "serviceId": "levanto-route"
    },
    "preferences": { "cqt": "9" }
  }
}
```

Use the actual conversation ID from `GET /_antseed/conversations`. The response,
conversation list, and individual conversation GET include `routingSelection`.
Overrides persist in `conversations.json` and survive buyer restart. Existing
conversations without this field inherit the buyer-wide selection.

An override requires an explicit routing-service target. Preferences are validated
against the loaded plugin's schema; omitted preferences use schema defaults, not
another chat's or the buyer's preferences. The peer must be supported by that
installed plugin. This selects an external service, not a different installed
plugin. An unavailable plugin or incompatible preference schema fails routing
rather than silently falling back to the buyer default.

To remove the override and follow the current buyer default again:

```json
{ "id": "vpr:your-session-id", "routingSelection": null }
```

Selecting a chat router clears its previous model/seller pin. Setting a new
explicit user model/seller pin replaces the router override. Update only one of
`routingSelection` and `pinnedModel` in a request. Explicit model/peer choices on
inference requests remain overrides; automatic affinity does not override the
chat router. Buyer-wide inference-peer pins do not replace an explicit chat router.

Child/subagent requests inherit their parent chat's selection while maintaining
separate cache observations. Changing a chat override cancels that chat's ongoing
router-directed requests, including its children, but not other chats. Changing
the buyer-wide selection does not cancel requests using explicit chat overrides.
No additional desktop controls are included.

## Recommendation filtering

The buyer's existing price, trust, peer-policy, availability, protocol and required
parameter checks produce exact eligible model/peer/provider candidates. The plugin
continues to send only their eligible peer IDs in `constraints.allowedPeerIds`.

The response must have a valid v1 envelope and at most 512 ranked entries.
Malformed or unsupported entries, disallowed peers, and ineligible model/peer
combinations are removed individually. Remaining entries keep their original
order. A peer having one eligible model does not make its other models eligible.
An invalid envelope or no usable destination fails before response acceptance.
Unsupported inference overrides are rejected as a whole candidate, not stripped.
The backend's predicted prices are not authoritative inference prices.

The existing executor deduplicates destinations, rechecks eligibility and required
verification before each inference attempt, and tries remaining ranked destinations
on explicit retryable failures. Cancellation, buyer faults, payment-required
responses, timeouts, ambiguous transport failures and started streams stop fallback.
Neither an unlisted inference destination nor another routing peer is substituted.

## Cache observations

After a successful completed inference, the host reports native input/cache usage
through `Router.recordUsage`, before client-protocol conversion. Routing-service
calls, failures, cancelled requests, estimated usage and unidentified conversations
do not contribute observations. Streaming usage is recorded from the completed
response, not once per chunk. Child conversations are separate from their parents.

Levanto estimates cache warmth using its existing behavior: cached/input ratio,
EMA weight 0.5, previous-prompt and current-prompt caps, and three-minute expiry.
Observations are scoped by conversation, peer, provider and model. Duplicate
request observations are ignored; memory is bounded to 500 conversations, 64
offers and 512 recent request IDs per conversation. Only currently eligible
candidates contribute `expectedCachedTokens`. Ambiguous providers for the same
model/peer use the conservative minimum estimate.

This is independent from decision reuse: unchanged latest user text can reuse
eligible recommendations within a conversation. Target, preferences or schema
changes invalidate reuse. No decision database, daily digest or savings UI is
added.

## External service compatibility

Routing and billing are separate. The seller's `serviceExecution` descriptor
defines the routing endpoint and response validator; `serviceUnitBillingModels`
separately selects how to charge. `levanto-routing` identifies the API format,
not its billing unit. The current Levanto integration supports
`completed_requests`: an accepted routing response counts as one unit, whether it
contains one or five recommendations. A price of zero makes that service free.
This does not make every router a paid service. Token-priced routing would need
real backend token measurements; predicted inference tokens are not such usage.

The SDK uses the same unit-cost evaluator and cumulative payment channel as image
billing, but a different measurement adapter. Images measure `output_images`;
routing measures accepted `completed_requests`. The SDK supplies provider and
service-contract headers; no unit-price header is sent. The buyer keeps the
selected advertised price and maximum locally. A seller price change after
discovery can therefore cause a payment disagreement after execution, but cannot
automatically increase the buyer's authorization. See
`docs/protocol/unit-billing-services.md` for provider configuration.

`levanto-routing-v1` is this integration's versioned request/response schema name,
not a blockchain contract or a pricing mode. Upgraded buyers and sellers opt into
completed-request billing. Existing token/image buyers keep their current formats
and cannot accidentally buy routing as inference.

The external seller must implement the advertised Levanto routing contract and
accept `POST /_antseed/levanto-route` with `service: "levanto-route"`, `v`, numeric `cqt`,
`inputMessage`, `promptTokens`, `expectedCachedTokens`, and `constraints`.
The seller must configure its advertised service's endpoint to match this path;
the buyer does not retry the former remote `/_antseed/route` path.
Success responses contain `v: 1`, a nonempty `router` identifier and `ranked`
entries with `model`, `peer`, `estimate`, and `price`. Day-pass renewal responses
are not accepted by this per-response contract.

`service` identifies the advertised AntSeed offering that the seller dispatches
and bills. `model` in a ranked recommendation identifies the proposed downstream
inference model. They refer to different purchases. AntSeed's seller dispatcher
accepts `service` or falls back to `model`, but this plugin's routing request
schema uses `service`; it does not request inference from a model named
`levanto-route`.

Local tests verify the buyer contract and host integration. Live compatibility
with Levanto's privately operated service still requires an authenticated smoke
test against their actual AntSeed peer; no private backend credentials are needed
by this buyer package.
