import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { getGlobalOptions } from './types.js';
import { loadConfig } from '../../config/loader.js';
import {
  createEmissionsClient,
  loadCryptoContext,
  formatAnts,
} from '../payment-utils.js';

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
    .action(async (options) => {
      const globalOpts = getGlobalOptions(parentCmd);
      const config = await loadConfig(globalOpts.config);

      const { address } = await loadCryptoContext(globalOpts.dataDir);
      const emissionsClient = createEmissionsClient(config);

      const spinner = ora('Fetching emissions info...').start();

      try {
        const epochInfo = await emissionsClient.getEpochInfo();
        const pending = await emissionsClient.pendingEmissions(address, pastEpochs(epochInfo.epoch));
        const rolePending = claimablePendingForRole(pending, role);

        spinner.stop();

        if (options.json) {
          console.log(JSON.stringify({
            address,
            epoch: epochInfo.epoch,
            emissionRate: formatAnts(epochInfo.emission),
            epochDuration: epochInfo.epochDuration,
            [pendingJsonKey(role)]: formatAnts(rolePending),
          }, null, 2));
          return;
        }

        console.log(chalk.bold('Emissions Info:\n'));
        console.log(`  Epoch:           ${chalk.cyan(String(epochInfo.epoch))}`);
        console.log(`  Emission rate:   ${chalk.green(formatAnts(epochInfo.emission) + ' ANTS/epoch')}`);
        console.log('');
        console.log(chalk.bold(`${roleLabel(role)} Pending Emissions (${address.slice(0, 10)}...):\n`));
        console.log(`  ${roleLabel(role)} rewards:  ${chalk.green(formatAnts(rolePending) + ' ANTS')}`);
      } catch (err) {
        spinner.fail(chalk.red(`Failed to fetch emissions: ${(err as Error).message}`));
        process.exit(1);
      }
    });

  emissions
    .command('claim')
    .description(`Claim pending ${role} ANTS emissions`)
    .action(async () => {
      const globalOpts = getGlobalOptions(parentCmd);
      const config = await loadConfig(globalOpts.config);

      const { wallet, address } = await loadCryptoContext(globalOpts.dataDir);
      const emissionsClient = createEmissionsClient(config);

      console.log(chalk.dim(`Wallet: ${address}`));

      const spinner = ora(`Claiming ${role} emissions...`).start();

      try {
        const epochInfo = await emissionsClient.getEpochInfo();
        const epochs = pastEpochs(epochInfo.epoch);
        const pending = await emissionsClient.pendingEmissions(address, epochs);
        const claimablePending = claimablePendingForRole(pending, role);
        if (claimablePending === 0n) {
          spinner.succeed(chalk.yellow(`No pending ${role} emissions to claim.`));
          return;
        }

        console.log(chalk.dim(`Pending ${roleLabel(role).toLowerCase()}: ${formatAnts(claimablePending)} ANTS`));

        const txHash = role === 'seller'
          ? await emissionsClient.claimSellerEmissions(wallet, epochs)
          : await emissionsClient.claimBuyerEmissions(wallet, address, epochs);

        spinner.succeed(chalk.green(`Claimed ${formatAnts(claimablePending)} ANTS`));
        console.log(chalk.dim(`Transaction: ${txHash}`));
      } catch (err) {
        spinner.fail(chalk.red(`Claim failed: ${(err as Error).message}`));
        process.exit(1);
      }
    });
}
