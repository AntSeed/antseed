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

## Validation notes

Use Node 20 for this snapshot's native dependencies. The machine's default Node
26 installation failed to install `better-sqlite3`; Node 20.17.0 installs it.
The original proxy has an independently reproduced failing test:
`conversation routing keeps the actual peer as a soft preference and fails over when needed`.
This is not repaired as part of route eligibility.

No P2 work, upstream merge, push, or competitor integration is included.
