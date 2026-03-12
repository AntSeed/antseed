# @antseed/provider-unified

Unified multi-upstream provider plugin for AntSeed.

This plugin exposes a single AntSeed provider instance while internally routing
requests across multiple upstream APIs such as Anthropic and OpenAI-compatible
providers.

## Install

```bash
antseed plugin add @antseed/provider-unified
```

## What It Does

- Advertises one provider to the AntSeed network
- Supports multiple upstreams inside that provider
- Routes requests by requested `service` / `model`
- Falls back to request-path/provider heuristics when service is absent
- Supports both Anthropic and OpenAI-compatible upstreams

## Config

The plugin expects `ANTSEED_UPSTREAMS_JSON`.

Example:

```json
[
  {
    "name": "anthropic",
    "type": "anthropic",
    "apiKey": "sk-ant-...",
    "allowedServices": ["claude-sonnet-4-5"],
    "pricing": {
      "defaults": {
        "inputUsdPerMillion": 3,
        "outputUsdPerMillion": 15
      }
    }
  },
  {
    "name": "openai",
    "type": "openai",
    "apiKey": "sk-openai-...",
    "allowedServices": ["gpt-4o", "gpt-4o-mini"]
  },
  {
    "name": "openrouter",
    "type": "openai",
    "apiKey": "sk-or-...",
    "providerFlavor": "openrouter",
    "allowedServices": ["kimi-k2"],
    "upstreamServicePrefix": "openrouter"
  }
]
```

Optional top-level plugin config:

- `ANTSEED_DEFAULT_UPSTREAM`: default upstream name when a request has no matching service route
- `ANTSEED_PROVIDER_NAME`: advertised provider name, defaults to `unified`

## Upstream Fields

Each upstream object supports:

- `name`: route name
- `type`: `anthropic` or `openai`
- `apiKey`: upstream credential
- `allowedServices`: services routed to this upstream
- `maxConcurrency`: optional per-upstream concurrency
- `pricing`: optional AntSeed pricing object
- `baseUrl`: optional custom upstream base URL
- `extraHeaders`: optional static headers
- `bodyInject`: optional JSON merged into upstream request body
- `stripHeaderPrefixes`: optional header prefixes removed before forwarding

OpenAI-compatible upstreams also support:

- `serviceAliasMap`: announced service -> upstream service mapping
- `upstreamServicePrefix`: prefix added to announced services
- `providerFlavor`: `generic` or `openrouter`
- `upstreamProvider`: OpenRouter provider selector

## Routing Rules

1. If the request body includes `service` or `model`, that service is matched to the upstream that declared it in `allowedServices`.
2. If no service match is found, the plugin falls back to existing provider/path heuristics.
3. If still unresolved, the plugin uses `ANTSEED_DEFAULT_UPSTREAM` or the first configured upstream.

## Notes

- This plugin keeps the network-facing provider contract unchanged.
- It is intended for operators who want one provider entrypoint with internal routing.
- If you need a completely custom behavior, write a dedicated provider plugin instead.

## Middleware

`@antseed/provider-unified` does not define its own separate middleware format.
It uses the existing seller middleware pipeline from the CLI.

Middleware can already be scoped per service with `seller.middleware[].services`.
That means you can combine:

- service-based upstream routing inside `provider-unified`
- service-based prompt/middleware injection in seller config

Example:

```json
{
  "seller": {
    "middleware": [
      {
        "file": "./middleware/deployments.md",
        "position": "system-append",
        "services": ["deployment-service"]
      }
    ]
  }
}
```

In that setup:

- requests for `deployment-service` can be routed to a specific upstream by `provider-unified`
- the `deployments.md` middleware file is only injected for that service
