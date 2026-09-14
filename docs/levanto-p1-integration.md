# Router integration: P1 implementation

This is the historical P1 snapshot. The completed P2 changes and test matrix
are documented in `docs/levanto-p2-integration.md`.

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
When cached-input pricing is absent, the ceiling check uses the normal input
rate, matching SDK billing; it does not invent a cached discount or a forecast.
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

The operation's remaining allowance survives channel rollover. Negotiated input,
output and cached-input prices may not exceed the host-approved advertised
snapshot. Failed persistence does not consume the allowance, and cancellation
during signing prevents that authorization from being committed or returned.

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

### Isolated local-chain routing fixture

Prerequisites: Node 20, pnpm dependencies, Foundry (`anvil`, `forge`, `cast`) and
the initialized `packages/contracts/lib/forge-std` submodule. Build the workspace,
then run from the repository root:

```sh
pnpm run build
pnpm --filter @antseed/e2e run flow:local-chain-routing
```

The fixture starts its own Anvil on a free loopback port and deploys test
contracts. It does not use an existing chain or real funds. It uses a
vendor-neutral fixture router, one token-priced classifier and a separate
inference seller. Discovery is injected locally; HTTP proxy handling, SDK/P2P
transport, authorization and settlement use the real implementation.

Assertions cover one classification and one inference, distinct request IDs,
parent-linked routing accounting, and actual on-chain settlement of **140
micro-USDC** for 100 input tokens at $1/million plus 20 output tokens at
$2/million. The fixture stops its nodes and Anvil and removes its temporary
identities on exit. Foundry's normal ignored build/broadcast artifacts remain.

Use Node 20 for this snapshot's native dependencies. The machine's default Node
26 installation failed to install `better-sqlite3`; Node 20.17.0 installs it.
### Vendor-neutral regression coverage

The proxy fixtures exercise selectors without forecasts, forged peer/request/
price data, unknown models and peers, buyer blocklists and trust constraints,
input/output/cached-input ceilings, required capabilities, cooldowns, and policy
changes while selection is in progress. Failure fixtures cover throws, empty or
malformed results, ignored cancellation, deadlines, explicit eligible fallback
and forbidden fallback. Activation tests keep enabling separate from consent.

Host-service fixtures check exact router-instance authorization, prompt consent,
seller/service binding, price and input limits, invalid advertised rates, free
versus paid authorization, one-operation deduplication, rate limits, cancellation,
separate IDs and prompt-free accounting. SDK payment tests cover both buyer/seller
authorization race orderings, mismatched/expired grants, day-pass isolation,
negotiated price increases, remaining allowance across channel rollover,
persistence failure and cancellation during signing. The local-chain fixture
complements these unit tests with actual settlement.

### Verification results (September 14, 2026)

- Full workspace build and workspace typecheck pass; desktop renderer typecheck
  also passes. Node 20 was used throughout.
- SDK: 1,053 tests pass. Buyer core: 11 pass. Levanto plugin: 92 pass.
- Desktop: 6 script tests and 371 main-process tests pass; renderer has 407
  passing tests and one baseline cooldown failure.
- CLI: the full suite has one baseline conversation-affinity failure. All added
  P1 cases pass. Under Node 20, the existing extensionless wrapper-test fixtures
  require `NODE_OPTIONS='--experimental-default-type=module --no-warnings'`.
  Clear inherited `FORCE_COLOR`/`NO_COLOR` for those stderr assertions and
  `ANTSEED_SYSTEM_PROXY_DATA_DIR` for desktop's default-directory assertion.
- The root recursive test command is not green: it stops at the existing web-SDK
  top-up-replay test and its resulting cleanup timeout.

The three remaining failures were reproduced using the corresponding baseline
implementation from `227046fdacc470c8d030534ab8e956a3b0272a73` in generated build
output, then restoring the P1 build output. These are focused baseline checks,
not a claim that an entire pristine baseline suite passes:

1. CLI: `conversation routing keeps the actual peer as a soft preference and
   fails over when needed` expects a cleared affinity but receives the prior pin.
2. Desktop renderer: `a distant cooldown still counts as cooling down` conflicts
   with the baseline cooldown implementation's upper bound.
3. Web SDK: `replays an ambiguously delivered top-up without trusting it after
   restart` expects a transport failure, but baseline deposit verification fails
   first against its test RPC configuration; cleanup then times out.

These failures are not repaired as part of P1. The original AntSeed checkout is
untouched. Changes are separate local commits on `codex/levanto-p1-local`.

P2 was deferred at the P1 checkpoint. Router-owned configuration/UI, optional
shared forecasts, honest savings records, routing cadence/context, operational
limits, and their tests are now implemented; see `docs/levanto-p2-integration.md`.
No upstream merge, push, or competitor integration is included.
