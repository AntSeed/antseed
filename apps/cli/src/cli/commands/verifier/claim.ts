import type { Command } from 'commander'
import chalk from 'chalk'
import { loadConfig } from '../../../config/loader.js'
import {
  claimRewardEpochs,
  verifierRewardSource,
  verifierRewardWindow,
} from '../../../verifier/epoch-rewards.js'
import {
  createVerifierClient,
  formatAnts,
  loadCryptoContext,
} from '../../payment-utils.js'
import { getGlobalOptions } from '../types.js'

export function registerVerifierClaimCommand(verifierCmd: Command): void {
  verifierCmd
    .command('claim')
    .description('Claim verifier ANTS rewards for all finalized epochs with credits')
    .option('--rpc-url <url>', 'Base JSON-RPC URL override')
    .action(async (options, command: Command) => {
      const globalOptions = getGlobalOptions(command)
      const config = await loadConfig(globalOptions.config)
      const { identity, address } = await loadCryptoContext(globalOptions.dataDir)
      const rpcOverrides = options.rpcUrl ? { rpcUrl: String(options.rpcUrl) } : {}
      const verifierClient = createVerifierClient(config, rpcOverrides)
      const window = await verifierRewardWindow(verifierClient)
      const result = await claimRewardEpochs(
        window,
        verifierRewardSource(verifierClient, address, identity.wallet),
        {
          onClaim: (epoch, pending, tx) => {
            console.log(chalk.green(`Epoch ${epoch}: claimed ${formatAnts(pending)} ANTS (tx ${tx.slice(0, 10)}…)`))
          },
          onEpochError: (epoch, error) => {
            console.warn(chalk.yellow(`Epoch ${epoch}: claim failed (continuing): ${error.message}`))
          },
        },
      )
      if (result.claimedEpochs === 0) console.log(chalk.dim('Nothing to claim.'))
      else console.log(chalk.bold(`Claimed ${formatAnts(result.claimedTotal)} ANTS across ${result.claimedEpochs} epoch(s).`))
      if (result.failedEpochs.length > 0) {
        console.warn(chalk.yellow(`Failed epoch(s): ${result.failedEpochs.map(String).join(', ')} — re-run to retry.`))
        process.exitCode = 1
      }
    })
}
