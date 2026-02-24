import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addInstance, removeInstance, getInstance, getInstances, updateInstanceConfig, loadPluginConfig } from './plugin-config-manager.js'
import type { ConfigField } from '../interfaces/plugin.js'

const schema: ConfigField[] = [
  { key: 'API_KEY', label: 'API Key', type: 'secret', required: true },
  { key: 'BASE_URL', label: 'Base URL', type: 'string', required: false },
]

describe('plugin-config-manager', () => {
  let tmpDir: string
  let configPath: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'antseed-test-'))
    configPath = join(tmpDir, 'config.json')
  })

  it('should add and retrieve an instance', async () => {
    await addInstance(configPath, {
      id: 'test-provider',
      package: '@antseed/provider-test',
      type: 'provider',
      config: { API_KEY: 'sk-secret-123', BASE_URL: 'https://api.test.com' },
    }, schema)

    const instance = await getInstance(configPath, 'test-provider')
    expect(instance).not.toBeNull()
    expect(instance!.id).toBe('test-provider')
    expect(instance!.config['API_KEY']).toBe('sk-secret-123')
    expect(instance!.config['BASE_URL']).toBe('https://api.test.com')
  })

  it('should encrypt secrets in the file', async () => {
    await addInstance(configPath, {
      id: 'test',
      package: '@antseed/provider-test',
      type: 'provider',
      config: { API_KEY: 'sk-secret', BASE_URL: 'https://api.test.com' },
    }, schema)

    const raw = await loadPluginConfig(configPath)
    const stored = raw.instances[0]!.config
    // Secret should be encrypted (prefixed with enc:)
    expect(typeof stored['API_KEY']).toBe('string')
    expect((stored['API_KEY'] as string).startsWith('enc:')).toBe(true)
    // Non-secret should be plain
    expect(stored['BASE_URL']).toBe('https://api.test.com')
  })

  it('should remove an instance', async () => {
    await addInstance(configPath, {
      id: 'to-remove',
      package: '@antseed/provider-test',
      type: 'provider',
      config: {},
    })
    await removeInstance(configPath, 'to-remove')
    const instance = await getInstance(configPath, 'to-remove')
    expect(instance).toBeNull()
  })

  it('should list all instances', async () => {
    await addInstance(configPath, { id: 'a', package: 'pkg-a', type: 'provider', config: {} })
    await addInstance(configPath, { id: 'b', package: 'pkg-b', type: 'router', config: {} })
    const all = await getInstances(configPath)
    expect(all).toHaveLength(2)
    expect(all.map(i => i.id)).toEqual(['a', 'b'])
  })

  it('should update instance config', async () => {
    await addInstance(configPath, {
      id: 'updatable',
      package: 'pkg',
      type: 'provider',
      config: { API_KEY: 'old-key' },
    }, schema)

    await updateInstanceConfig(configPath, 'updatable', { API_KEY: 'new-key' }, schema)
    const updated = await getInstance(configPath, 'updatable')
    expect(updated!.config['API_KEY']).toBe('new-key')
  })

  it('should reject duplicate instance IDs', async () => {
    await addInstance(configPath, { id: 'dup', package: 'pkg', type: 'provider', config: {} })
    await expect(addInstance(configPath, { id: 'dup', package: 'pkg', type: 'provider', config: {} }))
      .rejects.toThrow('already exists')
  })
})
