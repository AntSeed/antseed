---
sidebar_position: 2
slug: /install
title: Install
hide_title: true
---

# Install

## CLI

AntSeed requires Node.js 20+ and works on macOS, Linux, and Windows (WSL).

```bash
npm install -g @antseed/cli
```

Set up your node:

```bash
antseed seller setup
```

Verify:

```bash
antseed --version
```

## Desktop App

AntSeed Desktop (AntStation) is a standalone app that bundles the CLI, a
chat interface, and encrypted identity storage via the OS keychain.

**Downloads:**

- **macOS** — `.dmg` for Apple Silicon (arm64) and Intel (x64). Signed and
  notarized; no Gatekeeper warning.
- **Windows** — `.exe` NSIS installer for x64 and arm64. Currently
  unsigned; Windows SmartScreen will ask you to confirm on first run
  (click *More info* → *Run anyway*).
- **Linux** — not yet packaged. Run the CLI directly for now.

Pick your installer on the [latest release page](https://github.com/AntSeed/antseed/releases/latest),
or use the OS-aware download buttons on [antseed.com](https://antseed.com).

## Identity

Your node identity is a secp256k1 private key. The corresponding EVM address is your PeerId on the network and your on-chain wallet. One key for everything — P2P, payments, wallet.

Set it via environment variable (recommended):

```bash
export ANTSEED_IDENTITY_HEX=<64-char-hex-private-key>
```

If you don't set one, the CLI generates a key at `~/.antseed/identity.key` on first run. For production, use an env var with a secrets manager instead of a plaintext file.

:::tip
Back up your identity key. Losing it means a new identity on the network and loss of access to on-chain funds.
:::

## Next Steps

- [Using the API](/docs/guides/using-the-api) — connect as a buyer and start making requests
- [Become a Provider](/docs/guides/become-a-provider) — register, stake, and start earning
- [Payments](/docs/guides/payments) — deposit USDC, understand pricing and settlement
- [Metrics](/docs/guides/metrics) — expose Prometheus-compatible buyer and seller metrics
