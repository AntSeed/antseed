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

Build desktop assets:

```bash
npm run build
```

Start app from built assets:

```bash
npm run start
```

## Notes

- This is phase 1 desktop integration: it shells out to the existing `antseed` runtime for parity and reliability.
- Keychain usage and network port handling follow the same behavior as the existing runtime stack.
- macOS may prompt for firewall/network permissions when listener ports are opened.
- On system sleep, runtime processes can pause; app should be expected to recover on wake.
