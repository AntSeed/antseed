# @antseed/download-proxy

Cloudflare Worker on **download.antseed.com** that serves the desktop
installers from GitHub Releases through our own domain, closing the visibility
gap between "user clicked the download button" (the website's `download_vpr`
GA4 event) and "user actually received the installer".

## Why a proxy

- A link straight to a GitHub release asset is fire-and-forget: the browser
  reports nothing about the download, and GitHub's `download_count` only
  counts request *starts*, mixed together with electron-updater traffic on
  Windows/Linux.
- Streaming the bytes through a Worker gives a deterministic signal for
  **started**, **completed**, and **aborted** per download, with platform,
  release tag, bytes, duration, and country.
- The auto-updater keeps fetching from GitHub directly, so traffic through
  this proxy is purely website-driven fresh downloads on every platform.
- Stable URLs (`/vpr/mac-arm64`, …) mean the website no longer needs a
  client-side GitHub API call to build the CTA href.

## Routes

| Route | Behavior |
| --- | --- |
| `GET /vpr/<platform>-<arch>` | Streams the latest matching installer. Platforms: `mac` (.dmg), `win` (.exe), `linux` (.AppImage); arch `arm64` \| `x64`. |
| `GET /` and unresolvable targets | 302 to the GitHub releases page. |

"Latest" is resolved from the GitHub API and cached at the edge for 5
minutes, so a fresh release is picked up within minutes with one API call per
burst. Range requests are forwarded (resumed downloads work) and flagged
`partial=1` in telemetry.

## Telemetry

Events: `download_started`, `download_completed`, `download_aborted`,
`download_unresolved`. Each is logged as a JSON console line (see them with
`pnpm --filter @antseed/download-proxy tail`, or in Workers Logs) and, when
GA4 credentials are configured, sent to GA4 via the Measurement Protocol —
the same property that records the website's `download_vpr` clicks, so the
full funnel reads in one place.

Funnel note: count completions with `partial=0`; `partial=1` completions are
resumed byte ranges. The transfer runs through workerd's native pipe (a JS
per-chunk pump would exceed the Workers CPU limit on installer-sized files),
so per-chunk byte counting isn't possible: `download_completed` implies the
full `total_bytes` were delivered (enforced by `FixedLengthStream`), while
`download_aborted` delivered an unknown prefix and carries only `duration_ms`. Each proxy event uses a random Measurement Protocol
`client_id`, so GA4 sees them as standalone hits (fine for counting; joining
to the website session would require passing the GA client id on the URL).

## Deploy

```bash
pnpm --filter @antseed/download-proxy deploy       # wrangler deploy
wrangler secret put GA4_API_SECRET                 # GA4 MP API secret (Admin → Data Streams → Measurement Protocol)
wrangler secret put GITHUB_TOKEN                   # optional: raises the release-lookup rate limit
```

Also set `GA4_MEASUREMENT_ID` in `wrangler.toml` (`G-…`, not a secret).
Leaving it empty disables GA4 delivery; console logging still works.

The custom domain in `wrangler.toml` requires `antseed.com` to be a zone on
the same Cloudflare account (Workers → antseed-download-proxy → Domains &
Routes shows the binding after deploy). Remove the `[[routes]]` block to test
on workers.dev first.

## Limitations / future work

- **No edge caching of installer bytes (v1):** every download streams from
  GitHub's CDN through the Worker, so throughput matches a direct GitHub
  download. GitHub's signed redirect URLs rotate per request, which defeats
  naive cache keying; if origin speed or reliability becomes a problem, put
  the installers in R2 behind these same URLs (CI upload step) — the website
  and telemetry don't change.
- "Completed" means the last byte was handed to the client connection — a
  finished download that never gets opened is still invisible. Closing that
  requires a first-launch ping in the desktop app.
