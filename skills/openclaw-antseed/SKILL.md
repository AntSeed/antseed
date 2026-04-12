---
name: openclaw-antseed
description: "Connect OpenClaw to the AntSeed P2P AI network as a buyer. Use when: user asks to connect OpenClaw to AntSeed, route OpenClaw through AntSeed, set up AntSeed as a service provider for OpenClaw, or use P2P AI services in OpenClaw."
user-invocable: true
metadata: { "openclaw": { "emoji": "\ud83c\udf31", "requires": { "bins": ["npm", "openclaw"] } } }
---

# Connect OpenClaw to AntSeed P2P Network

Set up AntSeed as a service provider for OpenClaw. This installs a local buyer proxy that connects to the AntSeed peer-to-peer network and routes LLM requests to available providers.

## Architecture

```
OpenClaw -> http://127.0.0.1:5005 (AntSeed buyer proxy) -> P2P network -> Provider node -> Upstream API
```

The buyer proxy runs locally, discovers providers via DHT, negotiates payment channels automatically, and exposes an API-compatible HTTP endpoint.

## Step 1: Install and initialize AntSeed

```bash
npm install -g @antseed/cli
```

Verify: `antseed --version` (requires Node.js 20+).

## Step 2: Set the identity

```bash
export ANTSEED_IDENTITY_HEX=<64-char-hex-private-key>
```

The key can optionally include a `0x` prefix. This key is your EVM wallet — deposits and payments are tied to it.

## Step 3: Configure chain and fund the account

Edit `~/.antseed/config.json`:

```json
{
  "payments": {
    "preferredMethod": "crypto",
    "crypto": {
      "chainId": "base-mainnet"
    }
  }
}
```

Fund the buyer wallet with USDC on Base, then deposit into the escrow:

```bash
antseed buyer deposit 10
```

Verify with `antseed buyer balance`.

## Step 4: Start the buyer proxy

Run in a terminal or set up as a persistent service:

```bash
antseed buyer start --router local --port 5005
```

### Persistent service (systemd)

```bash
sudo tee /etc/systemd/system/antseed-buyer.service > /dev/null <<'EOF'
[Unit]
Description=AntSeed Buyer Proxy
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$USER
ExecStart=/usr/bin/env antseed buyer start --router local --port 5005
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=antseed-buyer
Environment=ANTSEED_IDENTITY_HEX=<private-key-hex-no-0x>

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now antseed-buyer
```

## Step 5: Configure OpenClaw service provider

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
        'id': 'SERVICE_ID_HERE',
        'name': 'SERVICE_DISPLAY_NAME',
        'reasoning': False,
        'input': ['text'],
        'contextWindow': 131072,
        'maxTokens': 8192
    }]
}
json.dump(cfg, sys.stdout, indent=2)
" > /tmp/oc_antseed.json && mv /tmp/oc_antseed.json ~/.openclaw/openclaw.json
```

Replace `SERVICE_ID_HERE` with the service from `antseed network browse` (e.g., `deepseek-v3.1`, `kimi-k2.5`).

Set as default:

```bash
openclaw config set agents.defaults.model.primary "antseed/SERVICE_ID_HERE"
```

## Step 6: Verify

```bash
curl -s http://127.0.0.1:5005/v1/models
```

If the proxy returns available services, the connection is working.

## Notes

- The API key value doesn't matter — set it to any non-empty string
- Streaming is supported (SSE)
- Payment channels are negotiated automatically on first request
- The buyer wallet needs USDC deposited (`antseed buyer deposit`) and ETH for gas on Base
