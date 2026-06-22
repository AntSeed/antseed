import type { Provider } from './seller-provider.js'
import type { Router } from './buyer-router.js'
import type { Service, ServiceHost, ServiceCapability } from './service.js'

export interface ConfigField {
  key: string
  label: string
  type: 'string' | 'number' | 'boolean' | 'secret' | 'string[]'
  required?: boolean
  default?: unknown
  description?: string
}

/** @deprecated Use ConfigField instead */
export type PluginConfigKey = ConfigField

export interface AntseedPluginBase {
  name: string
  displayName: string
  version: string
  description: string
  configSchema?: ConfigField[]
  /** @deprecated Use configSchema instead */
  configKeys?: ConfigField[]
}

export interface AntseedProviderPlugin extends AntseedPluginBase {
  type: 'provider'
  createProvider(config: Record<string, string>): Provider | Promise<Provider>
}

export interface AntseedRouterPlugin extends AntseedPluginBase {
  type: 'router'
  createRouter(config: Record<string, string>): Router | Promise<Router>
}

/**
 * Host-driven background service plugin (e.g. the gasless auto-deposit funder).
 * Unlike providers/routers it runs a start/stop lifecycle on the buyer's behalf
 * and may need sensitive capabilities (a wallet key, chain config) rather than
 * plain string config. It declares them via {@link capabilities} and the host
 * grants only those.
 */
export interface AntseedServicePlugin extends AntseedPluginBase {
  type: 'service'
  /** Discriminates the family of service (e.g. "funding") for client grouping. */
  kind: string
  /** Sensitive capabilities the host must grant before the service can run. */
  capabilities?: ServiceCapability[]
  createService(host: ServiceHost): Service | null | Promise<Service | null>
}

export type AntseedPlugin = AntseedProviderPlugin | AntseedRouterPlugin | AntseedServicePlugin
