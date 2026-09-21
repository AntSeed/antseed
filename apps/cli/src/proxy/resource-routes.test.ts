import assert from 'node:assert/strict'
import test from 'node:test'
import { ResourceRoutes, type ResourceRoute } from './resource-routes.js'

const route = (resourceId: string, seller = 'a'): Omit<ResourceRoute, 'lastAccessAt'> => ({ protocol: 'runway-video', resourceId, sellerPeerId: seller.repeat(40), provider: 'runway', service: 'gen4.5' })

test('job routes remain independent across sellers, out-of-order responses and restart', () => {
  const routes = new ResourceRoutes()
  const first = routes.reserve()
  const second = routes.reserve()
  routes.record(route('dog', 'b'))
  second()
  routes.record(route('cat'))
  first()
  const restored = new ResourceRoutes()
  restored.hydrate(JSON.parse(JSON.stringify(routes.snapshot())))
  assert.equal(restored.resolve('runway-video', 'cat')?.sellerPeerId, 'a'.repeat(40))
  assert.equal(restored.resolve('runway-video', 'dog')?.sellerPeerId, 'b'.repeat(40))
})

test('colliding IDs never overwrite another seller and require disambiguation', () => {
  const routes = new ResourceRoutes()
  routes.record(route('same'))
  routes.record(route('same', 'b'))
  assert.throws(() => routes.resolve('runway-video', 'same'), /Ambiguous/)
  assert.equal(routes.resolve('runway-video', 'same', 'b'.repeat(40))?.sellerPeerId, 'b'.repeat(40))
  assert.throws(() => routes.resolve('runway-video', 'same', 'c'.repeat(40)), /conflicts/)
  assert.equal(routes.resolve('veo-video', 'same'), null)
})

test('expiration, malformed state and concurrent capacity reservations fail safely', () => {
  let now = 1000
  const routes = new ResourceRoutes(() => now, 1)
  routes.hydrate([null, {}, { ...route('bad'), lastAccessAt: Infinity }])
  const release = routes.reserve()
  assert.throws(() => routes.reserve(), /capacity/)
  release()
  release()
  routes.record(route('old'))
  now += 31 * 24 * 60 * 60_000
  assert.equal(routes.resolve('runway-video', 'old'), null)
  assert.doesNotThrow(() => routes.reserve())
})
