import type { Command } from 'commander'
import chalk from 'chalk'
import { getGlobalOptions } from '../types.js'
import { loadConfig } from '../../../config/loader.js'
import { claimRewardEpochs } from '../../../verifier/epoch-rewards.js'
import {
  createDepositsClient,
  createVerifierRegistryClient,
  createVerifierRewardsClient,
  formatAnts,
  loadCryptoContext,
} from '../../payment-utils.js'
import { CreditStore } from '../../../delegate/credit-store.js'
import { claimDelegateCredits, resolveCreditStatuses } from '../../../delegate/credit-claims.js'
import { defaultCreditsPath } from './credits.js'

/**
 * `antseed delegate claim` — turn discovered delegate-credit accruals into
 * on-chain delegate credits (AntseedVerifierRegistry.claimDelegateCredits),
 * then claim any finalized delegate ANTS rewards (AntseedVerifierRewards
 * .claimDelegateReward). The contract only accepts the operator registered
 * for the accrual's buyer in AntseedDeposits, so this command must run with
 * the OPERATOR's identity (its --data-dir), not the carrying buyer's.
 */
export function registerDelegateClaimCommand(delegateCmd: Command): void {
  delegateCmd
    .command('claim')
    .description('Claim discovered delegate credits on-chain, then any finalized delegate ANTS rewards (run as the buyer\'s deposits operator)')
    .option('--rpc-url <url>', 'Base JSON-RPC URL override')
    .option('--file <path>', 'accruals file (default: <dataDir>/delegate/credits.json)')
    .option('--credits-only', 'claim delegate credits only; skip the delegate ANTS reward pass')
    .action(async (options) => {
      const globalOpts = getGlobalOptions(delegateCmd)
      const config = await loadConfig(globalOpts.config)
      const { identity, address } = await loadCryptoContext(globalOpts.dataDir)
      const rpcOverrides = options.rpcUrl ? { rpcUrl: options.rpcUrl as string } : {}

      const registryClient = createVerifierRegistryClient(config, rpcOverrides)
      const path = (options.file as string | undefined) ?? defaultCreditsPath(globalOpts.dataDir)
      const accruals = await new CreditStore(path).list()

      console.log(chalk.dim(`Claiming as ${address} (must be the buyer's registered deposits operator)`))

      let hadFailures = false
      if (accruals.length === 0) {
        console.log(chalk.dim(`No delegate-credit accruals at ${path}.`))
      } else {
        // Preflight the operator binding per distinct buyer so a wrong
        // identity fails with one clear message instead of N reverts.
        const buyers = [...new Set(accruals.map((a) => a.buyer.toLowerCase()))]
        const deposits = createDepositsClient(config, rpcOverrides)
        const claimableBuyers = new Set<string>()
        for (const buyer of buyers) {
          try {
            const operator = await deposits.getOperator(buyer)
            if (operator && operator.toLowerCase() === address.toLowerCase()) {
              claimableBuyers.add(buyer)
            } else {
              hadFailures = true
              console.error(chalk.red(
                `Buyer ${buyer.slice(0, 10)}…: registered operator is ${operator && operator !== '0x' + '0'.repeat(40) ? operator : 'not set'}, `
                + 'not this wallet — skipping its accruals. Run with the operator\'s --data-dir, or register the operator on AntseedDeposits first.',
              ))
            }
          } catch (err) {
            // Lookup failure is not proof of a wrong operator — let the
            // contract decide (a mismatch reverts per accrual below).
            claimableBuyers.add(buyer)
            console.warn(chalk.yellow(`Buyer ${buyer.slice(0, 10)}…: operator lookup failed (${(err as Error).message}); attempting claims anyway.`))
          }
        }

        const statuses = await resolveCreditStatuses(
          accruals.filter((a) => claimableBuyers.has(a.buyer.toLowerCase())),
          registryClient,
          { warn: (m) => console.warn(chalk.yellow(m)) },
        )
        const result = await claimDelegateCredits({
          statuses,
          registry: registryClient,
          signer: identity.wallet,
          onClaim: (status, tx) =>
            console.log(chalk.green(`Claimed ${status.claimable} credit(s) on commitment ${status.accrual.probeCommitment.slice(0, 10)}… (tx ${tx.slice(0, 10)}…)`)),
          onError: (status, err) =>
            console.warn(chalk.yellow(`Commitment ${status.accrual.probeCommitment.slice(0, 10)}…: claim failed (continuing): ${err.message}`)),
        })
        hadFailures = hadFailures || result.failed > 0
        console.log(chalk.bold(
          `Credits: ${result.claimedCount} claimed (${result.claimedCredits} credit(s)), `
          + `${result.skippedClaimed} already claimed, ${result.skippedEmpty} nothing to claim, ${result.failed} failed.`,
        ))
        if (result.claimedCount > 0) {
          console.log(chalk.dim('Credits land in the CURRENT epoch — the matching ANTS reward is claimable once that epoch finalizes.'))
        }
      }

      // Finalized delegate ANTS rewards for credits claimed in past epochs.
      // Same window + per-epoch fault isolation as the verifier reward claim.
      if (!options.creditsOnly) {
        try {
          const rewardsClient = createVerifierRewardsClient(config, rpcOverrides)
          const window = await rewardsClient.getEpochWindow()
          const rewards = await claimRewardEpochs(
            window,
            {
              credits: (epoch) => registryClient.epochDelegateCredits(epoch, address),
              claimed: (epoch) => rewardsClient.epochDelegateRewardClaimed(epoch, address),
              pending: (epoch) => rewardsClient.pendingDelegateReward(epoch, address),
              claim: (epoch) => rewardsClient.claimDelegateReward(identity.wallet, epoch),
            },
            {
              onClaim: (epoch, pending, tx) =>
                console.log(chalk.green(`Epoch ${epoch}: claimed ${formatAnts(pending)} ANTS delegate reward (tx ${tx.slice(0, 10)}…)`)),
              onEpochError: (epoch, err) =>
                console.warn(chalk.yellow(`Epoch ${epoch}: delegate reward claim failed (continuing): ${err.message}`)),
            },
          )
          if (rewards.claimedEpochs === 0) {
            console.log(chalk.dim('No finalized delegate ANTS rewards to claim.'))
          } else {
            console.log(chalk.bold(`Claimed ${formatAnts(rewards.claimedTotal)} ANTS across ${rewards.claimedEpochs} epoch(s).`))
          }
          hadFailures = hadFailures || rewards.failedEpochs.length > 0
        } catch (err) {
          hadFailures = true
          console.warn(chalk.yellow(`Delegate ANTS reward pass failed: ${(err as Error).message}`))
        }
      }

      if (hadFailures) process.exitCode = 1
    })
}
