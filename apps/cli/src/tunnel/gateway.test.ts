import assert from 'node:assert/strict'
import * as http from 'node:http'
import { test } from 'node:test'
import { TunnelGateway } from './gateway.js'

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as { port: number }).port
}

async function request(port: number, path: string, options: { method?: string; key?: string; body?: string; headers?: http.OutgoingHttpHeaders } = {}) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method: options.method ?? 'GET',
      headers: {
        ...(options.key ? { authorization: `Bearer ${options.key}`, 'content-type': 'application/json' } : {}),
        ...options.headers,
      },
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    req.end(options.body)
  })
}

test('TunnelGateway exposes only authenticated supported API routes', async () => {
  const captured: Array<{ url: string; auth?: string; source?: string }> = []
  const logs: string[] = []
  const buyer = http.createServer((req, res) => {
    captured.push({
      url: req.url ?? '',
      auth: req.headers.authorization,
      source: req.headers['x-antseed-system-proxy-source'] as string | undefined,
    })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
  })
  const buyerPort = await listen(buyer)
  const gateway = new TunnelGateway({ buyerPort, apiKey: 'secret', onLog: (message) => logs.push(message) })
  const gatewayPort = await gateway.start()

  try {
    assert.equal((await request(gatewayPort, '/_antseed/status', { key: 'secret' })).status, 404)
    assert.equal((await request(gatewayPort, '/v1/models')).status, 401)
    assert.equal((await request(gatewayPort, '/v1/models', { key: 'wrong' })).status, 401)
    assert.equal((await request(gatewayPort, '/v1/models', { key: 'secret' })).status, 200)
    assert.equal((await request(gatewayPort, '/v1/messages/count_tokens', { method: 'POST', key: 'secret', body: '{}' })).status, 200)
    assert.equal((await request(gatewayPort, '/messages/count_tokens', { method: 'POST', key: 'secret', body: '{}' })).status, 200)
    assert.equal((await request(gatewayPort, '/v1/responses', {
      method: 'POST',
      key: 'secret',
      body: '{}',
      headers: { originator: 'Cursor Agent' },
    })).status, 200)
    assert.equal((await request(gatewayPort, '/responses', {
      method: 'POST',
      key: 'secret',
      body: '{}',
      headers: { 'x-cursor-client-version': '1.0.0' },
    })).status, 200)
    assert.equal((await request(gatewayPort, '/v1/v1/responses?cursor=1', {
      method: 'POST',
      key: 'secret',
      body: '{}',
      headers: { 'user-agent': 'Cursor/1.0.0' },
    })).status, 200)
    assert.equal((await request(gatewayPort, '/chat/completions', { method: 'POST', key: 'secret', body: '{}' })).status, 200)
    assert.equal((await request(gatewayPort, '/responses/other', { method: 'POST', key: 'secret', body: '{}' })).status, 404)
    assert.deepEqual(captured, [
      { url: '/v1/models', auth: undefined, source: 'public-tunnel' },
      { url: '/v1/messages/count_tokens', auth: undefined, source: 'public-tunnel' },
      { url: '/v1/messages/count_tokens', auth: undefined, source: 'public-tunnel' },
      { url: '/v1/responses', auth: undefined, source: 'cursor' },
      { url: '/v1/responses', auth: undefined, source: 'cursor' },
      { url: '/v1/responses?cursor=1', auth: undefined, source: 'cursor' },
      { url: '/v1/chat/completions', auth: undefined, source: 'public-tunnel' },
    ])
    assert.ok(logs.includes('gateway request: POST /messages/count_tokens -> /v1/messages/count_tokens'))
    assert.ok(logs.includes('gateway request: POST /responses -> /v1/responses'))
    assert.ok(logs.includes('gateway request: POST /v1/v1/responses?cursor=1 -> /v1/responses?cursor=1'))
  } finally {
    await gateway.stop()
    await new Promise<void>((resolve) => buyer.close(() => resolve()))
  }
})
