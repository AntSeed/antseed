import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { getGlobalOptions } from './types.js';
import { loadConfig } from '../../config/loader.js';
import {
  loadOrCreateIdentity,
  DepositsClient,
  identityToEvmAddress,
} from '@antseed/node';

/** Format USDC base units (6 decimals) to human-readable string. */
function formatUsdc(baseUnits: bigint): string {
  const whole = baseUnits / 1_000_000n;
  const frac = baseUnits % 1_000_000n;
  const fracStr = frac.toString().padStart(6, '0').replace(/0+$/, '') || '0';
  return `${whole}.${fracStr}`;
}

export function registerBalanceCommand(program: Command): void {
  program
    .command('balance')
    .description('Show deposits balance for your wallet')
    .option('--json', 'output as JSON', false)
    .action(async (options) => {
      const globalOpts = getGlobalOptions(program);
      const config = await loadConfig(globalOpts.config);

      const payments = config.payments;
      if (!payments?.crypto) {
        console.error(chalk.red('Error: No crypto payment configuration found.'));
        console.error(chalk.dim('Configure payments.crypto in your config file or run: antseed init'));
        process.exit(1);
      }

      const identity = await loadOrCreateIdentity(globalOpts.dataDir);
      const address = identityToEvmAddress(identity);

      const depositsClient = new DepositsClient({
        rpcUrl: payments.crypto.rpcUrl,
        contractAddress: payments.crypto.depositsContractAddress,
        usdcAddress: payments.crypto.usdcContractAddress,
      });

      const spinner = ora('Fetching balance...').start();

      try {
        const account = await depositsClient.getBuyerBalance(address);
        const usdcBalance = await depositsClient.getUSDCBalance(address);

        spinner.stop();

        if (options.json) {
          console.log(JSON.stringify({
            address,
            walletUSDC: formatUsdc(usdcBalance),
            depositsAvailable: formatUsdc(account.available),
            depositsReserved: formatUsdc(account.reserved),
            depositsPendingWithdrawal: formatUsdc(account.pendingWithdrawal),
          }, null, 2));
          return;
        }

        console.log(chalk.bold('Wallet: ') + chalk.cyan(address));
        console.log('');
        console.log(chalk.bold('USDC Balance (wallet): ') + chalk.green(formatUsdc(usdcBalance) + ' USDC'));
        console.log('');
        console.log(chalk.bold('Deposits Account:'));
        console.log(`  Available:           ${chalk.green(formatUsdc(account.available) + ' USDC')}`);
        console.log(`  Reserved:            ${chalk.yellow(formatUsdc(account.reserved) + ' USDC')}`);
        console.log(`  Pending Withdrawal:  ${chalk.yellow(formatUsdc(account.pendingWithdrawal) + ' USDC')}`);
      } catch (err) {
        spinner.fail(chalk.red(`Failed to fetch balance: ${(err as Error).message}`));
        process.exit(1);
      }
    });
}
