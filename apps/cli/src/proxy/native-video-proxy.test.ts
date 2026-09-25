import assert from 'node:assert/strict'
import test from 'node:test'
import { prepareVideoRequest, recordVideoAcceptance, rewriteVideoDownloadUrls, VIDEO_IDEMPOTENCY_KEY_HEADER } from './native-video-proxy.js'
import { ResourceRoutes } from './resource-routes.js'

const seller = 'a'.repeat(40)
const response = (body: object) => ({ requestId: 'r', statusCode: 200, headers: {} as Record<string, string>, body: Buffer.from(JSON.stringify(body)) })

test('Veo download URLs point to the local proxy without changing the signed upstream response', () => {
  const route = { protocol: 'veo-video', action: 'status', resourceId: 'models/veo/operations/task' } as const
  const uri = 'https://generativelanguage.googleapis.com/v1beta/files/file:download?alt=media'
  const upstream = response({ done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri } }] } } })
  upstream.headers['Content-Length'] = String(upstream.body.length)
  const rewritten = rewriteVideoDownloadUrls(route, upstream, 'http://127.0.0.1:8377')
  assert.equal(JSON.parse(Buffer.from(rewritten.body).toString()).response.generateVideoResponse.generatedSamples[0].video.uri, 'http://127.0.0.1:8377/v1beta/models/veo/operations/task/videos/0:download')
  assert.equal(JSON.parse(upstream.body.toString()).response.generateVideoResponse.generatedSamples[0].video.uri, uri)
  assert.equal(rewritten.headers['Content-Length'], undefined)
  const hosted = response({ done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: 'https://seller.test/video' } }] } } })
  assert.equal(rewriteVideoDownloadUrls(route, hosted, 'http://127.0.0.1:8377'), hosted)
  const routes = new ResourceRoutes()
  routes.record({ protocol: 'veo-video', resourceId: route.resourceId, sellerPeerId: seller, provider: 'veo', service: 'veo' })
  const restarted = new ResourceRoutes()
  restarted.hydrate(routes.snapshot())
  assert.deepEqual(prepareVideoRequest({ ...route, action: 'download', resultIndex: 0 }, {}, restarted), { headers: { 'x-antseed-pin-peer': seller, 'x-antseed-provider': 'veo', 'x-antseed-service': 'veo' } })
})

test('video creates reuse a valid client idempotency key, generate one otherwise, and reject malformed keys', () => {
  const routes = new ResourceRoutes()
  const create = { protocol: 'runway-video', action: 'create' } as const
  assert.deepEqual(prepareVideoRequest(create, { 'idempotency-key': 'client-1' }, routes), { headers: { 'idempotency-key': 'client-1', [VIDEO_IDEMPOTENCY_KEY_HEADER]: 'client-1' } })
  const generated = prepareVideoRequest(create, {}, routes)
  assert.ok('headers' in generated && generated.headers[VIDEO_IDEMPOTENCY_KEY_HEADER])
  const invalid = prepareVideoRequest(create, { [VIDEO_IDEMPOTENCY_KEY_HEADER]: 'bad key!' }, routes)
  assert.ok('error' in invalid && invalid.error.statusCode === 400)
})

test('video status and cancel pin the seller that accepted the job, and unknown jobs return 404', () => {
  const routes = new ResourceRoutes()
  const accepted = response({ task_id: 'task-1' })
  const create = { protocol: 'minimax-video', action: 'create' } as const
  assert.equal(recordVideoAcceptance(create, { [VIDEO_IDEMPOTENCY_KEY_HEADER]: 'key' }, accepted, { peerId: seller, provider: 'minimax', service: 'MiniMax-H3' }, routes), true)
  assert.equal(accepted.headers['x-antseed-seller-peer'], seller)
  assert.equal(accepted.headers[VIDEO_IDEMPOTENCY_KEY_HEADER], 'key')

  const status = prepareVideoRequest({ protocol: 'minimax-video', action: 'status', resourceId: 'task-1' }, {}, routes)
  assert.deepEqual(status, { headers: { 'x-antseed-pin-peer': seller, 'x-antseed-provider': 'minimax', 'x-antseed-service': 'MiniMax-H3' } })
  const unknown = prepareVideoRequest({ protocol: 'minimax-video', action: 'status', resourceId: 'other' }, {}, routes)
  assert.ok('error' in unknown && unknown.error.statusCode === 404)
})

test('only accepted creates are recorded', () => {
  const routes = new ResourceRoutes()
  const create = { protocol: 'seedance-video', action: 'create' } as const
  const info = { peerId: seller, provider: 'seedance', service: 'seedance-2-0' }
  assert.equal(recordVideoAcceptance(create, {}, { ...response({ id: 'task' }), statusCode: 500 }, info, routes), false)
  assert.equal(recordVideoAcceptance({ protocol: 'seedance-video', action: 'status', resourceId: 'task' }, {}, response({ id: 'task' }), info, routes), false)
  assert.equal(routes.snapshot().length, 0)
})
