import type { Command } from 'commander'
import chalk from 'chalk'
import { join } from 'node:path'
import { getGlobalOptions } from '../types.js'
import { loadConfig } from '../../../config/loader.js'
import { requireCryptoConfig } from '../../payment-utils.js'
import { VoucherStore } from '../../../delegate/voucher-store.js'
import {
  makeVoucherClaimedReader,
  resolveVoucherStatuses,
} from '../../../delegate/voucher-claims.js'
import type { VoucherClaimedReader, VoucherStatus } from '../../../delegate/voucher-claims.js'

export function defaultVouchersPath(dataDir: string): string {
  // Must match where DelegateWorker persists them (buyer start wiring).
  return join(dataDir, 'delegate', 'vouchers.jsonl')
}

function stateLabel(state: VoucherStatus['state']): string {
  if (state === 'claimable') return chalk.green('claimable')
  if (state === 'claimed') return chalk.dim('claimed')
  return chalk.yellow('expired')
}

export function registerDelegateVouchersCommand(delegateCmd: Command): void {
  delegateCmd
    .command('vouchers')
    .description('List earned DelegateVouchers with on-chain claim status')
    .option('--rpc-url <url>', 'Base JSON-RPC URL override')
    .option('--file <path>', 'vouchers file (default: <dataDir>/delegate/vouchers.jsonl)')
    .action(async (options) => {
      const globalOpts = getGlobalOptions(delegateCmd)
      const config = await loadConfig(globalOpts.config)
      const path = (options.file as string | undefined) ?? defaultVouchersPath(globalOpts.dataDir)

      const vouchers = await new VoucherStore(path).list()
      if (vouchers.length === 0) {
        console.log(chalk.dim(`No delegate vouchers at ${path}.`))
        return
      }

      // Claimed status is best-effort: without a configured registry the
      // vouchers still list (the contract re-checks at claim time anyway).
      let reader: VoucherClaimedReader | null = null
      try {
        const crypto = requireCryptoConfig(config, options.rpcUrl ? { rpcUrl: options.rpcUrl as string } : {})
        reader = makeVoucherClaimedReader(crypto.rpcUrl)
      } catch (err) {
        console.log(chalk.yellow(`On-chain claimed status unavailable (${(err as Error).message}); listing vouchers as-is.`))
      }

      const statuses = await resolveVoucherStatuses(vouchers, reader, {
        warn: (m) => console.warn(chalk.yellow(m)),
      })

      console.log(chalk.bold(`Delegate vouchers (${statuses.length}) — ${path}`))
      let claimableCredits = 0
      for (const status of statuses) {
        if (status.state === 'claimable') claimableCredits += status.voucher.credits
        const deadline = new Date(status.voucher.deadline * 1000).toISOString()
        console.log(
          `  ${stateLabel(status.state)}  ${String(status.voucher.credits).padStart(4)} credit(s)  ` +
          `commitment ${status.voucher.probeCommitment.slice(0, 10)}…  ` +
          `verifier ${status.verifier.slice(0, 10)}…  deadline ${deadline}`,
        )
      }
      console.log(chalk.bold(`Claimable: ${claimableCredits} credit(s).`) +
        (claimableCredits > 0 ? chalk.dim(' Run `antseed delegate claim` as the buyer\'s deposits operator.') : ''))
    })
}
