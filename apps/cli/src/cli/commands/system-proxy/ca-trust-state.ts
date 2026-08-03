import type { Command } from 'commander'
import { getGlobalOptions } from '../types.js'
import { CAManager } from '../../../system-proxy/ca-manager.js'

/**
 * Report, as a single JSON line on stdout, whether the OS trust store already
 * trusts this device's CA. Consumed by the desktop app to decide whether to
 * prompt the user to trust the certificate after adding an intercepted app.
 */
export function registerSystemProxyCaTrustStateCommand(cmd: Command): void {
  cmd
    .command('ca-trust-state')
    .description('Report whether the local CA is trusted by the OS (JSON on stdout)')
    .action(async () => {
      const globalOpts = getGlobalOptions(cmd)
      const caManager = new CAManager(globalOpts.dataDir)
      const exists = await caManager.exists()
      const trust = exists ? caManager.trustState() : 'absent'
      process.stdout.write(`${JSON.stringify({ exists, trust })}\n`)
    })
}
