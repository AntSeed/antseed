# Classifier router example

A small, private example of choosing a model through an AntSeed classifier
service. It is source-only: not bundled, published, or automatically installed.

## How it works

1. A request for `classifier-auto` asks this plugin to choose a model. Explicit
   model requests use ordinary routing instead.
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

This example intentionally has no exact-seller selection, fallback lists,
model catalog, or built-in ranking algorithm. The shared router interface
supports richer recommendations, but they are not needed to show the integration.

The same parser is passed to `invokeService` for fixed-fee acceptance and used
to read the result. Invalid or unavailable models are rejected before a fixed
fee is authorized. Token-priced calls retain their normal usage billing even
if the classification is unusable. Reusing a model adds no classifier fee.

## Configure and adapt

Use the buyer setup in `docs/router-network-integration.md`, with
`@antseed/router-classifier` as the plugin and `plugin:@antseed/router-classifier`
as its settings and routing-service key. Point the routing service at an actual
advertised classifier seller, explicitly approve prompt sharing and spending
limits, and request `classifier-auto`. See `docs/router-per-call-billing.md`
for fixed-fee configuration.

The optional `instructions` setting describes your selection preference.
To adapt this example to another response format, change the request messages
and `parseClassificationResponse`; keep the host-mediated call and eligibility
validation. The existing local router supplies ordinary peer-selection hooks.

Client HTTP headers are not shared, but the request body may contain sensitive
conversation, tool, or image data. Only enable sharing with a classifier seller
you trust. Classifier and inference sellers must be separate under the current
host's payment isolation. This example adds no concurrent-call queue.

## Verify

After building the workspace dependencies with the pinned Node 24 runtime:

```sh
pnpm --filter @antseed/router-classifier build
pnpm --filter @antseed/router-classifier test
pnpm --filter @antseed/e2e run flow:local-chain-routing
pnpm --filter @antseed/e2e run flow:local-chain-routing --per-call
pnpm --filter @antseed/e2e run flow:local-chain-routing --per-call --invalid-route
```

The chain fixtures require Foundry and built CLI packages. They use this plugin
with deterministic classifier responses and isolated test wallets to verify
integration and billing, not classification quality. No production funds or
external classifier account are needed.
