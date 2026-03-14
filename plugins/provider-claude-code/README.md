# @antseed/provider-claude-code

> **Testing and development only.** This plugin reads credentials from your personal Claude Code subscription. Reselling subscription-based access violates Anthropic's Terms of Service and is not permitted. Use this plugin only for local development, testing, and demo purposes. For production use, see `@antseed/provider-anthropic` with a commercial API key.

Connect to the Anthropic API using Claude Code keychain credentials for local testing and development. No API key needed -- reads OAuth tokens directly from the macOS keychain.

## Installation

```bash
antseed plugin add @antseed/provider-claude-code
```

## Usage

```bash
antseed seed --provider claude-code
```

No API key configuration is required. The plugin reads credentials from the system keychain where Claude Code stores them.

## Configuration

| Key | Type | Required | Default | Description |
|-----|------|----------|---------|-------------|
| `ANTSEED_INPUT_USD_PER_MILLION` | number | No | 10 | Input token price (USD per 1M) |
| `ANTSEED_OUTPUT_USD_PER_MILLION` | number | No | 10 | Output token price (USD per 1M) |
| `ANTSEED_MAX_CONCURRENCY` | number | No | 10 | Max concurrent requests |
| `ANTSEED_ALLOWED_SERVICES` | string[] | No | -- | Comma-separated service allowlist |

## How It Works

Uses a custom `ClaudeCodeTokenProvider` that reads OAuth tokens from the macOS keychain via `keytar`. Tokens are automatically refreshed when they expire. The provider relays requests to `https://api.anthropic.com` using the retrieved credentials.

## Requirements

- macOS with Claude Code installed and authenticated
- `keytar` native module (installed automatically)
