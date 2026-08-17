/**
 * Relay HTTP/WebSocket server.
 *
 * HTTP:  GET /healthz          liveness probe
 *        GET /sellers          seller cache snapshot (CORS: *)
 * WS:    /bridge/<peerId>      byte pipe to the seller's TCP signaling port
 *
 * The bridge is deliberately dumb: it never parses signaling traffic. Auth is
 * end-to-end (the buyer's hello envelope is signed with its own key), so the
 * relay only enforces *where* a client may connect, never *what* it says.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import { WebSocketServer, createWebSocketStream, type WebSocket } from 'ws';
import { guardedLookup, isForbiddenIp } from './address-guard.js';
import type { SellerCache, SellerEndpoint } from './seller-cache.js';

export interface RelayServerConfig {
  port: number;
  host?: string;
  maxBridgesPerIp: number;
  tcpConnectTimeoutMs: number;
  idleTimeoutMs: number;
  /**
   * Set when the relay runs behind a TLS-terminating proxy (ALB, nginx):
   * per-IP limits then use the last X-Forwarded-For entry (appended by the
   * trusted proxy) instead of the socket address, which would be the proxy's.
   */
  trustProxy?: boolean;
}

const PEER_ID_REGEX = /^[0-9a-f]{40}$/;
const BRIDGE_PATH_REGEX = /^\/bridge\/([0-9a-fA-F]{40})$/;

export class RelayServer {
  private http: Server;
  private wss: WebSocketServer;
  private bridgesPerIp = new Map<string, number>();
  private activeBridges = 0;

  constructor(
    private readonly cache: SellerCache,
    private readonly config: RelayServerConfig,
  ) {
    this.http = createServer((req, res) => this.handleHttp(req, res));
    this.wss = new WebSocketServer({ noServer: true });
    this.http.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket, head));
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.http.once('error', reject);
      this.http.listen(this.config.port, this.config.host, () => {
        this.http.off('error', reject);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    for (const client of this.wss.clients) client.terminate();
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
  }

  address(): net.AddressInfo {
    return this.http.address() as net.AddressInfo;
  }

  get bridgeCount(): number {
    return this.activeBridges;
  }

  private handleHttp(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://relay');
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') {
      res.writeHead(405).end();
      return;
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders()).end();
      return;
    }
    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
      return;
    }
    if (url.pathname === '/sellers') {
      res.writeHead(200, { 'content-type': 'application/json', ...corsHeaders() });
      res.end(JSON.stringify(this.cache.snapshot()));
      return;
    }
    res.writeHead(404, corsHeaders()).end();
  }

  private handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const match = BRIDGE_PATH_REGEX.exec(new URL(req.url ?? '/', 'http://relay').pathname);
    const peerId = match?.[1]?.toLowerCase();
    if (!peerId || !PEER_ID_REGEX.test(peerId)) {
      rejectUpgrade(socket, 400, 'Bad Request');
      return;
    }

    const endpoint = this.cache.resolve(peerId);
    if (!endpoint) {
      rejectUpgrade(socket, 404, 'Unknown Seller');
      return;
    }
    // Discovered endpoints are attacker-announced; never bridge into private
    // ranges. Hostnames get the same check at DNS resolution in runBridge.
    if (!endpoint.trusted && net.isIP(endpoint.host) && isForbiddenIp(endpoint.host)) {
      rejectUpgrade(socket, 403, 'Forbidden Seller Address');
      return;
    }

    const ip = this.clientIp(req);
    if ((this.bridgesPerIp.get(ip) ?? 0) >= this.config.maxBridgesPerIp) {
      rejectUpgrade(socket, 429, 'Too Many Bridges');
      return;
    }

    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.bridgesPerIp.set(ip, (this.bridgesPerIp.get(ip) ?? 0) + 1);
      this.activeBridges++;
      this.runBridge(ws, endpoint, () => {
        const remaining = (this.bridgesPerIp.get(ip) ?? 1) - 1;
        if (remaining <= 0) this.bridgesPerIp.delete(ip);
        else this.bridgesPerIp.set(ip, remaining);
        this.activeBridges--;
      });
    });
  }

  private clientIp(req: IncomingMessage): string {
    if (this.config.trustProxy) {
      const forwarded = req.headers['x-forwarded-for'];
      const raw = Array.isArray(forwarded) ? forwarded[forwarded.length - 1] : forwarded;
      // Only the last entry is appended by our own proxy; earlier ones are
      // client-controlled and spoofable.
      const last = raw?.split(',').pop()?.trim();
      if (last) return last;
    }
    return req.socket.remoteAddress ?? 'unknown';
  }

  private runBridge(ws: WebSocket, endpoint: SellerEndpoint, onDone: () => void): void {
    const { host, port } = endpoint;
    const tcp = net.connect({
      host,
      port,
      ...(endpoint.trusted ? {} : { lookup: guardedLookup }),
    });
    tcp.setNoDelay(true);
    tcp.setTimeout(this.config.idleTimeoutMs, () => tcp.destroy(new Error('idle timeout')));

    const connectTimer = setTimeout(() => {
      tcp.destroy(new Error('connect timeout'));
    }, this.config.tcpConnectTimeoutMs);
    tcp.once('connect', () => clearTimeout(connectTimer));

    const wsStream = createWebSocketStream(ws);
    let done = false;
    const finish = (closeCode: number, reason: string) => {
      if (done) return;
      done = true;
      clearTimeout(connectTimer);
      tcp.destroy();
      if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) {
        ws.close(closeCode, reason);
      } else {
        wsStream.destroy();
      }
      onDone();
    };

    tcp.on('error', (err) => finish(1011, `seller: ${err.message}`.slice(0, 120)));
    tcp.on('close', () => finish(1000, 'seller closed'));
    wsStream.on('error', () => finish(1011, 'client error'));
    ws.on('close', () => finish(1000, 'client closed'));

    wsStream.pipe(tcp);
    // end:false — seller FIN must not end the ws stream (that closes without a
    // status code); finish() sends a proper close frame on tcp 'close' instead.
    tcp.pipe(wsStream, { end: false });
  }
}

function corsHeaders(): Record<string, string> {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, OPTIONS',
    'access-control-allow-headers': 'content-type',
  };
}

function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}
