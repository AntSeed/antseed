# AntSeed Desktop (Electron)

Alternative GUI interface for AntSeed on macOS/Linux/Windows.

This app runs AntSeed runtime commands in the background (seller start / buyer start / dashboard)
so end users do not need to use terminal commands directly.

## What it controls

- Seller mode (`antseed seller start`)
- Buyer mode (`antseed buyer start`)
- Dashboard server (`antseed dashboard --port <port> --no-open`)
- Embedded dashboard panel inside Electron (no browser tab required)
- Live process logs and daemon state snapshot (`~/.antseed/daemon.state.json`)

## Prerequisites

1. Install the `antseed` CLI binary so it is available on your `PATH`.

```bash
# example: from this monorepo's cli package
cd ../cli
npm install
npm run build
npm link
```

2. Install desktop dependencies:

```bash
npm install
```

Optional: if your CLI binary is not on `PATH`, set `ANTSEED_CLI_BIN` to an absolute executable path.

```bash
export ANTSEED_CLI_BIN=/absolute/path/to/antseed
```

## Run

Development mode:

```bash
npm run dev
```

Run multiple development worktrees at once while sharing the normal AntSeed
buyer, configuration, plugins, and identity:

```bash
pnpm dev:desktop:instance status
pnpm dev:desktop:instance codex
pnpm dev:desktop:instance ui
pnpm dev:desktop:instance feature-x
```

Any instance name receives stable, separate renderer, payments, and system-proxy ports
plus its own temporary Electron Chromium profile and volatile system-proxy
runtime files. The buyer proxy and durable `~/.antseed` data remain shared.
The first instance starts the buyer; later instances validate its AntSeed
status endpoint and attach without starting duplicate buyer nodes.
In multi-instance mode, stopping, quitting, or disconnecting any
window does not remove shared Codex/tool config patches or kill the shared
buyer listener. Use the normal single-instance workflow when you intentionally
want the Stop button to shut down the buyer.

Build desktop assets:

```bash
npm run build
```

### Telegram feedback channel

The Help & Support feedback action posts through a dedicated Telegram bot. Source builds
keep the action disabled unless both variables are configured:

```bash
export ANTSEED_FEEDBACK_TELEGRAM_BOT_TOKEN='123456:bot-token'
export ANTSEED_FEEDBACK_TELEGRAM_CHAT_ID='@channelusername' # or -100…
npm run dev
```

Release CI runs `scripts/bake-feedback-telegram-config.mjs --require` before
compilation, using GitHub Actions secrets with the same names. The generated
source defaults remain `null` in git; the runtime environment overrides baked
values for local testing.

Use a disposable bot that is an administrator only in the feedback channel and
grant only **Post Messages**. Never reuse the personal Telegram bridge bot. The
token is compiled into public Electron artifacts and can be extracted, so treat
it as exposed: monitor the channel, remove the bot or revoke the token to disable
submissions, and rotate it immediately if abused. A server-side relay is required
before this channel handles sensitive or high-volume production feedback.

Diagnostic logs are opt-in and privacy-redacted before upload. The app masks
credentials, emails, local home paths, IP addresses, wallet addresses, and peer
IDs, retains at most 500 recent entries, and caps the log at 512 KiB.

Start app from built assets:

```bash
npm run start
```

## Notes

- This is phase 1 desktop integration: it shells out to the existing `antseed` runtime for parity and reliability.
- Keychain usage and network port handling follow the same behavior as the existing runtime stack.
- macOS may prompt for firewall/network permissions when listener ports are opened.
- On system sleep, runtime processes can pause; app should be expected to recover on wake.
