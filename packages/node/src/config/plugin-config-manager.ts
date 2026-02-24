import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { PluginInstanceConfig, PluginConfigFile } from '../types/plugin-config.js'
import type { ConfigField } from '../interfaces/plugin.js'
import { encryptValue, decryptValue, deriveMachineKey, generateSalt } from './encryption.js'

const ENCRYPTED_PREFIX = 'enc:'

function isEncrypted(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(ENCRYPTED_PREFIX)
}

/**
 * Load plugin config file. Returns empty config if file doesn't exist.
 */
export async function loadPluginConfig(configPath: string): Promise<PluginConfigFile> {
  try {
    const raw = await readFile(configPath, 'utf-8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    return {
      instances: Array.isArray(parsed['instances']) ? parsed['instances'] as PluginInstanceConfig[] : [],
      encryption: parsed['encryption'] as PluginConfigFile['encryption'],
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { instances: [] }
    }
    throw err
  }
}

/**
 * Save plugin config file. Preserves non-plugin fields.
 */
export async function savePluginConfig(configPath: string, pluginConfig: PluginConfigFile): Promise<void> {
  let existing: Record<string, unknown> = {}
  try {
    const raw = await readFile(configPath, 'utf-8')
    existing = JSON.parse(raw) as Record<string, unknown>
  } catch {
    // File doesn't exist yet
  }

  const merged = {
    ...existing,
    instances: pluginConfig.instances,
    ...(pluginConfig.encryption ? { encryption: pluginConfig.encryption } : {}),
  }

  await mkdir(dirname(configPath), { recursive: true })
  await writeFile(configPath, JSON.stringify(merged, null, 2), 'utf-8')
}

function getOrCreateEncryption(config: PluginConfigFile): { key: Buffer; encryption: NonNullable<PluginConfigFile['encryption']> } {
  if (config.encryption?.salt) {
    const salt = Buffer.from(config.encryption.salt, 'hex')
    return { key: deriveMachineKey(salt), encryption: config.encryption }
  }
  const salt = generateSalt()
  const encryption = { algorithm: 'aes-256-gcm', kdf: 'scrypt', salt: salt.toString('hex') }
  return { key: deriveMachineKey(salt), encryption }
}

function encryptSecrets(instanceConfig: Record<string, unknown>, key: Buffer, schema?: ConfigField[]): Record<string, unknown> {
  const result = { ...instanceConfig }
  const secretKeys = new Set(schema?.filter(f => f.type === 'secret').map(f => f.key) ?? [])
  for (const [k, v] of Object.entries(result)) {
    if (secretKeys.has(k) && typeof v === 'string' && !isEncrypted(v)) {
      result[k] = ENCRYPTED_PREFIX + encryptValue(v, key)
    }
  }
  return result
}

function decryptSecrets(instanceConfig: Record<string, unknown>, key: Buffer): Record<string, unknown> {
  const result = { ...instanceConfig }
  for (const [k, v] of Object.entries(result)) {
    if (isEncrypted(v)) {
      result[k] = decryptValue(v.slice(ENCRYPTED_PREFIX.length), key)
    }
  }
  return result
}

/**
 * Add a plugin instance with encrypted secrets.
 */
export async function addInstance(
  configPath: string,
  instance: PluginInstanceConfig,
  schema?: ConfigField[],
): Promise<void> {
  const config = await loadPluginConfig(configPath)
  if (config.instances.some(i => i.id === instance.id)) {
    throw new Error(`Instance "${instance.id}" already exists`)
  }
  const { key, encryption } = getOrCreateEncryption(config)
  config.encryption = encryption
  const encrypted = { ...instance, config: encryptSecrets(instance.config, key, schema) }
  config.instances.push(encrypted)
  await savePluginConfig(configPath, config)
}

/**
 * Remove an instance by ID.
 */
export async function removeInstance(configPath: string, instanceId: string): Promise<void> {
  const config = await loadPluginConfig(configPath)
  config.instances = config.instances.filter(i => i.id !== instanceId)
  await savePluginConfig(configPath, config)
}

/**
 * Get a single instance with decrypted secrets.
 */
export async function getInstance(configPath: string, instanceId: string): Promise<PluginInstanceConfig | null> {
  const config = await loadPluginConfig(configPath)
  const instance = config.instances.find(i => i.id === instanceId)
  if (!instance) return null
  if (!config.encryption?.salt) return instance
  const salt = Buffer.from(config.encryption.salt, 'hex')
  const key = deriveMachineKey(salt)
  return { ...instance, config: decryptSecrets(instance.config, key) }
}

/**
 * Get all instances with decrypted secrets.
 */
export async function getInstances(configPath: string): Promise<PluginInstanceConfig[]> {
  const config = await loadPluginConfig(configPath)
  if (!config.encryption?.salt) return config.instances
  const salt = Buffer.from(config.encryption.salt, 'hex')
  const key = deriveMachineKey(salt)
  return config.instances.map(i => ({ ...i, config: decryptSecrets(i.config, key) }))
}

/**
 * Update config for an existing instance.
 */
export async function updateInstanceConfig(
  configPath: string,
  instanceId: string,
  newConfig: Record<string, unknown>,
  schema?: ConfigField[],
): Promise<void> {
  const config = await loadPluginConfig(configPath)
  const idx = config.instances.findIndex(i => i.id === instanceId)
  if (idx === -1) throw new Error(`Instance "${instanceId}" not found`)
  const { key, encryption } = getOrCreateEncryption(config)
  config.encryption = encryption
  config.instances[idx] = { ...config.instances[idx]!, config: encryptSecrets(newConfig, key, schema) }
  await savePluginConfig(configPath, config)
}
