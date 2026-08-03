import type { Command } from 'commander'
import { registerVerifierReferenceCommand } from './reference.js'
import { registerVerifierAuditCommand } from './audit.js'
import { registerVerifierAttestCommand } from './attest.js'
import { registerVerifierStartCommand } from './start.js'
import { registerVerifierStatusCommand } from './status.js'

export function registerVerifierCommands(program: Command): void {
  const verifierCmd = program
    .command('verifier')
    .description('Verifier commands — run trusted-reference KBF audits and attest them on-chain')
  registerVerifierStartCommand(verifierCmd)
  registerVerifierAuditCommand(verifierCmd)
  registerVerifierStatusCommand(verifierCmd)
  registerVerifierAttestCommand(verifierCmd)
  registerVerifierReferenceCommand(verifierCmd)
}
