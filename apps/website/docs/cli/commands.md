---
sidebar_position: 1
slug: /commands
title: CLI Commands
sidebar_label: Commands
hide_title: true
---

# CLI Commands

### Getting started

```bash title="setup"
antseed seller setup                  Initialize seller onboarding
antseed buyer start                   Start the buyer proxy
```

In normal use, you configure the node once with `antseed seller setup` or `antseed config ...`, then start it later with `antseed seller start` or `antseed buyer start` without repeating flags every time. Secrets such as API keys stay in env vars; provider definitions, services, pricing, capabilities, unit billing, and `baseUrl` live in `~/.antseed/config.json`.

### Providing (selling)

```bash title="provider"
antseed seller start                  Start providing AI services
antseed seller start --base-rpc-url <url>
                                      Use a custom Base RPC URL for this run
antseed seller register               Register peer identity on-chain (ERC-8004)
antseed seller stake <amount>         Stake USDC as a provider (min $10)
antseed seller unstake                Withdraw staked USDC
antseed seller emissions claim        Claim accumulated seller payouts
```

### Buying (consuming)

```bash title="buyer"
antseed buyer start                   Start the buyer proxy
antseed buyer start --router <name>   Start the buyer proxy with a non-default router
antseed buyer deposit <amount>        Deposit USDC for payments
antseed buyer withdraw <amount>       Withdraw USDC from deposits
antseed buyer balance                 Check wallet and deposit balance
antseed network browse                Browse available services and pricing
antseed payments                      Launch the payments portal
```

### Network and monitoring

```bash title="network"
antseed seller status                 Show seller status
antseed buyer status                  Show buyer status
antseed metrics serve                 Serve Prometheus-compatible buyer/seller metrics
antseed config                        Manage config file
antseed peer <peerId>                 View a peer's profile
antseed profile                       Manage your peer profile
antseed buyer channels                List payment channels
antseed seller emissions info         View epoch info and ANTS emissions
antseed network bootstrap             Run a dedicated DHT bootstrap node
antseed buyer connection              Manage connection settings
antseed dev                           Run seller + buyer locally for testing
```

### Service configuration

`antseed config seller add-service <provider> <serviceId>` supports:

| Option | Purpose |
|---|---|
| `--upstream <model>` | Map the public service ID to an upstream model ID |
| `--input`, `--cached`, `--output` | Token prices in USD per million tokens |
| `--categories <csv>` | Discovery tags |
| `--capabilities <json>` | Model hints such as context window, input modalities, reasoning, and tool use |
| `--unit-billing-models <json>` | Per-protocol non-token billing, currently used by `openai-images` |
| `--base-url <url>` | Set the provider-wide upstream base URL |

```bash
antseed config seller add-service openai flux.1-schnell \
  --upstream "black-forest-labs/FLUX.1-schnell" \
  --input 0 --output 0 \
  --capabilities '{"inputs":["text","image"]}' \
  --unit-billing-models '{"openai-images":{"version":1,"components":[{"unit":"output_images","priceUsd":0.003}]}}'
```

`antseed seller setup` exposes the same capability and unit-billing fields interactively. `antseed seller start` warns if unit billing is configured for a plugin that does not support it. Image services are not health-probed because a meaningful probe would incur an upstream generation charge.

Before deploying this CLI version to sellers, follow the [metadata v12 upgrade order](/docs/guides/metadata-v12-upgrade): upgrade buyers first, then sellers.
