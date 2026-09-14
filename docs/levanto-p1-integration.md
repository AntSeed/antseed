# Router integration: P1 implementation

Baseline: Levanto `model-routing-clean-v2`, commit
`227046fdacc470c8d030534ab8e956a3b0272a73`. Work is isolated from AntSeed main.

## Host-owned eligibility

`selectRoute` results are recommendations, not executable requests. The proxy
resolves each returned peer ID and exact advertised service against its own
discovery state, reconstructs the request from the original client request,
and ignores plugin-supplied peer objects, prices, reputation, and request bodies.
Eligible results preserve the router's order; duplicates and cooling-down peers
are excluded. Required parameters and protocol compatibility remain authoritative.

Buyer `maxPricing.defaults` limits input, output, and cached-input prices;
`minPeerReputation` and routing-preference allow/block/trust rules are enforced
independently of optional router policy hooks. The preference ranking dial is
not reinterpreted as a hard price ceiling. Policy is checked after selection and
again before dispatch, including after asynchronous verification or retries.
Plugins receive copies rather than references to the host's request/discovery
state. This protects against accidental mutation, not malicious in-process code.

Forecasts are not required to select a route. Levanto's private prediction
response is unchanged; shared telemetry/configuration redesign is deferred.

## Deadline and failure contract

`null` means declined; an empty selection means unavailable; thrown errors mean
execution failed. The host never retries a selection. `buyer.routerTimeoutMs`
defaults to 10,000 ms and is capped by `buyer.requestTimeoutMs`. The optional
sixth `selectRoute` argument contains an abort signal and absolute deadline.
Disconnects cancel selection; timeouts abort and return `router_timeout` (504).
Other failures return a sanitized `router_unavailable` or `router_invalid_result`
(502). Late responses cannot dispatch inference. Plugins must honor the signal
before initiating side effects; an in-process timeout cannot undo a signature
or force-stop arbitrary plugin JavaScript.

Fallback defaults to `buyer.routerFailureFallback: "none"`. Explicit `"default"`
uses the existing concrete default model, optionally peer-pinned. It goes through
the same host validation, never another router call. No fallback on cancellation.
The host no longer passes its default to plugins for implicit fallback. Levanto
honors the host cancellation signal and distinguishes unavailable from declined.

## Activation is not billing consent

`buyer.routingPreferences.routerEnabled` controls model-router activation.
`selectedRouterPackage` identifies the plugin. `dayPassOnDemandEnabled` remains
only day-pass consent. Legacy preferences inherit activation from their existing
day-pass flag; explicit activation wins, and the existing `autoRouting: false`
pause is preserved. Enabling a router never grants new day-pass consent.

The desktop catalog, home/chat defaults and router selector use activation,
not consent. Only plugins declaring `dailyPassServiceId` receive day-pass copy
and confirmation. Granting day-pass consent requires an advertised price; generic
plugins can be enabled without buying a day pass. The price lookup matches the
active plugin's declared service instead of an arbitrary day-pass service.
Token-priced routing still requires separate host authorization.

## Metered routing authorization

The normal SDK request path accepts a host-only `routingAuthorization` option:
`parentRequestId` and `maxAdditionalAuthorizationUsdc` (decimal USDC base units).
It does not use `controlPlane` or the unmetered `/_antseed/route` handler.
Routing requests are non-streaming chat-completion service requests. A zero limit
does not negotiate a paid channel after a 402. Paid routing requires a running
buyer payment manager; successful responses complete normal post-response auth.

The payment manager binds a live grant to one seller, service, request ID, parent
request and cancellation signal. Only one routing operation can occupy a seller
at a time. Buyer and seller authorization paths serialize for routing sellers
and deduplicate response accounting, including both race orderings. Grant expiry
or cancellation prevents further signatures; day-pass signing cannot consume a
metered grant. Spend events carry `purpose: "routing"` and the parent request ID.

The limit bounds **additional signed SpendingAuth**, not advertised rates,
ReserveAuth collateral, or reversal of previously signed obligations. Existing
`maxPerRequestUsdc` still means unverified exposure. A protected routing seller
is dedicated to routing for this buyer process; use a different inference peer.
Do not mix routing and inference/day-pass traffic on that payment relationship.

## Host service adapter

The optional sixth argument also supplies `candidates` (eligible exact model/peer
pairs and advertised input/output prices) and `invokeService(messages)`. A plugin
can classify with a local algorithm, use its existing upstream, or call the
host-bound service. There is no required vendor and no forecast requirement.

Configure a dedicated routing seller explicitly in `config.json`:

```json
{
  "buyer": {
    "routingPreferences": { "routerEnabled": true, "dayPassOnDemandEnabled": false },
    "routingService": {
      "routerKey": "instance:my-router",
      "peerId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "provider": "openai",
      "serviceId": "route-classifier",
      "allowPromptSharing": true,
      "maxInputUsdPerMillion": 1,
      "maxOutputUsdPerMillion": 2,
      "maxCachedInputUsdPerMillion": 1,
      "maxAdditionalAuthorizationUsdc": "1000",
      "maxRequestsPerMinute": 20,
      "maxInputBytes": 16384,
      "maxOutputTokens": 128
    }
  }
}
```

Replace the example peer ID and instance with your actual installed instance;
start with `antseed buyer start --instance my-router`. For non-instance loading,
use `plugin:<router argument>` as the router key. Authorization does not transfer
when switching plugins or instances. The example's authorization increment limit
is 0.001 USDC per operation; the input/output rates are USD per million tokens.
Zero authorization permits only a free advertised service and does not buy a
day pass. Omission authorizes no host-mediated routing service.

The host fixes model, provider, peer, endpoint, output limit and identity headers.
Plugins supply only text messages. Explicit prompt-sharing consent is required.
One operation per inference request is cached for ten minutes: identical repeated
calls reuse the result; different input is rejected. Distinct calls are rate
limited. No application-level retries are made, including after 429s. Ordinary
SDK 402 negotiation remains part of the single metered request. Configuration
changes and shutdown abort active operations. Routing peers are excluded from
inference selection so their scoped payment authorization cannot be mixed.

`routing-operations.jsonl` stores operation status and separate signed-spend events
with request/parent IDs, never prompt contents. Match the IDs to sum authorization
deltas; do not mistake a response's reported usage, an authorization, and actual
on-chain settlement for three charges. Failed downstream inference does not erase
the cost of a routing classification that already completed.

## Validation notes

Use Node 20 for this snapshot's native dependencies. The machine's default Node
26 installation failed to install `better-sqlite3`; Node 20.17.0 installs it.
The original proxy has an independently reproduced failing test:
`conversation routing keeps the actual peer as a soft preference and fails over when needed`.
This is not repaired as part of route eligibility.

No P2 work, upstream merge, push, or competitor integration is included.
