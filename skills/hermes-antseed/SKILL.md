---
name: hermes-antseed
description: "Connect a Hermes agent to the AntSeed P2P AI network. Install the buyer proxy, configure the chain, fund the wallet via the payments portal, and wire Hermes to route through AntSeed. Use when: user asks to connect Hermes to AntSeed, set up AntSeed for a Hermes agent, deposit funds for Hermes, or change the routed model."
user-invocable: true
metadata: { "hermes-antseed": { "emoji": "🐝" } }
---

# Connect Hermes to AntSeed

Set up AntSeed as the model backend for a Hermes agent. Hermes is the agent framework (successor to OpenClaw) and AntSeed is a P2P network of AI service providers. The buyer proxy runs next to Hermes and routes its LLM calls through the network.

This skill replaces `openclaw-antseed`, which is stale.

## Picture

```
Hermes agent  →  127.0.0.1:8377  →  AntSeed P2P  →  Provider peer  →  Upstream API
                 (buyer proxy)      (on-chain payment channels)
```

- Buyer proxy discovers providers via DHT, opens a payment channel per seller, signs per-request vouchers.
- Exposes an OpenAI-compatible `/v1/*` endpoint — that's what Hermes points at as `OPENAI_BASE_URL`.
- The model ID Hermes passes is the AntSeed **service ID** (e.g. `minimax-m2.5`), not an OpenAI model name.

The buyer proxy and Hermes can run on the same machine (laptop, VPS, cloud box — anywhere). The only requirement is that Hermes can reach `127.0.0.1:8377`.

## Before you start

Ask the user anything you don't already have:

- **Where Hermes is running** — same machine you're acting on, or a remote host you reach over SSH. Most setup steps are identical; remote hosts just need everything prefixed with `ssh user@host`.
- **Chain** — `base-mainnet` for real funds, `base-sepolia` for testnet. Default to `base-mainnet` unless the user says otherwise.

---

## Install the CLI

```bash
npm install -g @antseed/cli
antseed --version
```

Requires Node.js 20+. Latest version: `npm view @antseed/cli version`. A global `npm install` can take 1–3 minutes — use a long timeout.

## Chain configuration

Custom `~/.antseed/config.json` is optional. `antseed buyer start` works without one and will use built-in defaults.

Create the file only if you want advanced settings such as pricing caps or a non-default chain:

```json
{
  "network": {},
  "buyer": {
    "minPeerReputation": 0,
    "maxPricing": {
      "defaults": {
        "inputUsdPerMillion": 100,
        "outputUsdPerMillion": 100
      }
    }
  },
  "payments": {
    "preferredMethod": "crypto",
    "crypto": {
      "chainId": "base-mainnet"
    }
  }
}
```

**Do not hardcode contract addresses.** `@antseed/node` resolves Deposits, Channels, USDC, and the RPC URL from `chainId` via its built-in chain-config presets. Hardcoded addresses drift when contracts redeploy; the preset is the source of truth.

To switch chains later, edit only `chainId` (`base-mainnet` ↔ `base-sepolia`) and restart the buyer.

## Identity and the buyer wallet

The buyer needs an EVM identity — a 32-byte secp256k1 private key supplied via the `ANTSEED_IDENTITY_HEX` env var (64 hex chars, optional `0x` prefix), or already present in `~/.antseed/identity.key`.

The EVM address derived from that key is your **buyer wallet**. It needs:

- **USDC on the target chain** — used as payment channel reserves
- **Native token (ETH on Base)** — used for gas on deposit, operator signing, and withdraw

**Never move `identity.key` off the host that runs the buyer.** The hot wallet stays put. Funding happens via the payments portal running on that host (see next section), not by exporting the key to a wallet app on another machine.

Check balance any time:

```bash
antseed buyer balance
```

## Running the buyer proxy

Foreground, for a laptop or a quick test:

```bash
antseed buyer start
```

Advanced: if Hermes must use a non-default proxy port:

```bash
antseed buyer start --port 5005
```

Persistent (Linux, systemd):

```bash
sudo tee /etc/systemd/system/antseed-buyer.service > /dev/null <<EOF
[Unit]
Description=AntSeed Buyer Proxy
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$USER
Environment=ANTSEED_IDENTITY_HEX=<64-hex-no-0x>
ExecStart=/usr/bin/env antseed buyer start
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now antseed-buyer
```

The service user must own the `~/.antseed/` directory that holds `config.json` and `identity.key`.

The buyer startup log prints the Deposits/Channels addresses and RPC URL it bound to — glance at those to confirm it's on the chain you expected.

## Funding via the payments portal

`antseed payments` starts a local web UI bound to `127.0.0.1:3118`, protected by a random bearer token printed once at startup. Use it to deposit USDC, view channel state, and withdraw.

```bash
antseed payments
# Payments portal running at http://127.0.0.1:3118?token=<hex>
```

Open the printed URL in a browser **with the `?token=...` query string intact** — the frontend reads the token from `window.location.search` exactly once and caches it. If you land on `/` without the token, every API call returns 401.

The token rotates on every portal restart. If you've restarted the portal and the browser starts returning 401s, tell the user to close the tab fully and reopen with the new URL — a refresh alone won't drop the cached token.

From the portal, the user connects an external wallet (MetaMask, Coinbase Wallet, etc.) and signs the deposit transaction there. USDC flows from the user's cold wallet into the Deposits contract, credited to the buyer address.

### When Hermes runs on a remote host

If the buyer runs on a remote box, `127.0.0.1:3118` isn't reachable from the user's browser directly. Start the portal on the remote host detached, then SSH-forward the port to the user's laptop.

Start the portal remotely so it survives the SSH call returning:

```bash
ssh user@host "nohup antseed payments > /tmp/antseed-payments.log 2>&1 </dev/null & disown"
ssh user@host "cat /tmp/antseed-payments.log"   # read back the bearer token
```

A bare `ssh user@host "antseed payments &"` will die on disconnect — always `nohup` + `disown` + redirect stdio.

Then open a local forward on the user's laptop:

```bash
ssh -N -L 127.0.0.1:3118:127.0.0.1:3118 user@host
```

Bind the left-hand side explicitly to `127.0.0.1:` — omitting the host lets OpenSSH pick IPv6-only, which many browsers then fail to reach.

Give the user `http://127.0.0.1:3118/?token=<hex>` (the URL from the portal log). The browser hits the local forward, which reaches the remote portal.

If `ssh -L` fails with `channel 1: open failed: administratively prohibited`, the remote sshd has `AllowTcpForwarding no`. Enable it in `/etc/ssh/sshd_config` (or a drop-in under `/etc/ssh/sshd_config.d/`), run `sudo sshd -t` to validate, then `sudo systemctl reload sshd`. Existing SSH sessions are not dropped by the reload.

## Wiring Hermes to the buyer proxy

Hermes reads `OPENAI_API_KEY` and `OPENAI_BASE_URL` from its `.env`:

```
OPENAI_API_KEY=antseed-p2p
OPENAI_BASE_URL=http://127.0.0.1:8377/v1
```

The API key value doesn't matter — the buyer proxy ignores it — but Hermes refuses to start if `OPENAI_API_KEY` is unset, so always set it to something non-empty.

In the Hermes config, register AntSeed as a custom provider pointing at `http://127.0.0.1:8377/v1`, then set the model ID to an AntSeed service ID. List what's live on the network:

```bash
antseed network browse
```

To swap the routed model later, edit only the Hermes config and restart Hermes — the buyer proxy stays up. No CLI change, no contract call.

## Sanity check

```bash
antseed buyer balance                            # funds are present
curl -s http://127.0.0.1:8377/v1/models | head   # buyer proxy is answering
```

Then send a prompt through Hermes and watch the buyer log — you should see a channel open on the first request, then per-request voucher signing.
