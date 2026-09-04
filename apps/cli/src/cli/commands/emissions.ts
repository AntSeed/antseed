import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { getGlobalOptions } from './types.js';
import { loadConfig } from '../../config/loader.js';
import {
  createEmissionsClient,
  createLegacyEmissionsClient,
  createSellerPoolsClient,
  createUsageAccountingClient,
  createUsageRewardsClient,
  loadCryptoContext,
  formatAnts,
  resolveCliContractStack,
} from '../payment-utils.js';
import { legacyEpochs, newEpochs } from '@antseed/node/payments';

export type EmissionsRole = 'seller' | 'buyer';

export interface PendingEmissions {
  seller: bigint;
  buyer: bigint;
}

export function pastEpochs(currentEpoch: number): number[] {
  return Array.from({ length: currentEpoch }, (_, i) => i);
}

export function claimablePendingForRole(pending: PendingEmissions, role: EmissionsRole): bigint {
  return role === 'seller' ? pending.seller : pending.buyer;
}

export function selectedEmissionStacks(options: { legacyOnly?: boolean; newOnly?: boolean }): { legacy: boolean; recognized: boolean } {
  if (options.legacyOnly && options.newOnly) throw new Error('--legacy-only and --new-only cannot be used together');
  return {
    legacy: !options.newOnly,
    recognized: !options.legacyOnly,
  };
}

function roleLabel(role: EmissionsRole): string {
  return role === 'seller' ? 'Seller' : 'Buyer';
}

function pendingJsonKey(role: EmissionsRole): 'pendingSeller' | 'pendingBuyer' {
  return role === 'seller' ? 'pendingSeller' : 'pendingBuyer';
}

export function registerEmissionsCommand(parentCmd: Command, role: EmissionsRole): void {
  const emissions = parentCmd
    .command('emissions')
    .description('View epoch info and pending ANTS emissions');

  emissions
    .command('info')
    .description('Show current epoch info and pending emissions')
    .option('--json', 'output as JSON', false)
    .option('--legacy-only', 'show only legacy-stack rewards', false)
    .option('--new-only', 'show only recognized-usage rewards', false)
    .action(async (options) => {
      const globalOpts = getGlobalOptions(parentCmd);
      const config = await loadConfig(globalOpts.config);

      const { address } = await loadCryptoContext(globalOpts.dataDir);
      const spinner = ora('Fetching emissions info...').start();

      try {
        const selected = selectedEmissionStacks(options);
        const stack = await resolveCliContractStack(config);
        const legacyIds = stack.mode === 'legacy'
          ? pastEpochs(stack.currentEpoch)
          : legacyEpochs(stack.currentEpoch, stack.firstRewardedEpoch!);
        const recognizedIds = stack.mode === 'recognized-usage'
          ? newEpochs(stack.currentEpoch, stack.firstRewardedEpoch!)
          : [];
        let legacyPending = 0n;
        let recognizedPending = 0n;
        let emissionRate = 0n;
        let epochDuration = 0;

        if (selected.legacy && legacyIds.length >= 0) {
          const client = stack.mode === 'legacy' ? createEmissionsClient(config) : createLegacyEmissionsClient(config);
          const [epochInfo, pending] = await Promise.all([
            client.getEpochInfo(),
            client.pendingEmissions(address, legacyIds),
          ]);
          emissionRate = epochInfo.emission;
          epochDuration = epochInfo.epochDuration;
          legacyPending = claimablePendingForRole(pending, role);
        }

        let noCurrentPool = false;
        if (selected.recognized && stack.mode === 'recognized-usage') {
          if (role === 'seller') {
            const usage = createUsageAccountingClient(config);
            const pending = await usage.pendingEmissions(address, recognizedIds);
            recognizedPending = pending.seller;
            const pools = createSellerPoolsClient(config);
            const agentId = await pools.agentIdForSeller(address);
            noCurrentPool = agentId === 0 || !(await pools.hasPoolAtEpoch(agentId, stack.currentEpoch));
          } else {
            const rewards = createUsageRewardsClient(config);
            const amounts = await Promise.all(recognizedIds.map(async (epoch) => (
              await rewards.buyerEpochClaimed(address, epoch) ? 0n : rewards.pendingBuyerReward(address, epoch)
            )));
            recognizedPending = amounts.reduce((total, value) => total + value, 0n);
          }
        }

        spinner.stop();

        if (options.json) {
          console.log(JSON.stringify({
            address,
            mode: stack.mode,
            epoch: stack.currentEpoch,
            firstRewardedEpoch: stack.firstRewardedEpoch ?? null,
            emissionRate: formatAnts(emissionRate),
            epochDuration,
            legacy: { epochs: legacyIds, [pendingJsonKey(role)]: formatAnts(legacyPending) },
            recognizedUsage: { epochs: recognizedIds, [pendingJsonKey(role)]: formatAnts(recognizedPending) },
            [pendingJsonKey(role)]: formatAnts(legacyPending + recognizedPending),
            ...(role === 'seller' ? { hasCurrentPool: !noCurrentPool } : {}),
          }, null, 2));
          return;
        }

        console.log(chalk.bold('Emissions Info:\n'));
        console.log(`  Mode:            ${chalk.cyan(stack.mode)}`);
        console.log(`  Epoch:           ${chalk.cyan(String(stack.currentEpoch))}`);
        if (emissionRate > 0n) console.log(`  Emission rate:   ${chalk.green(formatAnts(emissionRate) + ' ANTS/epoch')}`);
        console.log('');
        console.log(chalk.bold(`${roleLabel(role)} Pending Emissions (${address.slice(0, 10)}...):\n`));
        if (selected.legacy) console.log(`  Legacy:          ${chalk.green(formatAnts(legacyPending) + ' ANTS')}`);
        if (selected.recognized && stack.mode === 'recognized-usage') console.log(`  Recognized use:  ${chalk.green(formatAnts(recognizedPending) + ' ANTS')}`);
        console.log(`  Total:           ${chalk.green(formatAnts(legacyPending + recognizedPending) + ' ANTS')}`);
        if (noCurrentPool) console.log(chalk.yellow('\n⚠ No active seller pool exists for the current epoch; new usage will not accrue rewards.'));
      } catch (err) {
        spinner.fail(chalk.red(`Failed to fetch emissions: ${(err as Error).message}`));
        process.exit(1);
      }
    });

  emissions
    .command('claim')
    .description(`Claim pending ${role} ANTS emissions`)
    .option('--legacy-only', 'claim only legacy-stack rewards', false)
    .option('--new-only', 'claim only recognized-usage rewards', false)
    .action(async (options) => {
      const globalOpts = getGlobalOptions(parentCmd);
      const config = await loadConfig(globalOpts.config);

      const { wallet, address } = await loadCryptoContext(globalOpts.dataDir);
      console.log(chalk.dim(`Wallet: ${address}`));

      const spinner = ora(`Claiming ${role} emissions...`).start();

      try {
        const selected = selectedEmissionStacks(options);
        const stack = await resolveCliContractStack(config);
        const legacyIds = stack.mode === 'legacy'
          ? pastEpochs(stack.currentEpoch)
          : legacyEpochs(stack.currentEpoch, stack.firstRewardedEpoch!);
        const recognizedIds = stack.mode === 'recognized-usage'
          ? newEpochs(stack.currentEpoch, stack.firstRewardedEpoch!)
          : [];
        let claimed = 0n;
        const transactions: string[] = [];

        if (selected.legacy) {
          const client = stack.mode === 'legacy' ? createEmissionsClient(config) : createLegacyEmissionsClient(config);
          const pending = await client.pendingEmissions(address, legacyIds);
          const amount = claimablePendingForRole(pending, role);
          if (amount > 0n) {
            transactions.push(role === 'seller'
              ? await client.claimSellerEmissions(wallet, legacyIds)
              : await client.claimBuyerEmissions(wallet, address, legacyIds));
            claimed += amount;
          }
        }

        if (selected.recognized && stack.mode === 'recognized-usage') {
          if (role === 'seller') {
            const usage = createUsageAccountingClient(config);
            const pending = await usage.pendingEmissions(address, recognizedIds);
            if (pending.seller > 0n) {
              transactions.push(await usage.claimSellerEmissions(wallet, recognizedIds));
              claimed += pending.seller;
            }
          } else {
            const rewards = createUsageRewardsClient(config);
            for (const epoch of recognizedIds.slice(-104)) {
              if (await rewards.buyerEpochClaimed(address, epoch)) continue;
              const amount = await rewards.pendingBuyerReward(address, epoch);
              if (amount === 0n) continue;
              transactions.push(await rewards.claimBuyerReward(wallet, address, epoch));
              claimed += amount;
            }
          }
        }

        if (claimed === 0n) {
          spinner.succeed(chalk.yellow(`No pending ${role} emissions to claim.`));
          return;
        }

        spinner.succeed(chalk.green(`Claimed ${formatAnts(claimed)} ANTS`));
        for (const txHash of transactions) console.log(chalk.dim(`Transaction: ${txHash}`));
      } catch (err) {
        spinner.fail(chalk.red(`Claim failed: ${(err as Error).message}`));
        process.exit(1);
      }
    });
}
