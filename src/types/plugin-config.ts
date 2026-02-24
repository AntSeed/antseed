/**
 * Plugin instance configuration stored in ~/.antseed/config.json.
 */
export interface PluginInstanceConfig {
  /** Unique instance ID (e.g., "my-anthropic", "cheap-openrouter") */
  id: string
  /** npm package name (e.g., "@antseed/provider-anthropic") */
  package: string
  /** Plugin type */
  type: 'provider' | 'router'
  /** Instance configuration (secrets are encrypted at rest) */
  config: Record<string, unknown>
  /** Whether this instance is enabled. Default: true */
  enabled?: boolean
  /** ISO timestamp when instance was created */
  createdAt?: string
}

/**
 * Top-level plugin config file structure.
 */
export interface PluginConfigFile {
  /** Plugin instances */
  instances: PluginInstanceConfig[]
  /** Encryption metadata */
  encryption?: {
    algorithm: string
    kdf: string
    salt: string
  }
}
