import type { Command } from 'commander'
import { registerVerifierAuditCommand } from './audit.js'
import { registerVerifierBenchmarkCommand } from './benchmark.js'
import { registerVerifierClaimCommand } from './claim.js'
import { registerVerifierReferenceCommand } from './reference.js'
import { registerVerifierStartCommand } from './start.js'
import { registerVerifierStatusCommand } from './status.js'

export function registerVerifierCommands(program: Command): void {
  const verifierCmd = program
    .command('verifier')
    .description('Verifier commands — pay sellers for direct KBF probes and attest final results')
  registerVerifierStartCommand(verifierCmd)
  registerVerifierAuditCommand(verifierCmd)
  registerVerifierBenchmarkCommand(verifierCmd)
  registerVerifierStatusCommand(verifierCmd)
  registerVerifierClaimCommand(verifierCmd)
  registerVerifierReferenceCommand(verifierCmd)
}
