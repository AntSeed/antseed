import { timingSafeEqual } from 'node:crypto'
import * as http from 'node:http'
import type { AddressInfo } from 'node:net'

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
])

const ALLOWED_ROUTES: ReadonlyArray<{ method: string; prefix: string }> = [
  { method: 'GET', prefix: '/v1/models' },
  { method: 'POST', prefix: '/v1/messages' },
  { method: 'POST', prefix: '/v1/messages/count_tokens' },
  { method: 'POST', prefix: '/v1/chat/completions' },
  { method: 'POST', prefix: '/v1/responses' },
  { method: 'POST', prefix: '/v1/images/generations' },
  { method: 'POST', prefix: '/v1/images/edits' },
]

export interface TunnelGatewayOptions {
  buyerPort: number
  apiKey: string
  listenPort?: number
  onLog?: (message: string) => void
}

export class TunnelGateway {
  private server: http.Server | null = null
  private port = 0

  constructor(private readonly options: TunnelGatewayOptions) {}

  async start(): Promise<number> {
    if (this.server) return this.port
    this.server = http.createServer((req, res) => this.handle(req, res))
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject)
      this.server!.listen(this.options.listenPort ?? 0, '127.0.0.1', () => resolve())
    })
    this.port = (this.server.address() as AddressInfo).port
    return this.port
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = null
    this.port = 0
    if (!server) return
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const method = req.method ?? 'GET'
    const path = req.url ?? '/'
    const canonicalPath = canonicalizeRoute(method, path)

    if (!canonicalPath) {
      this.options.onLog?.(`gateway rejected route: ${method} ${path}`)
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'Not found', type: 'invalid_request_error' } }))
      return
    }

    if (!matchesBearerKey(req.headers.authorization, this.options.apiKey)) {
      this.options.onLog?.(`gateway rejected authentication: ${method} ${path}`)
      res.writeHead(401, {
        'content-type': 'application/json',
        'www-authenticate': 'Bearer',
      })
      res.end(JSON.stringify({ error: { message: 'Invalid API key', type: 'authentication_error' } }))
      return
    }

    this.options.onLog?.(`gateway request: ${method} ${path} -> ${canonicalPath}`)

    const headers: http.OutgoingHttpHeaders = {}
    for (const [key, value] of Object.entries(req.headers)) {
      const normalizedKey = key.toLowerCase()
      if (normalizedKey === 'host' || normalizedKey === 'authorization' || normalizedKey === 'cookie') continue
      if (normalizedKey.startsWith('x-forwarded-') || HOP_BY_HOP.has(normalizedKey)) continue
      headers[key] = value
    }
    headers.host = `127.0.0.1:${this.options.buyerPort}`
    headers.connection = 'close'
    headers['x-antseed-system-proxy-source'] = tunnelRequestSource(req.headers)

    const upstream = http.request({
      hostname: '127.0.0.1',
      port: this.options.buyerPort,
      method,
      path: canonicalPath,
      headers,
    }, (upstreamRes) => {
      const responseHeaders: http.OutgoingHttpHeaders = {}
      for (const [key, value] of Object.entries(upstreamRes.headers)) {
        if (!HOP_BY_HOP.has(key.toLowerCase()) && value !== undefined) responseHeaders[key] = value
      }
      responseHeaders.connection = 'close'
      res.writeHead(upstreamRes.statusCode ?? 502, responseHeaders)
      upstreamRes.pipe(res)
    })

    upstream.on('error', (error) => {
      this.options.onLog?.(`gateway upstream error: ${error.message}`)
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'AntSeed buyer proxy is unavailable', type: 'api_error' } }))
      }
    })
    req.pipe(upstream)
  }
}

function tunnelRequestSource(headers: http.IncomingHttpHeaders): string {
  const originator = normalizeSourceHeader(headers.originator)
  if (originator) return originator.startsWith('cursor') ? 'cursor' : originator

  if (Object.keys(headers).some((name) => name.toLowerCase().startsWith('x-cursor-'))) {
    return 'cursor'
  }

  const userAgent = firstHeader(headers['user-agent']).trim()
  const product = normalizeSource(userAgent.split(/[/\s]/, 1)[0] ?? '')
  return product.startsWith('cursor') ? 'cursor' : 'public-tunnel'
}

function normalizeSourceHeader(value: string | string[] | undefined): string {
  return normalizeSource(firstHeader(value))
}

function firstHeader(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? '' : value ?? ''
}

function normalizeSource(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64)
}

function canonicalizeRoute(method: string, path: string): string | null {
  const queryIndex = path.indexOf('?')
  const pathname = (queryIndex === -1 ? path : path.slice(0, queryIndex)).toLowerCase()
  const query = queryIndex === -1 ? '' : path.slice(queryIndex)
  const candidates = new Set([pathname])

  if (!pathname.startsWith('/v1/')) candidates.add(`/v1${pathname}`)
  if (pathname.startsWith('/v1/v1/')) candidates.add(pathname.slice(3))

  const route = ALLOWED_ROUTES.find((allowed) =>
    allowed.method === method && candidates.has(allowed.prefix),
  )
  return route ? `${route.prefix}${query}` : null
}

function matchesBearerKey(header: string | undefined, expected: string): boolean {
  const prefix = 'Bearer '
  if (!header?.startsWith(prefix)) return false
  const actual = Buffer.from(header.slice(prefix.length), 'utf8')
  const wanted = Buffer.from(expected, 'utf8')
  return actual.length === wanted.length && timingSafeEqual(actual, wanted)
}
