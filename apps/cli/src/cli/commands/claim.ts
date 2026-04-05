import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { getGlobalOptions } from './types.js';
import { loadConfig } from '../../config/loader.js';
import {
  createDepositsClient,
  loadCryptoContext,
  formatUsdc,
} from '../payment-utils.js';

export function registerClaimCommand(program: Command): void {
  program
    .command('claim')
    .description('Claim accumulated seller payouts from the deposits contract')
    .action(async () => {
      const globalOpts = getGlobalOptions(program);
      const config = await loadConfig(globalOpts.config);

      const spinner = ora('Checking seller payouts...').start();

      try {
        const { wallet, address } = await loadCryptoContext(globalOpts.dataDir);
        const depositsClient = createDepositsClient(config);

        const pending = await depositsClient.getSellerPayouts(address);
        if (pending === 0n) {
          spinner.succeed(chalk.yellow('No payouts to claim.'));
          return;
        }

        console.log(chalk.dim(`Wallet: ${address}`));
        console.log(chalk.dim(`Pending payouts: ${formatUsdc(pending)} USDC`));

        spinner.text = 'Claiming payouts...';
        const txHash = await depositsClient.claimPayouts(wallet);
        spinner.succeed(chalk.green(`Claimed ${formatUsdc(pending)} USDC`));
        console.log(chalk.dim(`Transaction: ${txHash}`));
      } catch (err) {
        spinner.fail(chalk.red(`Claim failed: ${(err as Error).message}`));
        process.exit(1);
      }
    });
}
