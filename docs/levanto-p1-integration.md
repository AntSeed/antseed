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

## Validation notes

Use Node 20 for this snapshot's native dependencies. The machine's default Node
26 installation failed to install `better-sqlite3`; Node 20.17.0 installs it.
The original proxy has an independently reproduced failing test:
`conversation routing keeps the actual peer as a soft preference and fails over when needed`.
This is not repaired as part of route eligibility.

No P2 work, upstream merge, push, or competitor integration is included.
