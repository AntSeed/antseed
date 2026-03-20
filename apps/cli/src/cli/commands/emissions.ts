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

export function registerEmissionsCommand(program: Command): void {
  const emissions = program
    .command('emissions')
    .description('View epoch info and pending ANTS emissions');

  emissions
    .command('info')
    .description('Show current epoch info and pending emissions')
    .option('--json', 'output as JSON', false)
    .action(async (options) => {
      const globalOpts = getGlobalOptions(program);
      const config = await loadConfig(globalOpts.config);

      const { address } = await loadCryptoContext(globalOpts.dataDir);
      const emissionsClient = createEmissionsClient(config);

      const spinner = ora('Fetching emissions info...').start();

      try {
        const [epochInfo, pending] = await Promise.all([
          emissionsClient.getEpochInfo(),
          emissionsClient.pendingEmissions(address),
        ]);

        spinner.stop();

        const epochEndTs = epochInfo.epochStart + epochInfo.epochDuration;
        const now = Math.floor(Date.now() / 1000);
        const remaining = Math.max(0, epochEndTs - now);

        if (options.json) {
          console.log(JSON.stringify({
            address,
            epoch: epochInfo.epoch,
            emissionRate: formatAnts(epochInfo.emission),
            epochStart: epochInfo.epochStart,
            epochDuration: epochInfo.epochDuration,
            epochRemainingSeconds: remaining,
            pendingSeller: formatAnts(pending.seller),
            pendingBuyer: formatAnts(pending.buyer),
          }, null, 2));
          return;
        }

        console.log(chalk.bold('Emissions Info:\n'));
        console.log(`  Epoch:           ${chalk.cyan(String(epochInfo.epoch))}`);
        console.log(`  Emission rate:   ${chalk.green(formatAnts(epochInfo.emission) + ' ANTS/epoch')}`);
        console.log(`  Epoch remaining: ${chalk.dim(remaining + 's')}`);
        console.log('');
        console.log(chalk.bold(`Pending Emissions (${address.slice(0, 10)}...):\n`));
        console.log(`  Seller rewards:  ${chalk.green(formatAnts(pending.seller) + ' ANTS')}`);
        console.log(`  Buyer rewards:   ${chalk.green(formatAnts(pending.buyer) + ' ANTS')}`);
      } catch (err) {
        spinner.fail(chalk.red(`Failed to fetch emissions: ${(err as Error).message}`));
        process.exit(1);
      }
    });

  emissions
    .command('claim')
    .description('Claim pending ANTS emissions')
    .action(async () => {
      const globalOpts = getGlobalOptions(program);
      const config = await loadConfig(globalOpts.config);

      const { wallet, address } = await loadCryptoContext(globalOpts.dataDir);
      const emissionsClient = createEmissionsClient(config);

      console.log(chalk.dim(`Wallet: ${address}`));

      const spinner = ora('Claiming emissions...').start();

      try {
        const pending = await emissionsClient.pendingEmissions(address);
        const totalPending = pending.seller + pending.buyer;
        if (totalPending === 0n) {
          spinner.succeed(chalk.yellow('No pending emissions to claim.'));
          return;
        }

        console.log(chalk.dim(`Pending: ${formatAnts(totalPending)} ANTS`));

        const txHash = await emissionsClient.claimEmissions(wallet);
        spinner.succeed(chalk.green(`Claimed ${formatAnts(totalPending)} ANTS`));
        console.log(chalk.dim(`Transaction: ${txHash}`));
      } catch (err) {
        spinner.fail(chalk.red(`Claim failed: ${(err as Error).message}`));
        process.exit(1);
      }
    });
}
