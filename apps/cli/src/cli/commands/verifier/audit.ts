import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import chalk from 'chalk'
import type { Command } from 'commander'
import { VerificationStorage } from '@antseed/node'
import { loadConfig } from '../../../config/loader.js'
import { createQueuedAuditPlan, normalizePeerId } from '../../../verifier/audit-queue.js'
import { assertAuditDurationMs, DEFAULT_AUDIT_DURATION_MS } from '../../../verifier/audit-duration.js'
import { getGlobalOptions } from '../types.js'
import { parsePositiveIntFlag } from './flags.js'

const DEFAULT_JOB_TIMEOUT_MS = 120_000

export function registerVerifierAuditCommand(verifierCmd: Command): void {
  verifierCmd
    .command('audit')
    .description('Queue a specific seller/service audit for the verifier daemon')
    .requiredOption('--service <id>', 'exact advertised service/model id')
    .requiredOption('--peer <peer-id>', 'target seller peer id')
    .option('--duration-hours <hours>', 'override the audit scheduling duration', parsePositiveIntFlag)
    .action(async (options, command: Command) => {
      const globalOptions = getGlobalOptions(command)
      const config = await loadConfig(globalOptions.config)
      const service = String(options.service).trim()
      if (!service) throw new Error('service must not be empty')
      const peerId = normalizePeerId(String(options.peer))
      const durationMs = assertAuditDurationMs(options.durationHours === undefined
        ? config.verifier?.auditDurationMs ?? DEFAULT_AUDIT_DURATION_MS
        : Number(options.durationHours) * 60 * 60 * 1_000)

      await mkdir(globalOptions.dataDir, { recursive: true })
      const storage = new VerificationStorage(join(globalOptions.dataDir, 'verification.db'))
      const now = Date.now()
      const plan = createQueuedAuditPlan({
        source: 'manual',
        durationMs,
        targetPeerId: peerId,
        targetService: service,
        jobTimeoutMs: config.verifier?.jobTimeoutMs ?? DEFAULT_JOB_TIMEOUT_MS,
        now,
      })
      try {
        storage.saveAuditPlan(plan)
      } finally {
        storage.close()
      }
      console.log(chalk.green(`Queued verifier audit ${plan.auditId}`))
      console.log(chalk.dim(`  target: ${plan.targetPeerId}`))
      console.log(chalk.dim(`  service: ${plan.targetService}`))
      console.log(chalk.dim(`  duration: ${Math.round(plan.durationMs / 3_600_000)} hour(s)`))
    })
}
