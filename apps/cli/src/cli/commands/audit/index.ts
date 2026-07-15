import type { Command } from 'commander'
import { registerAuditVerifyCommand } from './verify.js'

/**
 * `antseed audit` — public audit tooling. Anyone (not just verifiers) can
 * recompute a transparent audit from on-chain data plus the published pack.
 */
export function registerAuditCommands(program: Command): void {
  const auditCmd = program
    .command('audit')
    .description('Audit tooling — recompute published model-verification audits from public data')
  registerAuditVerifyCommand(auditCmd)
}
