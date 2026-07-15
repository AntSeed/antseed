import type { Command } from 'commander'
import { registerDelegateCreditsCommand } from './credits.js'
import { registerDelegateClaimCommand } from './claim.js'

/**
 * Delegate (probe carrier) commands. A buyer running with
 * `buyer.delegate.enabled` earns delegate credits that accrue on-chain when
 * verifiers anchor the seller-signed exchanges it carried; the worker records
 * the discovered accruals in `<dataDir>/delegate/credits.json`. These commands
 * are how the buyer's deposits operator turns them into on-chain credits and
 * ANTS rewards.
 */
export function registerDelegateCommands(program: Command): void {
  const delegateCmd = program
    .command('delegate')
    .description('Delegate commands — list and claim delegate credits earned by carrying verifier probe traffic')
  registerDelegateCreditsCommand(delegateCmd)
  registerDelegateClaimCommand(delegateCmd)
}
