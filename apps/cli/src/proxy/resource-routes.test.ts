import assert from 'node:assert/strict'
import test from 'node:test'
import { ResourceRoutes } from './resource-routes.js'

test('video routes survive restart and expire after 30 days', () => {
  let now = 1_000
  const routes = new ResourceRoutes(() => now)
  routes.record({ protocol: 'runway-video', resourceId: 'task-1', sellerPeerId: 'a'.repeat(40), provider: 'runway', service: 'gen4.5' })
  const restored = new ResourceRoutes(() => now)
  restored.hydrate(JSON.parse(JSON.stringify(routes.snapshot())))
  assert.equal(restored.resolve('runway-video', 'task-1')?.sellerPeerId, 'a'.repeat(40))
  assert.equal(restored.resolve('veo-video', 'task-1'), null)
  now += 31 * 24 * 60 * 60_000
  assert.equal(restored.resolve('runway-video', 'task-1'), null)
})
