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
  requireCryptoConfig,
} from '../../payment-utils.js'
import { VoucherStore } from '../../../delegate/voucher-store.js'
import {
  claimDelegateVouchers,
  makeVoucherClaimedReader,
  resolveVoucherStatuses,
} from '../../../delegate/voucher-claims.js'
import { defaultVouchersPath } from './vouchers.js'

/**
 * `antseed delegate claim` — turn persisted DelegateVouchers into on-chain
 * delegate credits (AntseedVerifierRegistry.claimDelegateCredits), then claim
 * any finalized delegate ANTS rewards (AntseedVerifierRewards
 * .claimDelegateReward). The contract only accepts the operator registered
 * for the voucher's buyer in AntseedDeposits, so this command must run with
 * the OPERATOR's identity (its --data-dir), not the carrying buyer's.
 */
export function registerDelegateClaimCommand(delegateCmd: Command): void {
  delegateCmd
    .command('claim')
    .description('Claim earned DelegateVouchers as on-chain credits, then any finalized delegate ANTS rewards (run as the buyer\'s deposits operator)')
    .option('--rpc-url <url>', 'Base JSON-RPC URL override')
    .option('--file <path>', 'vouchers file (default: <dataDir>/delegate/vouchers.jsonl)')
    .option('--credits-only', 'claim voucher credits only; skip the delegate ANTS reward pass')
    .action(async (options) => {
      const globalOpts = getGlobalOptions(delegateCmd)
      const config = await loadConfig(globalOpts.config)
      const { identity, address } = await loadCryptoContext(globalOpts.dataDir)
      const rpcOverrides = options.rpcUrl ? { rpcUrl: options.rpcUrl as string } : {}

      const registryClient = createVerifierRegistryClient(config, rpcOverrides)
      const crypto = requireCryptoConfig(config, rpcOverrides)
      const path = (options.file as string | undefined) ?? defaultVouchersPath(globalOpts.dataDir)
      const vouchers = await new VoucherStore(path).list()

      console.log(chalk.dim(`Claiming as ${address} (must be the buyer's registered deposits operator)`))

      let hadFailures = false
      if (vouchers.length === 0) {
        console.log(chalk.dim(`No delegate vouchers at ${path}.`))
      } else {
        // Preflight the operator binding per distinct buyer so a wrong
        // identity fails with one clear message instead of N reverts.
        const buyers = [...new Set(vouchers.map((v) => v.buyer.toLowerCase()))]
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
                + 'not this wallet — skipping its vouchers. Run with the operator\'s --data-dir, or register the operator on AntseedDeposits first.',
              ))
            }
          } catch (err) {
            // Lookup failure is not proof of a wrong operator — let the
            // contract decide (a mismatch reverts per voucher below).
            claimableBuyers.add(buyer)
            console.warn(chalk.yellow(`Buyer ${buyer.slice(0, 10)}…: operator lookup failed (${(err as Error).message}); attempting claims anyway.`))
          }
        }

        const statuses = await resolveVoucherStatuses(
          vouchers.filter((v) => claimableBuyers.has(v.buyer.toLowerCase())),
          makeVoucherClaimedReader(crypto.rpcUrl),
          { warn: (m) => console.warn(chalk.yellow(m)) },
        )
        const result = await claimDelegateVouchers({
          statuses,
          registry: registryClient,
          signer: identity.wallet,
          onClaim: (status, tx) =>
            console.log(chalk.green(`Claimed ${status.voucher.credits} credit(s) on commitment ${status.voucher.probeCommitment.slice(0, 10)}… (tx ${tx.slice(0, 10)}…)`)),
          onError: (status, err) =>
            console.warn(chalk.yellow(`Voucher ${status.digest.slice(0, 10)}…: claim failed (continuing): ${err.message}`)),
        })
        hadFailures = hadFailures || result.failed > 0
        console.log(chalk.bold(
          `Vouchers: ${result.claimedCount} claimed (${result.claimedCredits} credit(s)), `
          + `${result.skippedClaimed} already claimed, ${result.skippedExpired} expired, ${result.failed} failed.`,
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
