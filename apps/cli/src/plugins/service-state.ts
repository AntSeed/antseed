import { existsSync } from 'node:fs'
import path, { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { getPluginsDir } from './manager.js'

const AUTO_DEPOSIT_PACKAGE = '@antseed/service-auto-deposit'

type ReadAutoDepositConnectState =
  typeof import('@antseed/service-auto-deposit').readAutoDepositConnectState

/**
 * Resolve the auto-deposit connect-state reader from the installed plugin the
 * same way loader.ts resolves any plugin: from the plugins dir, not a hard
 * dependency. Returns null when the optional plugin is absent or fails to load,
 * so `antseed connect` keeps working whether or not auto-deposit is installed.
 */
export async function loadAutoDepositConnectStateReader(): Promise<ReadAutoDepositConnectState | null> {
  const pluginsDir = getPluginsDir()
  const resolved = path.resolve(
    join(pluginsDir, 'node_modules', AUTO_DEPOSIT_PACKAGE, 'dist', 'index.js'),
  )
  if (!resolved.startsWith(path.resolve(pluginsDir))) return null
  if (!existsSync(resolved)) return null
  try {
    const mod = (await import(pathToFileURL(resolved).href)) as {
      readAutoDepositConnectState?: ReadAutoDepositConnectState
    }
    return mod.readAutoDepositConnectState ?? null
  } catch {
    return null
  }
}
