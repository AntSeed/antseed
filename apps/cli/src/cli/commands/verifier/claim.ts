import type { Command } from 'commander'
import chalk from 'chalk'
import { getGlobalOptions } from '../types.js'
import { loadConfig } from '../../../config/loader.js'
import { claimRewardEpochs } from '../../../verifier/epoch-rewards.js'
import {
  createVerifierRegistryClient,
  createVerifierRewardsClient,
  formatAnts,
  loadCryptoContext,
} from '../../payment-utils.js'

export function registerVerifierClaimCommand(verifierCmd: Command): void {
  verifierCmd
    .command('claim')
    .description('Claim verifier ANTS rewards for all finalized epochs with credits')
    .option('--rpc-url <url>', 'Base JSON-RPC URL override')
    .action(async (options) => {
      const globalOpts = getGlobalOptions(verifierCmd)
      const config = await loadConfig(globalOpts.config)
      const { identity, address } = await loadCryptoContext(globalOpts.dataDir)
      const rpcOverrides = options.rpcUrl ? { rpcUrl: options.rpcUrl as string } : {}

      const registryClient = createVerifierRegistryClient(config, rpcOverrides)
      const rewardsClient = createVerifierRewardsClient(config, rpcOverrides)

      // Same scan window as `verifier status` and the daemon's claim pass;
      // one failing epoch is reported and skipped, later epochs still claim.
      const window = await rewardsClient.getEpochWindow()
      const result = await claimRewardEpochs(
        window,
        {
          credits: (epoch) => registryClient.epochCredits(epoch, address),
          claimed: (epoch) => rewardsClient.epochRewardClaimed(epoch, address),
          pending: (epoch) => rewardsClient.pendingVerifierReward(epoch, address),
          claim: (epoch) => rewardsClient.claimVerifierReward(identity.wallet, epoch),
        },
        {
          onClaim: (epoch, pending, tx) =>
            console.log(chalk.green(`Epoch ${epoch}: claimed ${formatAnts(pending)} ANTS (tx ${tx.slice(0, 10)}…)`)),
          onEpochError: (epoch, err) =>
            console.warn(chalk.yellow(`Epoch ${epoch}: claim failed (continuing): ${err.message}`)),
        },
      )

      if (result.claimedEpochs === 0) {
        console.log(chalk.dim('Nothing to claim.'))
      } else {
        console.log(chalk.bold(`Claimed ${formatAnts(result.claimedTotal)} ANTS across ${result.claimedEpochs} epoch(s).`))
      }
      if (result.failedEpochs.length > 0) {
        console.warn(chalk.yellow(`Failed epoch(s): ${result.failedEpochs.join(', ')} — re-run to retry.`))
        process.exitCode = 1
      }
    })
}
