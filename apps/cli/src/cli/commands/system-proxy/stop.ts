import { join } from 'node:path'
import { readFile, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import type { Command } from 'commander'
import chalk from 'chalk'
import { getGlobalOptions } from '../types.js'

function pidFile(dataDir: string): string { return join(dataDir, 'system-proxy', 'system-proxy.pid') }
function stateFile(dataDir: string): string { return join(dataDir, 'system-proxy', 'system-proxy.state.json') }
function proxySnapshotFile(dataDir: string): string { return join(dataDir, 'system-proxy', 'system-proxy.snapshot.json') }

async function restoreProxySnapshot(dataDir: string): Promise<void> {
  try {
    const raw = await readFile(proxySnapshotFile(dataDir), 'utf8')
    const snapshot = JSON.parse(raw) as unknown
    const { restoreSystemProxySnapshot } = await import('../../../system-proxy/system-proxy.js')
    restoreSystemProxySnapshot(snapshot as Parameters<typeof restoreSystemProxySnapshot>[0])
    await unlink(proxySnapshotFile(dataDir)).catch(() => undefined)
  } catch { /* no snapshot or restore failed */ }
}

export function registerSystemProxyStopCommand(cmd: Command): void {
  cmd
    .command('stop')
    .description('Stop the running System Proxy')
    .action(async () => {
      const globalOpts = getGlobalOptions(cmd)
      const dataDir = globalOpts.dataDir
      const pf = pidFile(dataDir)

      if (!existsSync(pf)) {
        console.log(chalk.yellow('System Proxy is not running (no PID file found).'))
        return
      }

      const pidStr = await readFile(pf, 'utf8')
      const pid = parseInt(pidStr.trim(), 10)

      if (!Number.isFinite(pid) || pid <= 0) {
        console.log(chalk.red('Invalid PID file, cleaning up.'))
        try { await unlink(pf) } catch { /* ignore */ }
        try { await unlink(stateFile(dataDir)) } catch { /* ignore */ }
        await restoreProxySnapshot(dataDir)
        return
      }

      try {
        process.kill(pid, 'SIGTERM')
        console.log(chalk.green(`Sent SIGTERM to System Proxy (pid=${pid}).`))
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code === 'ESRCH') {
          console.log(chalk.yellow(`Process ${pid} not found, cleaning up stale files.`))
          try { await unlink(pf) } catch { /* ignore */ }
          try { await unlink(stateFile(dataDir)) } catch { /* ignore */ }
          await restoreProxySnapshot(dataDir)
        } else {
          console.error(chalk.red(`Failed to stop process: ${(err as Error).message}`))
          process.exit(1)
        }
      }
    })
}
