import type { Command } from 'commander'
import { registerVerifierStartCommand } from './start.js'
import { registerVerifierStatusCommand } from './status.js'
import { registerVerifierClaimCommand } from './claim.js'
import { registerVerifierReferenceCommand } from './reference.js'

export function registerVerifierCommands(program: Command): void {
  const verifierCmd = program
    .command('verifier')
    .description('Verifier commands — probe sellers as a buyer and attest model-identity verdicts on-chain')
  registerVerifierStartCommand(verifierCmd)
  registerVerifierStatusCommand(verifierCmd)
  registerVerifierClaimCommand(verifierCmd)
  registerVerifierReferenceCommand(verifierCmd)
}
