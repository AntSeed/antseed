# Generic classifier router (reference integration)

This private, source-only example connects an AntSeed buyer to any authorized
classifier service that accepts OpenAI chat-completion requests and returns the
JSON contract below. It contains no vendor endpoints, API keys, model catalog,
or model-quality heuristics. It is not bundled, published, or automatically
installed. The existing local router supplies ordinary peer-selection and
buyer-policy hooks.

## What the classifier sees and returns

The plugin sends two messages through `context.invokeService`. The system
message specifies the response contract. The user message contains JSON with
the buyer's `instructions`, the original request path and parsed body, and
the host's eligible `candidates`. Client HTTP headers are not forwarded. The
request body can contain sensitive conversation, tool, and image data; only
enable sharing with a classifier seller you trust. The host's input-byte limit
applies to the entire serialized classifier input.

Every candidate retains its exact `serviceId`, `peerId`, and separate
`inputUsdPerMillion`, `outputUsdPerMillion`, and `cachedInputUsdPerMillion`
prices. Two sellers offering the same model are two different choices. A null
price means unknown; zero means free for that component. The plugin does not
replace a classifier's more expensive selection with the cheapest seller or
invent a combined cost without knowing token usage.

The classifier must return an ordinary chat-completion response whose
`choices[0].message.content` is a JSON string:

```json
{
  "routes": [
    { "serviceId": "model-x", "peerId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    { "serviceId": "model-x", "peerId": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }
  ]
}
```

The classifier can instead return `{"routes":[{"serviceId":"model-x"}]}`
to let AntSeed choose an eligible seller using the normal buyer preferences,
pricing, reputation, and conversation affinity. It need not enumerate sellers.
An exact pair selects that offer, including its individual prices; AntSeed does
not silently switch sellers if that offer fails. To explicitly allow automatic
same-model fallback, return an exact pair followed by `{"serviceId":"model-x"}`.

Exact pairs must occur in the candidate snapshot; model-only recommendations
must have at least one eligible seller in that snapshot. The first recommendation
is preferred; additional recommendations are explicit same-model fallbacks.
Malformed, empty, duplicate, mixed-model, or unadvertised choices are rejected.
The same pure parser runs during fixed-fee acceptance and when consuming the
response. Token-priced classifiers still charge for verified usage even if
their output cannot be used.

Native vendor APIs returning a different payload need an adapter on the seller
side or a different plugin parser; this example is not a vendor integration.

The plugin uses the previous eligible recommendation list without invoking the
classifier when the latest user text is unchanged. It reconsiders changed text
and unavailable routes according to host hints. Repeated identical user turns
and history rewrites with unchanged latest user text intentionally reuse the
decision; there is no configurable cadence or structural-history tracking.
Explicit model requests bypass classification. A router choice is not a user
pin, and the classifier decides how to trade capability against prices. The
actual dispatched seller is recorded separately: it does not turn a model-only
recommendation into an exact-seller choice on the next request.

## Run the tests and complete local flow

From the repository root, using the pinned Node 24 runtime:

```sh
pnpm install
pnpm run build:tier0
pnpm run build:tier1
pnpm --filter @antseed/router-local build
pnpm --filter @antseed/router-classifier build
pnpm --filter @antseed/router-classifier test
pnpm run build:tier3
pnpm --filter @antseed/cli build
pnpm --filter @antseed/e2e run flow:local-chain-routing
pnpm --filter @antseed/e2e run flow:local-chain-routing --model-only
pnpm --filter @antseed/e2e run flow:local-chain-routing --per-call
pnpm --filter @antseed/e2e run flow:local-chain-routing --per-call --model-only
pnpm --filter @antseed/e2e run flow:local-chain-routing --per-call --invalid-route
```

The chain commands require Foundry (`anvil`, `forge`, and `cast`). The build
commands include the CLI's `@antseed/payments` and `@antseed/ants` dependencies.
The chain fixtures create isolated local development
wallets, classifier and inference sellers, and a buyer proxy using this actual
plugin. The deterministic classifier fixture tests integration and settlement,
not classification quality. No vendor account or production funds are needed.

## Use a real classifier service

After building, link this source-only plugin into the existing CLI plugin
directory (do not overwrite an existing installation):

```sh
mkdir -p "$HOME/.antseed/plugins/node_modules/@antseed"
ln -s "$PWD/plugins/router-classifier" "$HOME/.antseed/plugins/node_modules/@antseed/router-classifier"
```

Merge this fragment into your normal buyer configuration. Replace the peer ID
and service with an actual advertised classifier offer. The example opts into
sharing the request body and authorizes a maximum fixed fee of 5,000 micro-USDC
(USD 0.005) per accepted classification; it is a buyer limit, not a claim about
any vendor's price. The seller must advertise zero token prices and the matching
fixed-per-call billing model. See `docs/router-per-call-billing.md` for token
billing and funding configuration.

```json
{
  "buyer": {
    "routerFailureFallback": "none",
    "routingPreferences": {
      "routerEnabled": true,
      "routerSettings": {
        "plugin:@antseed/router-classifier": {
          "instructions": "Choose a model suited to the task; consider output prices for long answers."
        }
      }
    },
    "routingService": {
      "routerKey": "plugin:@antseed/router-classifier",
      "peerId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "provider": "openai",
      "serviceId": "classifier",
      "allowPromptSharing": true,
      "billing": { "kind": "per_call", "maxAmountMicroUsdc": "5000" },
      "maxAdditionalAuthorizationUsdc": "5000",
      "maxRequestsPerMinute": 10,
      "maxInputBytes": 65536,
      "maxOutputTokens": 512
    }
  }
}
```

```sh
ANTSEED_SKIP_PLUGIN_UPDATE_CHECK=1 node apps/cli/dist/cli/index.js buyer start --router @antseed/router-classifier
```

Send a normal completion request to the buyer proxy with `model:
"classifier-auto"`. All inference offers remain subject to the buyer's price,
trust, capability, and peer restrictions. Configure the classifier under a
different seller identity from inference, as required by the current host's
payment isolation. Concurrent paid calls to one classifier seller still have
the host's single-active-authorization limitation; this example adds no queue.
