import type { Command } from 'commander'
import chalk from 'chalk'
import { join } from 'node:path'
import { getGlobalOptions } from '../types.js'
import { loadConfig } from '../../../config/loader.js'
import { createVerifierRegistryClient } from '../../payment-utils.js'
import { CreditStore } from '../../../delegate/credit-store.js'
import { resolveCreditStatuses } from '../../../delegate/credit-claims.js'
import type { CreditAccrualReader, CreditStatus } from '../../../delegate/credit-claims.js'

export function defaultCreditsPath(dataDir: string): string {
  // Must match where DelegateWorker persists them (buyer start wiring).
  return join(dataDir, 'delegate', 'credits.json')
}

function stateLabel(state: CreditStatus['state']): string {
  if (state === 'claimable') return chalk.green('claimable')
  if (state === 'claimed') return chalk.dim('claimed')
  return chalk.yellow('empty')
}

export function registerDelegateCreditsCommand(delegateCmd: Command): void {
  delegateCmd
    .command('credits')
    .description('List discovered delegate-credit accruals with on-chain claim status')
    .option('--rpc-url <url>', 'Base JSON-RPC URL override')
    .option('--file <path>', 'accruals file (default: <dataDir>/delegate/credits.json)')
    .action(async (options) => {
      const globalOpts = getGlobalOptions(delegateCmd)
      const config = await loadConfig(globalOpts.config)
      const path = (options.file as string | undefined) ?? defaultCreditsPath(globalOpts.dataDir)

      const accruals = await new CreditStore(path).list()
      if (accruals.length === 0) {
        console.log(chalk.dim(`No delegate-credit accruals at ${path}.`))
        return
      }

      // Accrued/claimed status is best-effort: without a configured registry the
      // accruals still list (the contract re-checks at claim time anyway).
      let reader: CreditAccrualReader | null = null
      try {
        reader = createVerifierRegistryClient(config, options.rpcUrl ? { rpcUrl: options.rpcUrl as string } : {})
      } catch (err) {
        console.log(chalk.yellow(`On-chain claim status unavailable (${(err as Error).message}); listing accruals as-is.`))
      }

      const statuses = await resolveCreditStatuses(accruals, reader, {
        warn: (m) => console.warn(chalk.yellow(m)),
      })

      console.log(chalk.bold(`Delegate credit accruals (${statuses.length}) — ${path}`))
      let claimableCredits = 0
      for (const status of statuses) {
        claimableCredits += status.claimable
        console.log(
          `  ${stateLabel(status.state)}  ${String(status.claimable).padStart(4)} claimable  ` +
          `(${status.accrued} accrued, ${status.claimed} claimed)  ` +
          `commitment ${status.accrual.probeCommitment.slice(0, 10)}…  ` +
          `verifier ${status.accrual.verifier.slice(0, 10)}…  buyer ${status.accrual.buyer.slice(0, 10)}…`,
        )
      }
      console.log(chalk.bold(`Claimable: ${claimableCredits} credit(s).`) +
        (claimableCredits > 0 ? chalk.dim(' Run `antseed delegate claim` as the buyer\'s deposits operator.') : ''))
    })
}
