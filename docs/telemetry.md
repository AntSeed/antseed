# VPR Desktop Telemetry

The AntSeed VPR desktop app collects anonymous, privacy-first product
telemetry to understand the activation funnel (first open → setup → deposit →
first chat) and app reliability. This document lists every event and property,
what is never collected, and how to disable telemetry.

Implementation: `apps/desktop/src/main/telemetry/`
(`telemetry.ts`, `events.ts`, `sanitize.ts`, `posthog.ts`, `state.ts`).

## What we collect

Every event includes this envelope:

| Property | Description |
| --- | --- |
| `schema_version` | Event schema version (currently `1`). |
| `event_ts_ms` | Event timestamp in milliseconds. |
| `install_id` | Random UUID generated once on first launch. |
| `session_id` | Random UUID regenerated on every launch. |
| `app_version` | Desktop app version (e.g. `0.2.31`). |
| `platform` | Operating system (`darwin`, `win32`, `linux`). |
| `arch` | CPU architecture (`x64`, `arm64`). |
| `install_source` | Distribution channel (`dmg`, `nsis`, `appimage`, `deb`, `unknown`). |

### Events

- `app_first_opened` — once per installation. Properties: `first_open_date`
  (YYYY-MM-DD).
- `app_started` — once per launch. Properties: `is_first_launch`.
- `setup_completed` — when first-run setup completes. Properties:
  `duration_bucket` (`under_30s`, `30s_2m`, `2m_5m`, `over_5m`).
- `deposit_completed` — when a deposit is observed credited. Properties:
  `method_category`, `amount_bucket` (`under_5`, `5_25`, `25_100`,
  `100_plus`), `is_first_deposit`, `days_since_first_open` (`0`, `1_7`,
  `8_30`, `31_plus`).
- `deposit_failed` — when automatic deposit setup or a sweep attempt fails.
  Properties: `method_category`, fixed `failure_code`, fixed `failure_stage`,
  and `retryable`. Raw provider, RPC, wallet, and relayer errors are never sent.
- `first_chat_started` — once per installation, on the first valid chat
  request. Properties: `had_deposit`, `deposit_bucket`,
  `days_since_first_open`, `service_category` (`chat`, `image`, `other`),
  `has_attachments`.
- `chat_request_finished` — once for every valid remote chat attempt, including
  success, failure, and cancellation. Properties: `outcome`, fixed
  `failure_code` and `failure_stage`, public advertised `public_model_id` (or
  `custom_or_unknown`), `service_category`, `route_mode`, coarse offer-count,
  HTTP-status and duration buckets, retry flags, `had_partial_output`, and
  `has_attachments`. Peer IDs and raw stream errors are never sent.
- `discovery_completed` — after every model discovery request. Properties:
  `outcome`, duration bucket, coarse service/peer/result count buckets, and
  `was_empty`.
- `app_closed` — on clean shutdown (`was_crash: false`), or recovered on the
  next launch after an unclean shutdown (`was_crash: true`). Properties:
  `was_crash`, `session_duration_bucket`.

## What we never collect

- Prompts, chat messages, or assistant responses
- Wallet addresses or transaction hashes
- Exact balances, deposits, or spending (only coarse buckets)
- Files, attachment contents, file names, or paths
- Environment variables, command lines, logs, or stack traces
- Peer IDs
- Raw provider, model, relayer, RPC, or discovery errors
- Location, IP-derived fields, session recordings, screenshots, or frontend
  autocapture

All event properties pass through a strict allowlist: unknown properties are
dropped, strings are truncated to 64 characters, numbers are bounded, and
bucket values are validated.

Failure events use fixed local taxonomies. Error messages are classified on
device and discarded before the telemetry service is called. Exact model IDs
are included only when the selected service is in the current public catalog
and matches a conservative slug format; other values become
`custom_or_unknown`.

The setup event is emitted only after an actual first-run plugin installation
starts. Routine refreshes of an already-installed plugin do not begin a setup
measurement; a repair may only finish a first-run measurement that was already
started before an interrupted install.
Immediately before the first valid chat is submitted, VPR reads the current
on-chain deposit balance locally and converts it to `had_deposit` and a coarse
bucket. The exact balance never enters the telemetry service.

## Anonymous ID

`install_id` is a random UUID generated on first launch and stored locally in
the app's user data directory. It is not derived from a wallet address,
machine identifier, hostname, account, or OS identifier. A fresh
`session_id` is generated on every launch.

## How to disable telemetry

- In the app: **Preferences → Privacy → Anonymous telemetry** toggle.
- Environment kill switch: set `TELEMETRY_ENABLED=false` (or `0` / `no`).
- Telemetry is always disabled in development builds and when no PostHog
  project is configured.

Release builds bake the public PostHog ingestion host and project token from
CI configuration because GUI-launched desktop apps do not inherit build-shell
environment variables. A release fails if either value is missing. Source
builds contain no default and therefore send nothing unless configured locally.

## Data handling

- Events are sent to PostHog over HTTPS, fire-and-forget with a short
  timeout; PostHog outages never affect the app.
- Telemetry failures never block startup, chat, payments, or shutdown.
- Every capture sets `$geoip_disable: true`, so PostHog does not enrich events
  with location derived from the request IP.
- Every capture sets `$process_person_profile: false`; anonymous installation
  events do not create PostHog person profiles.
- Clean shutdown waits only for the local crash marker to be cleared. It never
  waits for PostHog delivery.
- While VPR runs, a local-only heartbeat updates the crash marker once per
  minute. Crash recovery uses the last heartbeat, so time spent offline before
  the next launch is not counted as session duration.
- Contact: hello@antseed.com

The PostHog hosting region and retention period are deployment policy, not
application defaults. They must be approved and documented here before the
release secrets are enabled for production.
