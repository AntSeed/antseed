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

Initialize your node — this installs provider and router plugins and creates `~/.antseed/config.json`:

```bash
antseed init
```

Verify:

```bash
antseed --version
```

## Desktop App

AntSeed Desktop is a standalone app for macOS that bundles the CLI, a chat interface, and encrypted identity storage via the OS keychain.

Download from [GitHub Releases](https://github.com/AntSeed/antseed/releases).

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

- [Using the API](/using-the-api) — connect as a buyer and start making requests
- [Become a Provider](/become-a-provider) — register, stake, and start earning
- [Payments](/payments) — deposit USDC, understand pricing and settlement
