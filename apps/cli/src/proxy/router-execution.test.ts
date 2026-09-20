import assert from 'node:assert/strict'
import test from 'node:test'
import { executeRouter } from './router-execution.js'

test('host deadline bounds a plugin that ignores cancellation', async () => {
  let pluginSignal: AbortSignal | undefined
  await assert.rejects(executeRouter(async (context) => {
    pluginSignal = context.signal
    assert.ok(context.deadlineMs >= Date.now())
    return new Promise(() => {})
  }, new AbortController().signal, 5), { code: 'router_timeout' })
  assert.equal(pluginSignal?.aborted, true)
})

test('cancelled clients do not invoke a router', async () => {
  let calls = 0
  await assert.rejects(executeRouter(async () => { calls++; return null }, AbortSignal.abort(), 100), { code: 'router_cancelled' })
  assert.equal(calls, 0)
})

test('cancellation rejects promptly and a late plugin rejection is handled', async () => {
  const controller = new AbortController()
  let rejectPlugin: (error: Error) => void = () => {}
  const pending = executeRouter(() => new Promise((_resolve, reject) => {
    rejectPlugin = reject
    controller.abort()
  }), controller.signal, 100)
  await assert.rejects(pending, { code: 'router_cancelled' })
  rejectPlugin(new Error('late response'))
})

test('null is a normal decline and successful results are preserved', async () => {
  assert.equal(await executeRouter(async () => null, new AbortController().signal, 100), null)
  assert.deepEqual(await executeRouter(async () => ['route'], new AbortController().signal, 100), ['route'])
})
