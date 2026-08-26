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
  /** Client User-Agent — separates real browsers from bots and scripts. */
  userAgent: string;
  /** Cloudflare's verified-bot category (e.g. "Search Engine Crawler"), or null. */
  botCategory: string | null;
}

function baseParams(ctx: DownloadContext): Record<string, string | number> {
  const params: Record<string, string | number> = {
    platform: ctx.target.platform,
    arch: ctx.target.arch,
    asset: ctx.asset,
    release_tag: ctx.tag ?? 'unknown',
    country: ctx.country,
    partial: ctx.partial ? 1 : 0,
    // GA4 Measurement Protocol caps param values at 100 chars; a truncated
    // UA still identifies the client family.
    user_agent: ctx.userAgent.slice(0, 100) || 'unknown',
  };
  if (ctx.botCategory) {
    params['bot_category'] = ctx.botCategory;
  }
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

const GA_CLIENT_ID_RE = /^\d{5,15}\.\d{5,15}$/;
const GA_SESSION_ID_RE = /^\d{8,12}$/;

export interface GaIds {
  clientId: string | null;
  sessionId: string | null;
}

/**
 * GA attribution ids the website appends to download URLs (?cid=...&sid=...),
 * read from the visitor's first-party _ga cookies. Strictly validated — these
 * arrive on a public URL, and anything malformed is dropped rather than
 * forwarded to GA.
 */
export function parseGaIds(params: URLSearchParams): GaIds {
  const cid = params.get('cid');
  const sid = params.get('sid');
  return {
    clientId: cid && GA_CLIENT_ID_RE.test(cid) ? cid : null,
    sessionId: sid && GA_SESSION_ID_RE.test(sid) ? sid : null,
  };
}

export interface Ga4Delivery {
  measurementId?: string;
  apiSecret?: string;
  ids?: GaIds;
}

/**
 * Fire-and-forget delivery: console line always, GA4 when configured. When
 * the website passed the visitor's GA client id (see parseGaIds), the event
 * is sent under that client_id — and session_id — so it lands inside the
 * same GA4 user and session as the download_vpr click, inheriting source,
 * campaign, and landing page. Without it (direct links, shared URLs), a
 * random UUID keeps the event countable but unattributed.
 */
export async function deliverEvent(event: DownloadEvent, ga: Ga4Delivery): Promise<void> {
  console.log(JSON.stringify({event: event.name, ...event.params, attributed: ga.ids?.clientId ? 1 : 0}));
  if (!ga.measurementId || !ga.apiSecret) return;
  const params = ga.ids?.sessionId
    ? {...event.params, session_id: Number(ga.ids.sessionId)}
    : event.params;
  const url =
    `${GA4_ENDPOINT}?measurement_id=${encodeURIComponent(ga.measurementId)}` +
    `&api_secret=${encodeURIComponent(ga.apiSecret)}`;
  await fetch(url, {
    method: 'POST',
    body: JSON.stringify({
      client_id: ga.ids?.clientId ?? crypto.randomUUID(),
      events: [{name: event.name, params}],
    }),
  }).catch(() => {});
}
