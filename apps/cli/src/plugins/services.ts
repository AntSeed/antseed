import type { AntseedServicePlugin } from '@antseed/node'
import { getTrustedServicePlugins } from './registry.js'
import { loadServicePlugin } from './loader.js'

/** Names of the trusted service plugins the buyer can enable (auto-deposit, …). */
export function listServicePluginNames(): string[] {
  return getTrustedServicePlugins().map((plugin) => plugin.name)
}

/**
 * Load every trusted service plugin from the plugins dir, installing on demand
 * exactly like provider/router plugins. Best-effort: a service that fails to
 * load (e.g. not yet installed, no network) is skipped with a warning rather
 * than aborting buyer startup.
 */
export async function loadTrustedServicePlugins(): Promise<AntseedServicePlugin[]> {
  const loaded: AntseedServicePlugin[] = []
  for (const trusted of getTrustedServicePlugins()) {
    try {
      loaded.push(await loadServicePlugin(trusted.name))
    } catch (err) {
      const cause = err instanceof Error ? err.message : String(err)
      console.log(`Service plugin "${trusted.name}" unavailable: ${cause}`)
    }
  }
  return loaded
}
