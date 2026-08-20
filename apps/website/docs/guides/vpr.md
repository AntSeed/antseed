---
sidebar_position: 1
slug: /guides/vpr
title: VPR Desktop Guide
description: Use the AntSeed Virtual Private Router—like a VPN for AI—to choose sellers, connect AI apps, manage credits, understand privacy, and troubleshoot requests.
---

# VPR Desktop Guide

The AntSeed **Virtual Private Router (VPR)** is like a **VPN for AI**: your AI apps connect to one local router, while the VPR discovers available sellers, applies your routing preferences, and sends each compatible request through the selected route. You can change models or sellers without reconfiguring every connected tool.

The VPR also manages pay-per-request settlement from your AntSeed credits, so connected tools can use network sellers without maintaining a separate AntSeed subscription or central AI account.

This guide follows the VPR interface from first launch through troubleshooting. For a protocol-level introduction, see [How AntSeed works](/docs/overview).

## Start the router

Use the power button on the Home screen to start or stop the local router. Once it is running, the status area shows network health, the local proxy port, and the number of visible peers and services.

Discovery is not instant. After startup, allow a few seconds for peer announcements and model offers to arrive. Open **Models** and use **Refresh models** if the catalog still appears empty.

The VPR runs locally, but the AI service is delivered by the seller selected for each route. AntSeed does not put a central account or hosted chat service between the VPR and that seller.

## Choose a model and seller

Open **Models** to browse the services currently advertised on the network. The catalog shows live seller availability, offered prices, and expected savings where a retail comparison is available.

Selecting a model sets the route used by new sessions. Existing conversations may retain their current model or seller affinity so they can continue consistently.

### Automatic seller selection

With **Auto select seller** enabled, the VPR ranks eligible sellers using your routing preferences and current network information. The selection can account for:

- Minimum trust score
- Price preference and hard maximum pricing
- Free-service preference
- Recent route failures and cooldowns
- Whether the seller offers the requested model and API format

Automatic routes can fail over after retryable seller or transport failures. A conversation normally prefers the seller that served it successfully, but that affinity is not a hard pin.

### Pin a seller

Pin a seller when you need a fixed route. A pin overrides automatic seller selection and does not fail over to another peer. Remove the pin before troubleshooting availability or performance problems with that seller.

Seller reputation is an input to routing, not a guarantee about model quality, privacy, or future availability. See [Reputation](/docs/reputation) for the protocol-level scoring model.

## Set routing preferences

Open **Preferences** to control automatic routing across models:

- **Minimum trust score** excludes sellers below the selected threshold.
- **Price preference** strongly penalizes offers above the preferred input-token price.
- **Maximum pricing** is the hard spending cap when configured.
- **Prefer free peers** gives zero-cost eligible routes a strong ranking advantage.

Turning automatic selection off leaves connected apps on their last selected route. It does not automatically choose a replacement if that pinned route becomes unavailable.

## Connect an AI app

Open **Connected apps** and select a detected tool. Depending on the application, the VPR connects it by updating a supported configuration file or by routing its API domains through the local proxy.

The tool keeps its normal interface. Its compatible AI requests are sent to the local VPR endpoint, translated when necessary, and routed to the selected AntSeed seller.

Some config-file integrations must be restarted before they read their updated settings. When the app row shows **Restart**, use that action before testing the connection.

For manual endpoints, SDK examples, and supported wire formats, see [Using the API](/docs/guides/using-the-api). Tool-specific setup is available from the [Integrations directory](/integrations).

### Trust the local HTTPS certificate

Some connected apps use HTTPS endpoints that the local proxy must intercept on your device. For those apps, the VPR generates a local certificate authority and asks the operating system to trust it.

The certificate is generated locally and its private key does not leave your computer. You can inspect or reveal the certificate from **Connected apps**. If an intercepted app reports an SSL or certificate error, trust the current certificate and restart the app.

Only apps connected through HTTPS interception need this certificate. Config-file integrations that point directly to the local VPR API do not.

## Use the local API

While the router is running, the VPR exposes a local API at `http://localhost:8377`. OpenAI-compatible clients commonly use `http://localhost:8377/v1` as their base URL, while Anthropic clients use the root URL and append `/v1/messages` themselves.

The proxy binds to your computer rather than exposing the API to your local network. AntSeed does not require an API key for this local endpoint, although some clients require any non-empty placeholder such as `antseed` in their API-key field.

### Browse models with `/v1/models`

Request the model catalog before choosing a model id:

```bash
curl http://localhost:8377/v1/models
```

`GET /v1/models` is answered locally and is not billed. Its `data` array contains the model ids currently advertised across the network. Use one of those ids in the `model` field of a request. To list image services only:

```bash
curl 'http://localhost:8377/v1/models?type=images'
```

### Supported request endpoints

| Endpoint | Use |
|---|---|
| `/v1/chat/completions` | OpenAI Chat Completions clients |
| `/v1/responses` | OpenAI Responses clients such as Codex |
| `/v1/messages` | Anthropic Messages clients such as Claude Code |
| `/v1/images/generations` | OpenAI-compatible image generation |
| `/v1/images/edits` | OpenAI-compatible multipart image editing |
| `/v1/messages/count_tokens` | Local Anthropic token counting; never routed or billed |

For example, send an OpenAI-compatible chat request using a model id returned by `/v1/models`:

```bash
curl http://localhost:8377/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{
    "model": "deepseek-v4-flash",
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

### Select a model or seller through the API

The request's `model` field controls routing:

- `"model": "antseed"` follows the model or seller route currently selected in the VPR. Changing the VPR picker updates clients that use this alias without rewriting their configuration.
- `"model": "<modelId>"` uses automatic seller selection for that catalog model under your VPR Price + Trust preferences.
- `"model": "<peerId>@<modelId>"` hard-pins that request to one seller and disables automatic failover.

If no VPR route is selected, the `antseed` alias returns `no_default_route`. Use a concrete model id when you want a request to route independently of the VPR picker.

See [Using the API](/docs/guides/using-the-api) for SDK configuration, format translation, response headers, routing overrides, errors, and tool-specific examples.

## Use the floating window

The floating window stays above your other apps and shows the active model plus current token and cost activity. Use it to change the model for new sessions or assign a model to an individual recent conversation.

A conversation with current traffic displays an activity pulse. Close the floating window with its close control; closing it does not stop the router or disconnect your apps.

## Privacy, transport, and seller trust

The VPR is anonymous by default. There is no central AntSeed account, platform-issued API key, or personal profile attached to your requests. Sellers generally receive a pseudonymous peer or wallet identity rather than your name, email, or identity on the tools you connected.

### Anonymous access

Identity anonymity and request content are separate. A standard seller can process the prompt it serves, but AntSeed does not tell the seller who you are. Verified TEE routes can add stronger content confidentiality where available.

### What stays local

The VPR's configuration, signing identity, connected-app setup, routing decisions, and local activity data remain on your device unless a specific feature sends data elsewhere. The desktop signing key is encrypted at rest through the operating system keychain.

### Encrypted peer transport

Between AntSeed nodes, the preferred transport is a mutually authenticated encrypted TCP channel using wallet-signed ephemeral keys. **WebRTC DataChannels are a fallback** for peers that advertise WebRTC but cannot use direct encrypted TCP. WebRTC is not the primary transport for normal node-to-node VPR traffic.

See the [Transport specification](/docs/transport) for handshake, encryption, framing, and fallback details. For background on the fallback technology, see [WebRTC data channels on MDN](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Using_data_channels).

### TEE-verified sellers

Trusted Execution Environments can add hardware-backed confidentiality when a seller offers a verifiable TEE route. Treat a TEE label as a claim to verify, not as sufficient proof by itself. Verification must bind the attestation to the running workload, seller identity, and expected configuration.

See [Verify a seller's TEE](/docs/guides/verify-tee), [Security](/docs/security), and Intel's [Trust Domain Extensions overview](https://www.intel.com/content/www/us/en/developer/tools/trust-domain-extensions/overview.html).

## Credits and payments

AntSeed is pay per use. Add credits once, then the VPR authorizes bounded payment channels with the sellers serving your requests. There is no AntSeed subscription required for usage routed through the network.

### Add credits

Open **Credits** and choose **Add credits**. The available funding methods can include card checkout or USDC transfers, depending on your location and the currently enabled providers.

Credits are USDC on Base held by the AntseedDeposits contract for your VPR signing identity. Circle publishes the official [USDC contract addresses](https://developers.circle.com/stablecoins/usdc-contract-addresses); always verify the network and destination shown by the VPR before transferring funds.

### Payment channels and reserved funds

When a paid session starts, the VPR signs a capped authorization for one seller. Part of your available balance becomes **reserved** for that channel. Each request advances a cumulative spending authorization; the seller can settle only up to the latest amount you signed.

Reserved balance is still yours. Any unspent amount returns to available balance when the channel settles or closes. If a seller disappears, the channel can enter an on-chain close process and release the remaining funds after the grace period.

Open **Activity** to view active channels, spending history, settlement state, and close actions. See [Payments](/docs/guides/payments) for the full buyer flow and Base contract addresses.

### Withdraw unused credits

Open **Credits** and choose **Withdraw unused credits**. Only available balance can be withdrawn immediately. Amounts reserved by active channels must be released through settlement or channel closure first.

### Signing identity and funding wallet

The VPR signing identity authorizes protocol messages and bounded channel spending. It does not need to hold funds in a normal wallet. A separate funding wallet can deposit USDC for that identity without giving the VPR control of the funding wallet.

See [Security: signing identity vs funding wallet](/docs/security#signing-identity-vs-funding-wallet) for the security boundaries.

## Rewards

The **Rewards** screen shows ANTS attributed to eligible network usage on the selected chain. Availability, transferability, and claim behavior depend on the deployed emissions contracts and current network phase.

If claims are available, the VPR opens a secure browser flow for the authorized wallet signature. A displayed pending amount is not a promise of token value, future emissions, or permanent eligibility. See [Payments: ANTS token emissions](/docs/guides/payments#ants-token-emissions) and the [ANTS token overview](/ants-token).

## Troubleshooting

### No peers or models are listed

1. Confirm the Home power button is on and the status area is healthy.
2. Wait a few seconds for peer discovery.
3. Open **Models** and use **Refresh models**.
4. Check whether local security software is blocking the VPR's outbound or inbound network connections.
5. Open **Help → Developer mode → Available peers** to inspect discovery directly.

AntSeed prefers encrypted TCP for node-to-node traffic and can fall back to WebRTC for compatible peers. Do not troubleshoot the VPR as if WebRTC were its only transport.

### A connected app does not send requests

1. Disconnect and reconnect the app from **Connected apps**.
2. Restart the app if its row requests a restart.
3. Check that the app is not overriding the base URL or API settings written by the VPR.
4. Confirm the selected model is compatible with the app's API format.
5. Use the integration-specific guide from the [Integrations directory](/integrations).

### An app reports a certificate or SSL error

Open **Connected apps**, expand **HTTPS certificate**, and trust the current certificate. If an older AntSeed certificate is still installed, trusting the current certificate replaces it. Restart the affected app afterward.

### Requests fail with payment errors

Open **Credits** and compare available balance with reserved balance. A new paid channel cannot open if there is not enough available balance for its capped authorization.

If a channel budget is exhausted during a session, the VPR normally settles it and opens another channel automatically. Retry a request once before changing configuration. Use **Activity** to inspect channels that remain open or are waiting for an on-chain close.

### “Model is not served by this peer”

The app sent a model that the selected seller does not currently advertise. Re-select the model in the VPR to synchronize the route. If the error persists, disconnect and reconnect the app so its configuration and model state are refreshed.

If the route is pinned, confirm that the pinned seller still offers that exact model. Remove the pin to allow automatic selection to choose another eligible seller.

### Responses are slow or time out

Seller performance and network paths vary. Open the model's seller list and try another eligible seller, or remove a hard seller pin so automatic routing can fail over after retryable failures.

Large prompts and attachments take longer to upload. The floating window activity pulse and **Activity** view help distinguish active transfer from a stalled request.

### Reserved credits remain unavailable

Open **Activity** and inspect the active channel. Request a cooperative close when the seller is reachable. If it is not, request an on-chain close and follow the displayed grace-period instructions before withdrawing the released balance.

### Collect diagnostics

Open **Help**, enable **Developer mode**, then use:

- **Live logs** for runtime events
- **Available peers** for discovered sellers and services
- **Connection details** for local router status
- **Configuration** for the effective runtime settings
- **Copy diagnostic report** for a versioned summary and recent logs

Review the report for secrets before posting it publicly.

## Get support

For usage questions, join the [AntSeed Telegram community](https://t.me/antseed). For reproducible bugs, [open a GitHub issue](https://github.com/AntSeed/antseed/issues/new) with the VPR version, operating system, affected app, expected result, actual result, and a redacted diagnostic report.

Follow [AntSeed on X](https://x.com/antseed) for release announcements, and review the project [changelog](https://github.com/AntSeed/antseed/blob/main/CHANGELOG.md) before reporting an issue that may already be fixed.
