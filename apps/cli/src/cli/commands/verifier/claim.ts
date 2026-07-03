import type { Command } from 'commander'
import chalk from 'chalk'
import { getGlobalOptions } from '../types.js'
import { loadConfig } from '../../../config/loader.js'
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

      const { currentEpoch, effectiveEpoch } = await rewardsClient.getEpochWindow()
      let claimedTotal = 0n
      let claimedEpochs = 0
      for (let epoch = effectiveEpoch; epoch < currentEpoch; epoch += 1) {
        const [credits, claimed] = await Promise.all([
          registryClient.epochCredits(epoch, address),
          rewardsClient.epochRewardClaimed(epoch, address),
        ])
        if (credits === 0 || claimed) continue
        const pending = await rewardsClient.pendingVerifierReward(epoch, address)
        if (pending === 0n) continue
        const tx = await rewardsClient.claimVerifierReward(identity.wallet, epoch)
        console.log(chalk.green(`Epoch ${epoch}: claimed ${formatAnts(pending)} ANTS (tx ${tx.slice(0, 10)}…)`))
        claimedTotal += pending
        claimedEpochs += 1
      }

      if (claimedEpochs === 0) {
        console.log(chalk.dim('Nothing to claim.'))
      } else {
        console.log(chalk.bold(`Claimed ${formatAnts(claimedTotal)} ANTS across ${claimedEpochs} epoch(s).`))
      }
    })
}
