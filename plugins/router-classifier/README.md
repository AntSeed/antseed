# Private classifier router

A privately installed router that chooses a model through an authorized AntSeed
classifier service. It is a usable plugin, not a demo or mock. It remains
`private: true`: not published to npm, bundled, or automatically installed.

## How it works

1. Explicit router mode asks this plugin to choose a model. The plugin checks
   `context.mode === 'router'`, not the request's model name. A per-request
   `x-antseed-routing-mode: router` header works with any model or no model.
2. The plugin sends the request body, optional selection instructions, and the
   host's eligible model/seller offers to `context.invokeService`.
3. The classifier returns one model. The plugin checks that it is eligible and
   returns `[{ serviceId }]`; AntSeed chooses the seller.
4. When the host suggests reuse and the previous model is still eligible, the
   plugin returns it without another classifier call.

The classifier uses the chat-completions response envelope. Its
`choices[0].message.content` must be a JSON string containing only:

```json
{ "serviceId": "model-x" }
```

This plugin selects a model and delegates seller ranking and same-model failover
to AntSeed. Exact-seller choices and fallback lists are available in the shared
router interface but are not part of this plugin's classifier response contract.

The same parser is passed to `invokeService` for fixed-fee acceptance and used
to read the result. Invalid or unavailable models are rejected before a fixed
fee is authorized. Token-priced calls retain their normal usage billing even
if the classification is unusable. Reusing a model adds no classifier fee.

## Install privately

From the repository root with the pinned Node 24 runtime, build the workspace
dependencies and CLI:

```sh
pnpm install
pnpm run build:tier0
pnpm run build:tier1
pnpm --filter @antseed/router-local build
pnpm --filter @antseed/router-classifier build
pnpm run build:tier3
pnpm --filter @antseed/cli build
mkdir -p "$HOME/.antseed/plugins/node_modules/@antseed"
ln -s "$PWD/plugins/router-classifier" "$HOME/.antseed/plugins/node_modules/@antseed/router-classifier"
```

The link command deliberately does not replace an existing installation.
Keep the source checkout and its installed dependencies available. This is a
local installation; do not use `npm install @antseed/router-classifier`.

After configuring an authorized classifier seller, start the buyer:

```sh
node apps/cli/dist/cli/index.js buyer start --router @antseed/router-classifier
```

The shorthand `--router classifier` loads the same private installation. If
using that shorthand, use `plugin:classifier` for the configuration keys below
instead of `plugin:@antseed/router-classifier`. Keys match the router argument.
The CLI does not install or update this plugin from npm. A missing build or
installation produces local setup instructions.

## Configure

Use the buyer setup in `docs/router-network-integration.md`, with
`@antseed/router-classifier` as the plugin and `plugin:@antseed/router-classifier`
as its settings and routing-service key. Point the routing service at an actual
advertised classifier seller, explicitly approve prompt sharing and spending
limits, and enable `buyer.routingPreferences.routerEnabled`. The classifier
provider must advertise `serviceCapabilities[serviceId].routing: true` (seller
configuration: `service.capabilities.routing: true`). The host rejects absent
routing capability and excludes routing-capable services from inference
listings and candidates; names do not classify services.

Use `x-antseed-routing-mode: router` for a per-request selection, or configure
`buyer.routingMode: "router"` and send the existing `model: "antseed"` alias to
follow session selection. Normal concrete model requests stay fixed without
the router header, even in a router-mode session; `x-antseed-routing-mode: model`
explicitly bypasses classification. For a pinned conversation, select
`routingMode: "router"` through `POST /_antseed/conversations/update` to clear
its `pinnedModel`. `POST /_antseed/route` persists session mode and clears the
session peer pin while retaining an optional failure fallback model. See
`docs/router-per-call-billing.md` for fixed-fee configuration.

The optional `instructions` setting describes your selection preference.
The classifier service must implement the response contract above. Services
with a different native response format need an adapter; the plugin contains
no vendor-specific credentials or endpoints. The existing local router supplies
ordinary peer-selection hooks.

Client HTTP headers are not shared, but the request body may contain sensitive
conversation, tool, or image data. Only enable sharing with a classifier seller
you trust. Classifier and inference sellers must be separate under the current
host's payment isolation.

## Concurrent calls and failures

Within a buyer, calls to the same classifier seller are queued in arrival order.
The host permits at most 32 outstanding calls per seller, including the active
call; rate limits may impose a lower bound. Different classifier sellers can
operate independently. The request's existing deadline includes queue time.
Cancelled or expired waiters are removed without contacting the classifier or
authorizing a fee. Active calls retain their slot until SDK cleanup finishes.

Queue overflow, an unavailable seller, invalid output, and exhausted spending
limits fail closed unless an explicit buyer fallback is configured. Queuing
does not retry a paid call or widen its spending grant. The queue covers only
classification, not downstream inference. A successful classification can still
be charged if the later inference request fails.

## Verify

After building the workspace dependencies with the pinned Node 24 runtime:

```sh
pnpm --filter @antseed/router-classifier build
pnpm --filter @antseed/router-classifier test
pnpm --filter @antseed/e2e run flow:local-chain-routing
pnpm --filter @antseed/e2e run flow:local-chain-routing --per-call
pnpm --filter @antseed/e2e run flow:local-chain-routing --per-call --concurrent
pnpm --filter @antseed/e2e run flow:local-chain-routing --per-call --invalid-route
```

The chain fixtures require Foundry and built CLI packages. They use this plugin
with deterministic classifier responses and isolated test wallets to verify
integration and billing, not classification quality. No production funds or
external classifier account are needed.
