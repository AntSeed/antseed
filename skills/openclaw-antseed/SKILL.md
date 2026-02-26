---
name: openclaw-antseed
description: "Connect OpenClaw to the AntSeed P2P AI network as a buyer. Use when: user asks to connect OpenClaw to AntSeed, route OpenClaw through AntSeed, set up AntSeed as a model provider for OpenClaw, or use P2P AI models in OpenClaw. Installs the AntSeed buyer proxy and configures OpenClaw to route LLM requests through the AntSeed peer-to-peer network."
user-invocable: true
metadata: { "openclaw": { "emoji": "🌱", "requires": { "bins": ["npm", "openclaw"] } } }
---

# Connect OpenClaw to AntSeed P2P Network

Set up AntSeed as a model provider for OpenClaw. This installs a local buyer proxy that connects to the AntSeed peer-to-peer network and routes LLM requests to available providers.

## Architecture

```
OpenClaw → http://127.0.0.1:5005 (AntSeed buyer proxy) → P2P network → Provider node → Upstream API (OpenRouter, Anthropic, etc.)
```

The buyer proxy runs locally, discovers providers via DHT, and exposes an API-compatible HTTP endpoint.

## Step 1: Install AntSeed CLI and buyer plugin

```bash
npm install -g @antseed/cli
antseed plugin add @antseed/router-local-proxy
```

Verify: `antseed --version` (requires Node.js 20+).

## Step 2: Start the buyer proxy

Run in a terminal or set up as a persistent service:

```bash
antseed connect --router local-proxy --port 5005
```

The proxy will:
1. Join the P2P network via DHT
2. Discover available providers
3. Listen on `http://localhost:5005`

### Persistent service (systemd)

To run the proxy as a background service that survives reboots:

```bash
sudo tee /etc/systemd/system/antseed-buyer.service > /dev/null <<'EOF'
[Unit]
Description=AntSeed Buyer Proxy
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$USER
ExecStart=/usr/bin/env antseed connect --router local-proxy --port 5005
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=antseed-buyer

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now antseed-buyer
```

Verify: `sudo systemctl is-active antseed-buyer`

## Step 3: Configure OpenClaw model provider

Ask the user which model they want to use. Available models depend on what providers are active on the network.

### Set the provider

```bash
openclaw config set models.providers.antseed.baseUrl "http://127.0.0.1:5005"
openclaw config set models.providers.antseed.apiKey "antseed-p2p"
openclaw config set models.providers.antseed.api "anthropic-messages"
```

### Add a model

The model ID must match a model available on the network. Ask the user or suggest common options. Example for Kimi K2.5 via OpenRouter:

```bash
cat ~/.openclaw/openclaw.json | python3 -c "
import sys, json
cfg = json.load(sys.stdin)
providers = cfg.setdefault('models', {}).setdefault('providers', {})
providers['antseed'] = {
    'baseUrl': 'http://127.0.0.1:5005',
    'apiKey': 'antseed-p2p',
    'api': 'anthropic-messages',
    'models': [{
        'id': 'MODEL_ID_HERE',
        'name': 'MODEL_DISPLAY_NAME',
        'reasoning': False,
        'input': ['text'],
        'contextWindow': 131072,
        'maxTokens': 8192
    }]
}
json.dump(cfg, sys.stdout, indent=2)
" > /tmp/oc_antseed.json && mv /tmp/oc_antseed.json ~/.openclaw/openclaw.json
```

Replace `MODEL_ID_HERE` with the actual model (e.g., `moonshotai/kimi-k2.5`, `anthropic/claude-sonnet-4-20250514`).

### Set as default model

```bash
openclaw config set agents.defaults.model.primary "antseed/MODEL_ID_HERE"
```

The model reference format is `antseed/<model-id>` where `antseed` is the provider name.

## Step 4: Restart and verify

```bash
# Restart the gateway to pick up the new provider
sudo systemctl restart openclaw  # or kill and restart the gateway process

# Test the connection
curl -s http://127.0.0.1:5005/v1/models
```

If the proxy returns available models, the connection is working.

## Bootstrap nodes (optional)

If the proxy can't find providers via DHT, add a known provider as a bootstrap node:

Edit `~/.antseed/config.json` and add to the `bootstrapNodes` array:

```json
{
  "bootstrapNodes": [
    { "host": "PROVIDER_IP", "port": 6882 }
  ]
}
```

Then restart the buyer proxy.

## API format notes

- Use `anthropic-messages` API format. The AntSeed proxy translates between formats as needed.
- The `apiKey` value doesn't matter — set it to any non-empty string (e.g., `antseed-p2p`). The proxy doesn't validate it.
- Streaming is supported. The proxy relays SSE streams from providers.

## Verification checklist

- [ ] `antseed --version` prints a version
- [ ] `antseed connect --router local-proxy --port 5005` starts without errors
- [ ] `curl http://127.0.0.1:5005/v1/models` returns available models
- [ ] OpenClaw config has `models.providers.antseed` configured
- [ ] `agents.defaults.model.primary` is set to `antseed/<model-id>`
- [ ] OpenClaw gateway responds to messages using the AntSeed model

## Troubleshooting

- **"No sellers available on the network"**: No providers found via DHT. Add a bootstrap node (see above) or check that providers are running.
- **"DHT returned 0 results"**: Check internet connectivity and firewall. DHT uses UDP on random high ports. Ensure inbound UDP is allowed.
- **Slow first request**: DHT discovery takes 5-10 seconds on the first request. Subsequent requests reuse cached peer connections.
- **Timeouts on large requests**: Some models take longer through P2P routing. Ensure the OpenClaw model config has adequate `maxTokens`.
- **"502 Upstream error"**: The provider's upstream API (OpenRouter, Anthropic) returned an error. Check the provider logs.
- **Empty responses**: Verify the model ID matches what the provider allows. Mismatched model names result in 403 errors.
