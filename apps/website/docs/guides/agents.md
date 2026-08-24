---
sidebar_position: 3
slug: /guides/agents
title: Connect Agents
description: Connect Hermes, OpenClaw, and other agents to the AntSeed VPR locally or through an authenticated public HTTPS endpoint.
---

# Connect Agents

The AntSeed VPR exposes the models selected by your routing policy through an OpenAI- and Anthropic-compatible API. An agent can connect in either of two ways:

- **Local agent** — use the buyer API on the same computer at `http://127.0.0.1:8377/v1`.
- **Remote agent or hosted client** — define an authenticated internet-accessible endpoint from the VPR's **Agents** view.

The public endpoint is useful for agents on another server, hosted development tools such as Cursor, CI workers, and custom applications that cannot reach your computer's `localhost` address.

## Agent setup skills

Use the maintained setup skill for the agent you want to connect:

- [Hermes integration](/integrations/hermes) and [Hermes Agent skill](https://github.com/AntSeed/antseed/tree/main/skills/hermes-antseed) — configure the current Hermes `providers:` schema, select models, fund the buyer, and use local or public endpoints.
- [OpenClaw integration](/integrations/openclaw) and [OpenClaw skill](https://github.com/AntSeed/antseed/tree/main/skills/openclaw-antseed) — configure AntSeed under `models.providers`, including bearer-header authentication for a public endpoint.

For another agent, use its custom OpenAI or Anthropic provider settings with the base URL and API key described below. See [Using the API](/docs/guides/using-the-api) for request formats and routing behavior.

## Connect locally

Use the local endpoint when the agent runs on the same computer as the VPR:

```bash
export ANTSEED_BASE_URL="http://127.0.0.1:8377/v1"
export ANTSEED_API_KEY="antseed-p2p"
```

The local buyer proxy does not validate an API key, but many agent SDKs require a non-empty value. The `antseed-p2p` value is only a placeholder.

Test model discovery:

```bash
curl "$ANTSEED_BASE_URL/models" \
  -H "Authorization: Bearer $ANTSEED_API_KEY"
```

### Hermes

Current Hermes releases store named custom endpoints under `providers:`. Add AntSeed in `~/.hermes/config.yaml`:

```yaml
model:
  provider: antseed
  default: antseed
  base_url: ""
  api_mode: chat_completions

providers:
  antseed:
    name: AntSeed
    api: http://127.0.0.1:8377/v1
    api_key: antseed-p2p
    transport: chat_completions
    extra_headers:
      originator: hermes
    default_model: antseed
    models:
      antseed:
        context_length: 200000
      minimax-m2.7:
        context_length: 200000
      kimi-k2.6:
        context_length: 256000
```

The `antseed` model follows the current VPR model picker. Add concrete IDs returned by `GET /v1/models` when you want them in Hermes' model menu. The [Hermes Agent skill](https://github.com/AntSeed/antseed/tree/main/skills/hermes-antseed) covers funding, systemd, auxiliary models, and routing in detail.

### OpenClaw

Add AntSeed under `models.providers` in `~/.openclaw/openclaw.json`:

```json
{
  "models": {
    "providers": {
      "antseed": {
        "baseUrl": "http://127.0.0.1:8377/v1",
        "apiKey": "antseed-p2p",
        "authHeader": true,
        "api": "anthropic-messages",
        "models": [
          {
            "id": "kimi-k2.6",
            "name": "Kimi K2.6 via AntSeed",
            "reasoning": false,
            "input": ["text"],
            "contextWindow": 256000,
            "maxTokens": 8192
          }
        ]
      }
    }
  }
}
```

Then run `openclaw models set "antseed/kimi-k2.6"` followed by `openclaw gateway restart`. `authHeader: true` makes OpenClaw send the API key as `Authorization: Bearer <API_KEY>`, which is required by the public gateway and also works locally. See the [OpenClaw skill](https://github.com/AntSeed/antseed/tree/main/skills/openclaw-antseed) for the complete walkthrough and setup script.

## Define your internet-accessible AntSeed endpoint

Use this only when the agent or hosted client cannot reach the VPR locally. Open **Agents** in the desktop app, then configure one tunnel provider under **Define your internet-accessible AntSeed endpoint**.

For provider setup, authentication details, supported routes, Cursor configuration, CLI commands, and troubleshooting, follow the unchanged [Public HTTPS Tunnels guide](/docs/guides/public-tunnels).

The VPR places a small authenticated gateway in front of the buyer API. It does not expose the desktop, the unrestricted local proxy, or port `8377` directly.

:::warning Protect the API key
Anyone with the public URL and API key can send requests through your VPR and spend its available AntSeed credits. Store the key as a secret, rotate the tunnel configuration if it is exposed, and stop the endpoint when it is not needed.
:::

### ngrok

Use ngrok for a quick generated endpoint or an ngrok static domain.

1. Install the ngrok CLI and copy your account authtoken.
2. In **VPR → Agents → ngrok**, paste the authtoken.
3. Leave **Public hostname** blank for a generated `ngrok-free.dev` URL, or enter your configured static ngrok domain.
4. Select **Save and start**.

### Cloudflare Tunnel

Use Cloudflare when you want a stable hostname on a domain you control.

1. Create a named tunnel in Cloudflare Zero Trust.
2. Add a public hostname whose service points to `http://localhost:8379`.
3. Copy the tunnel's run token.
4. In **VPR → Agents → Cloudflare Tunnel**, paste the token and public `https://` hostname.
5. Select **Save and start**.

After the endpoint starts, the VPR displays:

- **OpenAI base URL** — for example, `https://example.ngrok-free.dev/v1`.
- **API key** — an AntSeed-generated secret beginning with `antseed_`.

Set those exact values on the remote machine:

```bash
export ANTSEED_BASE_URL="https://your-endpoint.example/v1"
export ANTSEED_API_KEY="antseed_your_generated_key"
```

The public gateway requires the key in the standard bearer header:

```http
Authorization: Bearer antseed_your_generated_key
```

Do not use the ngrok authtoken or Cloudflare tunnel token as the agent API key. The gateway does not accept `x-api-key`, query parameters, cookies, or a key embedded in the URL.

Use the public values in the Hermes provider's `api` and `api_key` fields or the OpenClaw `baseUrl` and `apiKey` fields shown above. Keep OpenClaw's `authHeader: true` setting.

## Use it with Cursor

In Cursor's model settings:

1. Enable the OpenAI API key option and paste the generated AntSeed API key.
2. Enable **Override OpenAI Base URL** and paste the complete VPR value ending in `/v1`.
3. Add or select a model ID returned by `GET /v1/models`.
4. Run a small request and confirm it appears in the VPR or tunnel logs.

Some Cursor requests originate from Cursor's infrastructure, so `localhost`, private LAN addresses, and hostnames that resolve only on your computer will not work for those flows.

## Supported public routes

The authenticated gateway intentionally allows only these routes:

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/v1/models` | List available models and routes |
| `POST` | `/v1/messages` | Anthropic-compatible messages |
| `POST` | `/v1/messages/count_tokens` | Anthropic-compatible token-count preflight |
| `POST` | `/v1/chat/completions` | OpenAI-compatible chat completions |
| `POST` | `/v1/responses` | OpenAI Responses API |
| `POST` | `/v1/images/generations` | Image generation |
| `POST` | `/v1/images/edits` | Image editing |

Other paths return `404 Not Found`. Requests without the exact bearer key return `401 Unauthorized`.

## CLI endpoint setup

For a headless VPR, start `antseed buyer start` and run the tunnel as a separate process.

```bash
# ngrok
export NGROK_AUTHTOKEN="your_ngrok_authtoken"
export ANTSEED_TUNNEL_API_KEY="antseed_generate_a_long_random_secret"
antseed tunnel start --provider ngrok

# Cloudflare
export CLOUDFLARED_TUNNEL_TOKEN="your_named_tunnel_token"
export ANTSEED_TUNNEL_PUBLIC_URL="https://llm.example.com"
export ANTSEED_TUNNEL_API_KEY="antseed_generate_a_long_random_secret"
antseed tunnel start --provider cloudflare
```

Use `antseed tunnel status` to inspect the active URL and `antseed tunnel stop` to stop it.

## Troubleshooting

### The endpoint receives no request

- Confirm the client uses the complete public base URL ending in `/v1`.
- Test `GET /v1/models` with `curl` from another network.
- Confirm public DNS resolves and the selected tunnel is running.
- Check whether the hosted client blocks free tunnel domains or displays an interstitial page.

### `401 Invalid API key`

- Send `Authorization: Bearer <API_KEY>` exactly.
- Copy the AntSeed API key from **VPR → Agents**, not the tunnel provider credential.
- Do not put the key in the URL.

### `404 Not found`

- Use one of the supported routes above.
- Configure SDKs with the displayed base URL ending in `/v1`.
- For a raw call, use a path such as `/v1/models` or `/v1/responses`.

### `502 AntSeed buyer proxy is unavailable`

The public endpoint is running, but the local buyer proxy is not accepting requests. Start the VPR router or `antseed buyer start`, then retry.
