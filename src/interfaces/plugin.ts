import type { Provider } from './seller-provider.js'
import type { Router } from './buyer-router.js'

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

export type AntseedPlugin = AntseedProviderPlugin | AntseedRouterPlugin
