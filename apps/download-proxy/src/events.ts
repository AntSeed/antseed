/**
 * Download telemetry events.
 *
 * Every event is logged as one structured JSON line (visible via
 * `wrangler tail` and Workers Logs), and — when the GA4 credentials are
 * configured — forwarded to the same GA4 property that records the website's
 * `download_vpr` click events, so the click → started → completed funnel can
 * be read in one place.
 *
 * Event names:
 *   download_started     transfer to the client began
 *   download_completed   origin fully drained and delivered to the client
 *   download_aborted     client disconnected (or origin failed) mid-transfer
 *   download_unresolved  no matching installer (partial release, API failure)
 *
 * A 206 Range response carries partial=1 — resumed downloads complete "their"
 * range, so funnel analysis should count completions with partial=0.
 */

import type {Target} from './assets';
import type {PumpResult} from './stream';

export interface DownloadEvent {
  name: string;
  params: Record<string, string | number>;
}

export interface DownloadContext {
  target: Target;
  asset: string;
  tag: string | null;
  country: string;
  partial: boolean;
  totalBytes: number | null;
}

function baseParams(ctx: DownloadContext): Record<string, string | number> {
  const params: Record<string, string | number> = {
    platform: ctx.target.platform,
    arch: ctx.target.arch,
    asset: ctx.asset,
    release_tag: ctx.tag ?? 'unknown',
    country: ctx.country,
    partial: ctx.partial ? 1 : 0,
  };
  if (ctx.totalBytes !== null) {
    params['total_bytes'] = ctx.totalBytes;
  }
  return params;
}

export function startEvent(ctx: DownloadContext): DownloadEvent {
  return {name: 'download_started', params: baseParams(ctx)};
}

export function endEvent(ctx: DownloadContext, pump: PumpResult): DownloadEvent {
  const params: Record<string, string | number> = {
    ...baseParams(ctx),
    duration_ms: pump.durationMs,
  };
  // The native pipe can't count bytes per chunk (see stream.ts) — a completed
  // transfer delivered the full total_bytes; an aborted one delivered some
  // unknown prefix of it.
  if (pump.completed && ctx.totalBytes !== null) {
    params['bytes_sent'] = ctx.totalBytes;
  }
  return {name: pump.completed ? 'download_completed' : 'download_aborted', params};
}

export function unresolvedEvent(
  target: Target,
  tag: string | null,
  reason: string,
): DownloadEvent {
  return {
    name: 'download_unresolved',
    params: {
      platform: target.platform,
      arch: target.arch,
      release_tag: tag ?? 'unknown',
      reason,
    },
  };
}

const GA4_ENDPOINT = 'https://www.google-analytics.com/mp/collect';

/**
 * Fire-and-forget delivery: console line always, GA4 when configured. The
 * Measurement Protocol requires a client_id; a random UUID per request means
 * each download appears as its own GA4 "user", which is fine for funnel
 * counting (joining to the website session is a possible later refinement by
 * passing the GA client id as a query param on the download URL).
 */
export async function deliverEvent(
  event: DownloadEvent,
  measurementId: string | undefined,
  apiSecret: string | undefined,
): Promise<void> {
  console.log(JSON.stringify({event: event.name, ...event.params}));
  if (!measurementId || !apiSecret) return;
  const url =
    `${GA4_ENDPOINT}?measurement_id=${encodeURIComponent(measurementId)}` +
    `&api_secret=${encodeURIComponent(apiSecret)}`;
  await fetch(url, {
    method: 'POST',
    body: JSON.stringify({client_id: crypto.randomUUID(), events: [event]}),
  }).catch(() => {});
}
