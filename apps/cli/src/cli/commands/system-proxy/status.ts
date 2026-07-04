import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import type { Command } from 'commander'
import chalk from 'chalk'
import { getGlobalOptions } from '../types.js'
import { CAManager } from '../../../system-proxy/ca-manager.js'
import type { SystemProxyState } from '../../../system-proxy/types.js'

function pidFile(dataDir: string): string { return join(dataDir, 'system-proxy', 'system-proxy.pid') }
function stateFile(dataDir: string): string { return join(dataDir, 'system-proxy', 'system-proxy.state.json') }

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

export function registerSystemProxyStatusCommand(cmd: Command): void {
  cmd
    .command('status')
    .description('Show System Proxy status')
    .action(async () => {
      const globalOpts = getGlobalOptions(cmd)
      const dataDir = globalOpts.dataDir
      const caManager = new CAManager(dataDir)

      const caExists = await caManager.exists()
      const pf = pidFile(dataDir)
      const sf = stateFile(dataDir)

      let running = false
      let pid: number | null = null
      let state: SystemProxyState | null = null

      if (existsSync(pf)) {
        const pidStr = await readFile(pf, 'utf8')
        pid = parseInt(pidStr.trim(), 10)
        running = Number.isFinite(pid) && pid > 0 && isProcessAlive(pid)
      }

      if (existsSync(sf)) {
        try {
          state = JSON.parse(await readFile(sf, 'utf8')) as SystemProxyState
        } catch { /* ignore malformed */ }
      }

      console.log(chalk.bold('System Proxy status:'))
      console.log(`  CA certificate: ${caExists ? chalk.green('exists') : chalk.yellow('not generated - run: antseed system-proxy install-ca')}`)
      if (caExists) {
        console.log(`  CA file: ${chalk.dim(caManager.certFilePath)}`)
      }
      console.log(`  Proxy: ${running ? chalk.green(`running (pid=${pid})`) : chalk.dim('stopped')}`)

      if (state) {
        console.log(`  Port:     ${state.port}`)
        console.log(`  Peer:     ${state.peerId}`)
        console.log(`  Profiles: ${state.activeProfileNames.join(', ')}`)
      }

      if (!running && caExists) {
        console.log('')
        console.log(chalk.dim('Start with:  antseed system-proxy start --peer <peerId>'))
      }
    })
}
