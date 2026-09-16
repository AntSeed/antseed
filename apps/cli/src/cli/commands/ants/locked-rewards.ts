import { formatAnts, formatAntsExact, type LockedRewardsView, type previewLockedClaim } from '@antseed/ants';
import { pct } from './shared.js';

export interface LockedClaimOptions { locked?: boolean; staker?: boolean; seller?: boolean; buyer?: boolean; legacy?: boolean; dryRun?: boolean; yes?: boolean; }

export function validateLockedClaimOptions(options: LockedClaimOptions): boolean {
  const lockedOnly = options.locked === true && !options.staker && !options.seller && !options.buyer && !options.legacy;
  if ((options.dryRun || options.yes) && !lockedOnly) throw new Error('--dry-run and --yes require --locked without other reward buckets.');
  if (options.dryRun && options.yes) throw new Error('Use either --dry-run or --yes, not both.');
  return lockedOnly;
}

export function lockedClaimDecision(options: Pick<LockedClaimOptions, 'dryRun' | 'yes'>): 'preview' | 'send' | 'confirm' {
  return options.dryRun ? 'preview' : options.yes ? 'send' : 'confirm';
}

export function lockedRewardLines(view: LockedRewardsView): string[] {
  const policy = view.policy;
  const lines = [
    'Legacy seller rewards (M002)',
    `Network: ${view.chainId} (${view.evmChainId})`,
    `Seller: ${view.seller}`,
    `Read at block: ${view.blockNumber}`,
    `Pool: ${view.pool}`,
    `ANTS token: ${view.token}`,
    `Policy: ${policy?.address ?? 'not installed'}`,
    `Currently locked: ${formatAnts(view.locked)} ANTS`,
    `Pool transfer permission: ${view.transferAllowed ? 'enabled' : 'blocked'}`,
  ];
  if (policy) lines.push(
    `Cumulative locked: ${formatAnts(policy.cumulativeLocked)} ANTS`,
    `Previously withdrawn (reconstructed): ${formatAnts(policy.withdrawn)} ANTS`,
    `Release percentage: ${pct(Number(policy.releaseBps))}`,
    `Total release entitlement before restrictions: ${formatAnts(policy.entitlement)} ANTS`,
    `Claimable under policy: ${formatAnts(policy.claimable)} ANTS`,
    `Last legacy epoch: ${policy.lastEpoch}`,
    `Policy wash-trading registry: ${policy.washTradingRegistry}`,
    `Seller restricted: ${policy.restricted ? 'yes' : 'no'}`,
  );
  lines.push(view.blockers.length ? `Claim blocked: ${view.blockers.join(' ')}` : 'Ready to simulate a claim.');
  lines.push('No release date is promised for the remaining locked rewards.');
  return lines;
}

export function lockedPreviewLines(view: Awaited<ReturnType<typeof previewLockedClaim>>): string[] {
  return [
    ...lockedRewardLines(view),
    `Recipient: ${view.recipient}`,
    `Estimated gas: ${view.gas.gasEstimate} (buffered limit ${view.gas.gasLimit})`,
    `Estimated maximum execution fee: ${formatAntsExact(view.gas.maxExecutionFee)} ETH`,
    'Base L1 data fees may be additional. Amounts and fees can change before confirmation.',
  ];
}
