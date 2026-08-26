import { ANTSEED_MODEL_MAX_OUTPUT_TOKENS } from '@antseed/node/types';
import http from 'node:http';
import net from 'node:net';
import {
  CLAUDE_GATEWAY_DEFAULT_PORT,
  ROUTED_MODEL_ALIAS,
} from '../system-proxy/config-patch.js';

/**
 * Loopback gateway for Claude Desktop's native third-party inference mode.
 *
 * Claude Desktop, once its profile points here (see the `claude-desktop`
 * config patch), sends its ordinary Anthropic Messages traffic to this
 * server: `GET /v1/models` for the model picker, `POST /v1/messages` and
 * `POST /v1/messages/count_tokens` for inference. The buyer proxy already
 * speaks all three — but its `/v1/models` catalog uses the OpenAI list shape,
 * and Claude's picker only accepts Anthropic's shape with family tiers. So
 * the gateway answers the catalog itself (see CLAUDE_MODEL_SLOTS) and
 * forwards the message routes to the buyer proxy with the model rewritten to
 * what its slot was advertised for — "AntSeed Auto" follows the route
 * selected in the desktop (floating pill / VPR), so it drives Claude
 * conversations live without a config rewrite.
 *
 * Plain HTTP reverse proxy on 127.0.0.1: Claude terminates its own gateway
 * protocol here, so no TLS interception or trust changes are involved.
 */

const MAX_REQUEST_BODY_BYTES = 64 * 1024 * 1024;
export const CLAUDE_GATEWAY_HEALTH_PATH = '/_antseed/claude-gateway';
export const CLAUDE_GATEWAY_HEALTH_HEADER = 'x-antseed-claude-gateway';
/** How long a routed-model lookup for the identity note stays fresh. */
const ROUTE_CACHE_TTL_MS = 5_000;
const ROUTE_LOOKUP_TIMEOUT_MS = 750;

/**
 * Claude Desktop's picker only lists the model ids it knows, grouped by
 * Anthropic family — so network models are advertised behind Claude's own
 * ids, with the real model name as the display name (exactly how Ollama's
 * gateway does it). Five ids means at most five entries: the first slot is
 * always "AntSeed Auto" (the route selected in the desktop), the rest carry
 * the top of the desktop's curated model picker. Advertised in Claude's
 * preferred order.
 */
const CLAUDE_MODEL_SLOTS: readonly { id: string; family: string; createdAt: string; familyDefault: boolean; identityPhrases: readonly string[] }[] = [
  { id: 'claude-fable-5', family: 'fable', createdAt: '2026-06-09T00:00:00Z', familyDefault: true, identityPhrases: ['Claude Fable 5', 'Fable 5'] },
  { id: 'claude-opus-5', family: 'opus', createdAt: '2026-07-24T00:00:00Z', familyDefault: true, identityPhrases: ['Claude Opus 5', 'Opus 5'] },
  { id: 'claude-sonnet-5', family: 'sonnet', createdAt: '2026-06-30T00:00:00Z', familyDefault: true, identityPhrases: ['Claude Sonnet 5', 'Sonnet 5'] },
  { id: 'claude-sonnet-4-6', family: 'sonnet', createdAt: '2025-11-18T00:00:00Z', familyDefault: false, identityPhrases: ['Claude Sonnet 4.6', 'Sonnet 4.6'] },
  { id: 'claude-haiku-4-5-20251001', family: 'haiku', createdAt: '2025-10-01T00:00:00Z', familyDefault: true, identityPhrases: ['Claude Haiku 4.5', 'Haiku 4.5'] },
];
const CLAUDE_GATEWAY_MODEL_LABEL = 'AntSeed Auto';

/** A model offered to Claude's picker: display label + the model the buyer
    proxy should route when Claude picks it. */
export type ClaudeGatewayModel = { label: string; model: string };

/**
 * Curated models for the picker slots, injected by main.ts from the chat
 * engine's model-picker snapshot (the renderer's favorites-then-recommended
 * rows — the same source the Telegram bridge offers). Module state rather
 * than a constructor dep because the chat engine is created after the
 * system-proxy runtime that starts this gateway.
 */
let sharedModelSource: (() => readonly ClaudeGatewayModel[]) | null = null;

export function setClaudeDesktopGatewayModelSource(source: () => readonly ClaudeGatewayModel[]): void {
  sharedModelSource = source;
}

/**
 * Internal marker the buyer proxy uses for conversation attribution and
 * strips before dispatch. Claude Desktop stamps `x-claude-cli-session-id` on
 * its requests — the same slug as t3code's Claude Code sessions — so without
 * this source override its chats would display under T3 Code. Must match
 * SYSTEM_PROXY_SOURCE_HEADER in apps/cli/src/proxy/request-utils.ts.
 */
const SYSTEM_PROXY_SOURCE_HEADER = 'x-antseed-system-proxy-source';
const CLAUDE_DESKTOP_SOURCE = 'claude-desktop';

/** Request headers forwarded to the buyer proxy verbatim. */
const FORWARDED_REQUEST_HEADERS = ['accept', 'anthropic-version', 'anthropic-beta', 'user-agent'] as const;
/** Hop-by-hop headers never copied onto the downstream response. */
const DROPPED_RESPONSE_HEADERS = new Set(['connection', 'keep-alive', 'transfer-encoding', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'upgrade']);

export type ClaudeDesktopGatewayOptions = {
  readonly port: number;
  readonly buyerPort: number;
  readonly log?: (line: string) => void;
  /** Curated picker models for the catalog slots; defaults to the shared
      source injected via setClaudeDesktopGatewayModelSource. */
  readonly listModels?: () => readonly ClaudeGatewayModel[];
};

export class ClaudeDesktopGateway {
  private server: http.Server | null = null;
  private boundPort: number | null = null;
  /** Claude slot id → model to route, as last advertised by /v1/models. */
  private slotModels = new Map<string, string>();

  constructor(private readonly options: ClaudeDesktopGatewayOptions) {}

  /** The listening port — resolved from the socket when constructed with 0. */
  get port(): number {
    return this.boundPort ?? this.options.port;
  }

  get buyerPort(): number {
    return this.options.buyerPort;
  }

  get running(): boolean {
    return this.server?.listening === true;
  }

  async start(): Promise<void> {
    if (this.server) return;
    const server = http.createServer((req, res) => this.handleRequest(req, res));
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        server.close();
        reject((err as NodeJS.ErrnoException).code === 'EADDRINUSE'
          ? new Error(`Claude gateway port ${this.options.port} is already in use — close the other process or set ANTSEED_CLAUDE_GATEWAY_PORT.`)
          : err);
      };
      server.once('error', onError);
      server.listen(this.options.port, '127.0.0.1', () => {
        server.off('error', onError);
        const address = server.address();
        this.boundPort = address && typeof address === 'object' ? address.port : this.options.port;
        resolve();
      });
    });
    this.server = server;
    this.options.log?.(`Claude Desktop gateway listening on 127.0.0.1:${this.port} (buyer proxy on ${this.options.buyerPort})`);
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = null;
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (!this.allowsHost(req.headers.host)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    // Claude Desktop uses a native HTTP client, not a browser — any request
    // carrying an Origin is something else probing the loopback port.
    if (req.headers.origin) {
      res.writeHead(403).end('forbidden');
      return;
    }
    const url = (req.url ?? '/').split('?')[0] ?? '/';
    if (url === CLAUDE_GATEWAY_HEALTH_PATH) {
      if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
      res.writeHead(204, { [CLAUDE_GATEWAY_HEALTH_HEADER]: '1' }).end();
      return;
    }
    if (url === '/v1/models') {
      if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
      this.serveModels(res);
      return;
    }
    if (url === '/v1/messages' || url === '/v1/messages/count_tokens') {
      if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
      this.forwardMessages(req, res, url);
      return;
    }
    writeAnthropicError(res, 404, 'not_found_error', 'Not found');
  }

  /** Loopback host with our port only — a DNS-rebound page resolves to us but
      carries its own hostname, and must not reach the gateway. */
  private allowsHost(hostHeader: string | undefined): boolean {
    const match = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(hostHeader ?? '');
    if (!match) return false;
    const host = match[1]!.replace(/^\[|\]$/g, '');
    if ((match[2] ?? '') !== String(this.port)) return false;
    if (host.toLowerCase() === 'localhost') return true;
    if (net.isIP(host) === 0) return false;
    return host === '::1' || host.startsWith('127.');
  }

  /** Slot assignments: "AntSeed Auto" first, then the curated picker models
      (deduped, in picker order) behind the remaining Claude ids. Also
      refreshes the slot→model routing map used by forwardMessages. */
  private assignSlots(): { slot: typeof CLAUDE_MODEL_SLOTS[number]; label: string; model: string }[] {
    const listed = (this.options.listModels ?? sharedModelSource)?.() ?? [];
    const picks: ClaudeGatewayModel[] = [];
    const seen = new Set<string>();
    for (const entry of listed) {
      const model = entry.model.trim();
      if (!model || seen.has(model)) continue;
      seen.add(model);
      picks.push({ label: entry.label.trim() || model, model });
      if (picks.length >= CLAUDE_MODEL_SLOTS.length - 1) break;
    }
    const assignments = [
      { slot: CLAUDE_MODEL_SLOTS[0]!, label: CLAUDE_GATEWAY_MODEL_LABEL, model: ROUTED_MODEL_ALIAS },
      ...picks.map((pick, index) => ({ slot: CLAUDE_MODEL_SLOTS[index + 1]!, ...pick })),
    ];
    this.slotModels = new Map(assignments.map(({ slot, model }) => [slot.id, model]));
    return assignments;
  }

  private serveModels(res: http.ServerResponse): void {
    const data = this.assignSlots().map(({ slot, label }) => ({
      id: slot.id,
      type: 'model',
      display_name: label,
      created_at: slot.createdAt,
      max_tokens: ANTSEED_MODEL_MAX_OUTPUT_TOKENS,
      anthropic_family_tier: slot.family,
      is_family_default: slot.familyDefault,
    }));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      data,
      first_id: data[0]?.id ?? null,
      last_id: data[data.length - 1]?.id ?? null,
      has_more: false,
    }));
  }

  /**
   * What the routed-model alias currently resolves to (the service part of
   * the buyer's default route), so the identity note can name the model that
   * actually answers instead of "whatever the desktop routes to" — without a
   * name, models fall back to the Claude id in the client metadata when asked
   * what they are. Cached briefly; null (buyer down, no route yet) falls back
   * to the generic wording.
   */
  private routeCache: { model: string | null; fetchedAt: number } = { model: null, fetchedAt: 0 };

  private async resolveRoutedModelName(): Promise<string | null> {
    const now = Date.now();
    if (now - this.routeCache.fetchedAt < ROUTE_CACHE_TTL_MS) return this.routeCache.model;
    let model: string | null = null;
    try {
      const response = await fetch(
        `http://127.0.0.1:${this.options.buyerPort}/_antseed/route`,
        { signal: AbortSignal.timeout(ROUTE_LOOKUP_TIMEOUT_MS) },
      );
      if (response.ok) {
        const payload = await response.json() as { model?: unknown };
        if (typeof payload.model === 'string' && payload.model.trim().length > 0) {
          const route = payload.model.trim();
          const at = route.indexOf('@');
          model = at >= 0 ? route.slice(at + 1) : route;
        }
      }
    } catch {
      // Buyer unreachable or slow — the note keeps its generic wording.
    }
    this.routeCache = { model, fetchedAt: now };
    return model;
  }

  private forwardMessages(req: http.IncomingMessage, res: http.ServerResponse, url: string): void {
    collectBody(req, (err, body) => {
      if (err) {
        writeAnthropicError(res, err.statusCode, 'invalid_request_error', err.message);
        return;
      }
      void this.forwardCollectedBody(req, res, url, body);
    });
  }

  private async forwardCollectedBody(req: http.IncomingMessage, res: http.ServerResponse, url: string, body: Buffer): Promise<void> {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        // Claude authenticates to this loopback gateway with the placeholder
        // key from its profile; never forward that credential upstream.
        'x-api-key': 'antseed',
        [SYSTEM_PROXY_SOURCE_HEADER]: CLAUDE_DESKTOP_SOURCE,
      };
      for (const name of FORWARDED_REQUEST_HEADERS) {
        const value = req.headers[name];
        if (typeof value === 'string') headers[name] = value;
      }
      // Claude may send a slot id from a catalog served before this process
      // started; make sure the slot map exists before resolving against it.
      if (this.slotModels.size === 0) this.assignSlots();
      // The identity note goes only on real message turns — count_tokens
      // never reaches a model.
      const identityNote = url === '/v1/messages';
      const routedModelName = identityNote ? await this.resolveRoutedModelName() : null;
      const payload = rewriteModel(body, this.slotModels, { identityNote, routedModelName });
      headers['content-length'] = String(Buffer.byteLength(payload));
      const upstream = http.request(
        { host: '127.0.0.1', port: this.options.buyerPort, path: url, method: 'POST', headers },
        (upstreamRes) => {
          const responseHeaders: Record<string, string | string[]> = {};
          for (const [name, value] of Object.entries(upstreamRes.headers)) {
            if (value !== undefined && !DROPPED_RESPONSE_HEADERS.has(name.toLowerCase())) responseHeaders[name] = value;
          }
          res.writeHead(upstreamRes.statusCode ?? 502, responseHeaders);
          upstreamRes.pipe(res);
        },
      );
      upstream.on('error', () => {
        if (res.headersSent) {
          res.destroy();
          return;
        }
        writeAnthropicError(res, 502, 'api_error', 'AntSeed is not reachable — open the AntSeed desktop app and try again.');
      });
      // A request's own 'close' fires once its body is consumed — only a
      // response that closes before finishing means Claude went away.
      res.on('close', () => {
        if (!res.writableEnded) upstream.destroy();
      });
      upstream.end(payload);
  }
}

/**
 * Rewrite the requested model to what its Claude slot id was advertised for,
 * falling back to the routed-model alias (the route picked in the desktop).
 * An explicit `<peerId>@<service>` pin and the alias itself pass through;
 * anything unparseable is forwarded verbatim so the buyer proxy produces the
 * meaningful error.
 *
 * With `identityNote`, a routing note is appended to the system prompt:
 * Claude Desktop tells the model it is the Claude id from the catalog, and
 * since only Claude ids can be advertised (see CLAUDE_MODEL_SLOTS), the
 * network model serving the chat would otherwise claim to be that Claude
 * model when asked what it is.
 */
export function rewriteModel(
  body: Buffer,
  slotModels: ReadonlyMap<string, string>,
  opts: { identityNote?: boolean; routedModelName?: string | null } = {},
): Buffer {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return body;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return body;
  const request = parsed as Record<string, unknown>;
  const model = request['model'];
  const passthrough = typeof model === 'string' && (model === ROUTED_MODEL_ALIAS || model.includes('@'));
  if (passthrough && !opts.identityNote) return body;
  const resolved = passthrough
    ? model
    : (typeof model === 'string' ? slotModels.get(model) : undefined) ?? ROUTED_MODEL_ALIAS;
  request['model'] = resolved;
  if (opts.identityNote) {
    const servingName = resolved === ROUTED_MODEL_ALIAS ? opts.routedModelName ?? null : resolved;
    // Claude Desktop asserts the catalog model's identity in its own system
    // prompt, and the model trusts that over anything appended later — an
    // appended correction alone gets dismissed as unreliable. Rewrite the
    // identity claims at their source, then let the note explain why.
    if (servingName && typeof model === 'string' && model !== servingName) {
      rewriteSystemIdentity(request, model, servingName);
    }
    appendIdentityNote(request, resolved, opts.routedModelName ?? null);
  }
  return Buffer.from(JSON.stringify(request), 'utf8');
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Replace the requested Claude model's id and display-name phrases inside
    the system prompt with the serving model's name, so the "environment
    metadata" Claude Desktop injects names the model that actually answers. */
function rewriteSystemIdentity(request: Record<string, unknown>, requestedModel: string, servingName: string): void {
  const phrases = [
    requestedModel,
    ...(CLAUDE_MODEL_SLOTS.find((slot) => slot.id === requestedModel)?.identityPhrases ?? []),
  ];
  const pattern = new RegExp(phrases.map(escapeRegExp).join('|'), 'gi');
  const rewrite = (text: string): string => text.replace(pattern, servingName);
  const system = request['system'];
  if (typeof system === 'string') {
    request['system'] = rewrite(system);
    return;
  }
  if (!Array.isArray(system)) return;
  request['system'] = system.map((block) => {
    if (!block || typeof block !== 'object' || Array.isArray(block)) return block;
    const record = block as Record<string, unknown>;
    if (record['type'] !== 'text' || typeof record['text'] !== 'string') return block;
    return { ...record, text: rewrite(record['text']) };
  });
}

function identityNote(resolvedModel: string, routedModelName: string | null): string {
  let serving: string;
  if (resolvedModel !== ROUTED_MODEL_ALIAS) {
    serving = `"${resolvedModel}"`;
  } else if (routedModelName) {
    serving = `"${routedModelName}" (the route currently selected in the AntSeed desktop app)`;
  } else {
    serving = 'the model currently selected in the AntSeed desktop app, which is typically not an Anthropic model';
  }
  return 'Routing note from AntSeed: this conversation is served over the AntSeed peer-to-peer network by '
    + `${serving}. Client metadata naming a Claude model refers to a routing alias, not the serving model — `
    + 'when asked which model you are, answer with your actual identity.';
}

/** Appended as the last system block so earlier prompt-cache breakpoints
    Claude Desktop may have set stay valid. Unknown system shapes are left
    alone rather than guessed at. */
function appendIdentityNote(request: Record<string, unknown>, resolvedModel: string, routedModelName: string | null): void {
  const note = identityNote(resolvedModel, routedModelName);
  const system = request['system'];
  if (system === undefined || system === null) {
    request['system'] = note;
  } else if (typeof system === 'string') {
    request['system'] = `${system}\n\n${note}`;
  } else if (Array.isArray(system)) {
    request['system'] = [...system, { type: 'text', text: note }];
  }
}

type BodyError = Error & { statusCode: number };

function collectBody(req: http.IncomingMessage, done: (err: BodyError | null, body: Buffer) => void): void {
  const chunks: Buffer[] = [];
  let size = 0;
  let finished = false;
  const finish = (err: BodyError | null, body: Buffer) => {
    if (finished) return;
    finished = true;
    done(err, body);
  };
  req.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size > MAX_REQUEST_BODY_BYTES) {
      req.destroy();
      finish(Object.assign(new Error('Request body too large'), { statusCode: 413 }), Buffer.alloc(0));
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => finish(null, Buffer.concat(chunks)));
  req.on('error', () => finish(Object.assign(new Error('Request aborted'), { statusCode: 400 }), Buffer.alloc(0)));
}

function methodNotAllowed(res: http.ServerResponse, allow: string): void {
  res.writeHead(405, { allow }).end('method not allowed');
}

function writeAnthropicError(res: http.ServerResponse, statusCode: number, type: string, message: string): void {
  res.writeHead(statusCode, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ type: 'error', error: { type, message } }));
}

let activeGateway: ClaudeDesktopGateway | null = null;

/**
 * Start (or re-point) the singleton gateway. Kept in lockstep with the
 * `claude-desktop` profile's connect state by the system-proxy runtime.
 */
export async function ensureClaudeDesktopGateway(buyerPort: number, log?: (line: string) => void): Promise<void> {
  if (activeGateway?.running && activeGateway.buyerPort === buyerPort) return;
  await stopClaudeDesktopGateway();
  const gateway = new ClaudeDesktopGateway({ port: CLAUDE_GATEWAY_DEFAULT_PORT, buyerPort, ...(log ? { log } : {}) });
  await gateway.start();
  activeGateway = gateway;
}

export async function stopClaudeDesktopGateway(): Promise<void> {
  const gateway = activeGateway;
  activeGateway = null;
  await gateway?.stop();
}
