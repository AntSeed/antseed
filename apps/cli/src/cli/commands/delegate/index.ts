import type { Command } from 'commander'
import { registerDelegateVouchersCommand } from './vouchers.js'
import { registerDelegateClaimCommand } from './claim.js'

/**
 * Delegate (probe carrier) commands. A buyer running with
 * `buyer.delegate.enabled` earns verifier-signed DelegateVouchers in
 * `<dataDir>/delegate/vouchers.jsonl`; these commands are how the buyer's
 * deposits operator turns them into on-chain credits and ANTS rewards
 * before their 30-day deadline.
 */
export function registerDelegateCommands(program: Command): void {
  const delegateCmd = program
    .command('delegate')
    .description('Delegate commands — list and claim DelegateVouchers earned by carrying verifier probe traffic')
  registerDelegateVouchersCommand(delegateCmd)
  registerDelegateClaimCommand(delegateCmd)
}
