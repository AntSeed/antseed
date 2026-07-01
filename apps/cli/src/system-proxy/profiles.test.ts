import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { loadSystemProxyProfiles } from './profiles.js'

const PROFILE_FIXTURE = [
  {
    name: 'api-client',
    displayName: 'API client',
    domains: ['api-client.example.test'],
    pathPrefixes: ['/v1/messages'],
  },
  {
    name: 'browser-client',
    displayName: 'Browser client',
    domains: ['browser-client.example.test'],
    pathPrefixes: ['/profile-api/conversation'],
    forward: {
      source: 'browser-client',
      targetPath: '/v1/chat/completions',
      headers: 'browser-sse',
      request: {
        kind: 'chat-completions-from-messages',
        messagesPath: ['messages'],
        modelPath: ['model'],
        missingModel: 'auto',
        stream: true,
      },
      response: {
        kind: 'conversation-sse',
        assistantParent: 'user-message',
      },
    },
  },
]

test('loadSystemProxyProfiles returns empty when no local profile config is set', () => {
  const profiles = loadSystemProxyProfiles({})
  assert.deepEqual(profiles, [])
})

test('loadSystemProxyProfiles parses profiles from JSON env', () => {
  const profiles = loadSystemProxyProfiles({
    ANTSEED_SYSTEM_PROXY_PROFILES_JSON: JSON.stringify(PROFILE_FIXTURE),
  })
  assert.equal(profiles.length, 2)
  assert.equal(profiles[0]?.name, 'api-client')
  assert.equal(profiles[0]?.displayName, 'API client')
  assert.deepEqual(profiles[0]?.domains, ['api-client.example.test'])
  assert.equal(profiles[1]?.forward?.response?.kind, 'conversation-sse')
})

test('loadSystemProxyProfiles parses profiles from JSON file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'antseed-profiles-test-'))
  try {
    const file = join(dir, 'profiles.json')
    await writeFile(file, JSON.stringify(PROFILE_FIXTURE), 'utf8')
    const profiles = loadSystemProxyProfiles({
      ANTSEED_SYSTEM_PROXY_PROFILES_FILE: file,
    })
    assert.equal(profiles.length, 2)
    assert.equal(profiles[1]?.name, 'browser-client')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
