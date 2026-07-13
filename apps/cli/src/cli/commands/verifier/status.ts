import type { Command } from 'commander'
import chalk from 'chalk'
import { getGlobalOptions } from '../types.js'
import { loadConfig } from '../../../config/loader.js'
import { firstScanEpoch } from '../../../verifier/epoch-rewards.js'
import {
  createVerifierRegistryClient,
  createVerifierRewardsClient,
  formatAnts,
  loadCryptoContext,
} from '../../payment-utils.js'

export function registerVerifierStatusCommand(verifierCmd: Command): void {
  verifierCmd
    .command('status')
    .description('Show verifier approval, epoch credits, and claimable rewards')
    .option('--rpc-url <url>', 'Base JSON-RPC URL override')
    .action(async (options) => {
      const globalOpts = getGlobalOptions(verifierCmd)
      const config = await loadConfig(globalOpts.config)
      const { address } = await loadCryptoContext(globalOpts.dataDir)
      const rpcOverrides = options.rpcUrl ? { rpcUrl: options.rpcUrl as string } : {}

      const registryClient = createVerifierRegistryClient(config, rpcOverrides)
      const rewardsClient = createVerifierRewardsClient(config, rpcOverrides)

      const [approved, policy, epoch] = await Promise.all([
        registryClient.isApprovedVerifier(address),
        registryClient.getAuditPolicy(),
        registryClient.currentEpoch(),
      ])
      const [credits, totalCredits] = await Promise.all([
        registryClient.epochCredits(epoch, address),
        registryClient.epochTotalCredits(epoch),
      ])

      console.log(chalk.bold('Verifier status'))
      console.log(`  wallet:    ${address}`)
      console.log(`  approved:  ${approved ? chalk.green('yes') : chalk.red('no')}`)
      console.log(`  epoch:     ${epoch}`)
      console.log(`  credits:   ${credits}/${policy.maxCreditsPerVerifierPerEpoch} (network total this epoch: ${totalCredits})`)
      console.log(`  cooldown:  ${policy.auditCooldown}s per (seller, service)`)
      console.log(`  min probes: ${policy.minProbeCount}`)

      try {
        // Same scan window as `verifier claim` (the full claimable window),
        // so status never reports "no unclaimed" for an epoch claim would
        // still pay out. One failing epoch is reported, the rest still list.
        const window = await rewardsClient.getEpochWindow()
        const firstEpoch = firstScanEpoch(window)
        let anyPending = false
        for (let e = firstEpoch; e < window.currentEpoch; e += 1) {
          try {
            const [epochCredits, claimed] = await Promise.all([
              registryClient.epochCredits(e, address),
              rewardsClient.epochRewardClaimed(e, address),
            ])
            if (epochCredits === 0) continue
            const pending = claimed ? 0n : await rewardsClient.pendingVerifierReward(e, address)
            anyPending = anyPending || pending > 0n
            console.log(`  epoch ${e}: ${epochCredits} credits — ${claimed ? chalk.dim('claimed') : `${formatAnts(pending)} ANTS claimable`}`)
          } catch (err) {
            anyPending = true // unknown — do not report "no unclaimed"
            console.log(chalk.yellow(`  epoch ${e}: unavailable (${(err as Error).message})`))
          }
        }
        if (!anyPending) console.log(chalk.dim('  no unclaimed finalized rewards'))
      } catch (err) {
        console.log(chalk.yellow(`  rewards unavailable: ${(err as Error).message}`))
      }
    })
}
