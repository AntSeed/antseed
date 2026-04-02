import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { getGlobalOptions } from './types.js';
import { loadConfig } from '../../config/loader.js';
import {
  createDepositsClient,
  loadCryptoContext,
  parseUsdcToBaseUnits,
} from '../payment-utils.js';

export function registerDepositCommand(program: Command): void {
  program
    .command('deposit <amount>')
    .description('Deposit USDC into the deposits contract (amount in human-readable USDC, e.g. "5" = 5 USDC)')
    .action(async (amount: string) => {
      const globalOpts = getGlobalOptions(program);
      const config = await loadConfig(globalOpts.config);

      let amountBaseUnits: bigint;
      try {
        amountBaseUnits = parseUsdcToBaseUnits(amount);
      } catch {
        console.error(chalk.red('Error: Amount must be a positive number.'));
        process.exit(1);
      }

      const { wallet, address } = await loadCryptoContext(globalOpts.dataDir);
      const depositsClient = createDepositsClient(config);

      const amountFloat = parseFloat(amount);
      console.log(chalk.dim(`Wallet: ${address}`));
      console.log(chalk.dim(`Amount: ${amountFloat} USDC (${amountBaseUnits} base units)`));

      const spinner = ora('Depositing USDC into deposits contract...').start();

      try {
        const txHash = await depositsClient.deposit(wallet, address, amountBaseUnits);
        spinner.succeed(chalk.green(`Deposited ${amountFloat} USDC into deposits contract`));
        console.log(chalk.dim(`Transaction: ${txHash}`));
      } catch (err) {
        spinner.fail(chalk.red(`Deposit failed: ${(err as Error).message}`));
        process.exit(1);
      }
    });
}
