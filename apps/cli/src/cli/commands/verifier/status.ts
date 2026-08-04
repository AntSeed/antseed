import { join } from 'node:path'
import chalk from 'chalk'
import type { Command } from 'commander'
import { VerificationStorage, type StoredDirectAudit } from '@antseed/node'
import { loadConfig } from '../../../config/loader.js'
import {
  firstScanEpoch,
  verifierRewardWindow,
} from '../../../verifier/epoch-rewards.js'
import {
  createVerifierRegistryClient,
  createVerifierRewardsClient,
  formatAnts,
  loadCryptoContext,
} from '../../payment-utils.js'
import { getGlobalOptions } from '../types.js'

export function registerVerifierStatusCommand(verifierCmd: Command): void {
  verifierCmd
    .command('status')
    .description('Show verifier approval, epoch credits, rewards, and direct audits')
    .option('--rpc-url <url>', 'Base JSON-RPC URL override')
    .option('--audit-id <id>', 'show one direct audit')
    .option('--json', 'emit machine-readable JSON')
    .action(async (options, command: Command) => {
      const globalOptions = getGlobalOptions(command)
      const config = await loadConfig(globalOptions.config)
      const { address } = await loadCryptoContext(globalOptions.dataDir)
      const rpcOverrides = options.rpcUrl ? { rpcUrl: String(options.rpcUrl) } : {}
      const registryClient = createVerifierRegistryClient(config, rpcOverrides)
      const rewardsClient = createVerifierRewardsClient(config, rpcOverrides)
      const storage = new VerificationStorage(join(globalOptions.dataDir, 'verification.db'))
      try {
        const [approved, auditCooldown, maxCredits, minProbeCount, epoch] = await Promise.all([
          registryClient.approvedVerifier(address),
          registryClient.auditCooldown(),
          registryClient.maxCreditsPerVerifierPerEpoch(),
          registryClient.minProbeCount(),
          registryClient.currentEpoch(),
        ])
        const [credits, totalCredits] = await Promise.all([
          registryClient.epochCredits(epoch, address),
          registryClient.epochTotalCredits(epoch),
        ])
        const rewards = await listPendingRewards(registryClient, rewardsClient, address)
        const audits = options.auditId
          ? [storage.getDirectAudit(String(options.auditId))].filter((audit): audit is StoredDirectAudit => audit !== null)
          : storage.listDirectAudits().slice(0, 25)
        const output = {
          wallet: address,
          approved,
          policy: { auditCooldown, maxCreditsPerVerifierPerEpoch: maxCredits, minProbeCount },
          epoch: {
            number: epoch.toString(),
            verifierCredits: credits.toString(),
            totalCredits: totalCredits.toString(),
          },
          rewards,
          audits,
        }
        if (options.json) {
          console.log(JSON.stringify(output, null, 2))
          return
        }
        console.log(chalk.bold('Verifier status'))
        console.log(`  wallet:     ${address}`)
        console.log(`  approved:   ${approved ? chalk.green('yes') : chalk.red('no')}`)
        console.log(`  epoch:      ${epoch}`)
        console.log(`  credits:    ${credits}/${maxCredits} (network total ${totalCredits})`)
        console.log(`  cooldown:   ${auditCooldown}s per seller/service`)
        console.log(`  min probes: ${minProbeCount}`)
        if (rewards.length === 0) console.log(chalk.dim('  no unclaimed finalized rewards'))
        for (const reward of rewards) {
          console.log(`  reward ${reward.epoch}: ${reward.claimed ? chalk.dim('claimed') : `${formatAnts(BigInt(reward.pending))} ANTS claimable`}`)
        }
        console.log('')
        printAudits(audits)
      } finally {
        storage.close()
      }
    })
}

async function listPendingRewards(
  registryClient: ReturnType<typeof createVerifierRegistryClient>,
  rewardsClient: ReturnType<typeof createVerifierRewardsClient>,
  address: string,
): Promise<Array<{ epoch: string; credits: string; pending: string; claimed: boolean }>> {
  const window = await verifierRewardWindow(registryClient, rewardsClient)
  const rewards: Array<{ epoch: string; credits: string; pending: string; claimed: boolean }> = []
  for (let epoch = firstScanEpoch(window); epoch < window.currentEpoch; epoch += 1n) {
    const [credits, claimed] = await Promise.all([
      registryClient.epochCredits(epoch, address),
      rewardsClient.epochRewardClaimed(epoch, address),
    ])
    if (credits === 0n) continue
    const pending = claimed ? 0n : await rewardsClient.pendingVerifierReward(epoch, address)
    rewards.push({ epoch: epoch.toString(), credits: credits.toString(), pending: pending.toString(), claimed })
  }
  return rewards
}

function printAudits(audits: readonly StoredDirectAudit[]): void {
  if (audits.length === 0) {
    console.log(chalk.dim('No direct audits recorded.'))
    return
  }
  console.log('STATE'.padEnd(11), 'VERDICT'.padEnd(15), 'AUTH PROBES'.padEnd(13), 'AGENT'.padEnd(10), 'SERVICE')
  for (const audit of audits) {
    console.log(
      audit.state.padEnd(11),
      verdictName(audit.verdict).padEnd(15),
      `${audit.authenticatedProbeCount}/${audit.probeCount}`.padEnd(13),
      (audit.agentId ?? '-').padEnd(10),
      audit.targetService,
    )
    console.log(chalk.dim(`  audit=${audit.auditId} peer=${audit.targetPeerId}`))
    console.log(chalk.dim(`  reference=${audit.referenceId ?? '-'} power=${audit.statisticalPower ?? '-'} credited=${audit.credited ?? '-'}`))
    console.log(chalk.dim(`  evidence=${audit.evidencePath ?? '-'} tx=${audit.attestationTxHash ?? '-'}`))
    if (audit.failureReason) console.log(chalk.yellow(`  failure: ${audit.failureReason}`))
  }
}

function verdictName(verdict: number | null): string {
  if (verdict === 1) return 'SAME'
  if (verdict === 2) return 'DIFF'
  if (verdict === 3) return 'UNDETERMINED'
  return '-'
}
