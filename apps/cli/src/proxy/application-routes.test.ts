import assert from 'node:assert/strict'
import test from 'node:test'
import {
  matchApplicationRoute,
  parseApplicationRouteMap,
  toolMatchesSlug,
} from './application-routes.js'

test('application route parser normalizes profile names and tool slugs', () => {
  const routes = parseApplicationRouteMap({
    Codex: { mode: 'client-model', toolSlugs: ['Codex', 'codex-cli-rs'] },
    opencode: { mode: 'model', provider: 'OpenAI', service: 'qwen3-coder', toolSlugs: ['opencode'] },
  })

  assert.deepEqual(routes.codex, {
    profileName: 'codex',
    mode: 'client-model',
    toolSlugs: ['codex', 'codex-cli-rs'],
  })
  assert.deepEqual(routes.opencode, {
    profileName: 'opencode',
    mode: 'model',
    provider: 'openai',
    service: 'qwen3-coder',
    toolSlugs: ['opencode'],
  })
})

test('application route matching accepts exact slugs and dash variants', () => {
  const routes = parseApplicationRouteMap({
    codex: { mode: 'client-model', toolSlugs: ['codex'] },
    opencode: { mode: 'follow-global', toolSlugs: ['opencode'] },
  })

  assert.equal(matchApplicationRoute(routes, 'codex-cli-rs')?.profileName, 'codex')
  assert.equal(matchApplicationRoute(routes, 'opencode')?.profileName, 'opencode')
  assert.equal(matchApplicationRoute(routes, 'other-client'), null)
  assert.equal(toolMatchesSlug('code', 'codex'), false)
})

test('application route matching prefers exact and more-specific slugs', () => {
  const routes = parseApplicationRouteMap({
    codex: { mode: 'client-model', toolSlugs: ['codex'] },
    'codex-cli': { mode: 'model', provider: 'openai', service: 'special', toolSlugs: ['codex-cli-rs'] },
  })

  assert.equal(matchApplicationRoute(routes, 'codex-cli-rs')?.profileName, 'codex-cli')
  assert.equal(matchApplicationRoute(routes, 'codex-cli-rs-subagent')?.profileName, 'codex-cli')
  assert.equal(matchApplicationRoute(routes, 'codex-desktop')?.profileName, 'codex')
})

test('application route parser rejects malformed policies', () => {
  assert.throws(() => parseApplicationRouteMap([]), /routes must be an object/)
  assert.throws(
    () => parseApplicationRouteMap({ opencode: { mode: 'model', provider: '', service: 'x', toolSlugs: [] } }),
    /provider must not be empty/,
  )
  assert.throws(
    () => parseApplicationRouteMap({ opencode: { mode: 'other', toolSlugs: [] } }),
    /mode is invalid/,
  )
})
