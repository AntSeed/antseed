---
sidebar_position: 2
slug: /flags
title: Global Flags
sidebar_label: Flags
hide_title: true
---

# Global Flags

```bash title="flags"
-c, --config <path>     Path to config file (default: ~/.antseed/config.json)
--data-dir <path>       Path to node identity/state directory (default: ~/.antseed)
-v, --verbose            Enable verbose logging
--version                Show version
--help                   Show help
```

## Environment Variables

| Variable | Description |
|---|---|
| `ANTSEED_IDENTITY_HEX` | secp256k1 private key (64 hex chars). When set, used instead of `identity.key` file. Cleared from process environment after read. |
| `ANTSEED_DEBUG` | Enable verbose runtime logs (`0` or `1`) |
| `ANTSEED_ENV_FILE` | Override env file path for runtime env loading |
| ~~`ANTSEED_ALLOWED_SERVICES`~~ | Removed as a user-facing env var. The set of announced services is now derived from the keys under `seller.providers[name].services` in `config.json`. The CLI still injects the env var for plugins internally. |
| `ANTSEED_ENABLE_SETTLEMENT` | Enable on-chain settlement (`true`/`false`) |
| `ANTSEED_SETTLEMENT_IDLE_MS` | Settlement idle timeout in milliseconds |
| `ANTSEED_DEFAULT_SESSION_USDC` | Default session authorization amount in USDC |
| `ANTSEED_AUTO_FUND_DEPOSIT` | Auto-fund deposit on session start (`true`/`false`) |
| `ANTSEED_SELLER_WALLET_ADDRESS` | Seller EVM wallet address override |
