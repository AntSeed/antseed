import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { getGlobalOptions } from './types.js';
import { loadConfig } from '../../config/loader.js';
import {
  createEscrowClient,
  loadCryptoContext,
  formatUsdc,
  parseUsdcToBaseUnits,
} from '../payment-utils.js';

export function registerWithdrawCommand(program: Command): void {
  const withdraw = program
    .command('withdraw')
    .description('Withdraw USDC from escrow (3-step flow: request → execute → cancel)');

  withdraw
    .command('request <amount>')
    .description('Request withdrawal of USDC from escrow (starts timelock)')
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
      const escrowClient = createEscrowClient(config);

      const amountFloat = parseFloat(amount);
      console.log(chalk.dim(`Wallet: ${address}`));
      console.log(chalk.dim(`Amount: ${amountFloat} USDC (${amountBaseUnits} base units)`));

      const spinner = ora('Requesting withdrawal...').start();

      try {
        const txHash = await escrowClient.requestWithdrawal(wallet, amountBaseUnits);
        spinner.succeed(chalk.green(`Withdrawal requested for ${amountFloat} USDC`));
        console.log(chalk.dim(`Transaction: ${txHash}`));
        console.log(chalk.dim('Wait for the timelock to expire, then run: antseed withdraw execute'));
      } catch (err) {
        spinner.fail(chalk.red(`Withdrawal request failed: ${(err as Error).message}`));
        process.exit(1);
      }
    });

  withdraw
    .command('execute')
    .description('Execute a pending withdrawal (after timelock)')
    .action(async () => {
      const globalOpts = getGlobalOptions(program);
      const config = await loadConfig(globalOpts.config);

      const { wallet, address } = await loadCryptoContext(globalOpts.dataDir);
      const escrowClient = createEscrowClient(config);

      console.log(chalk.dim(`Wallet: ${address}`));

      const spinner = ora('Checking pending withdrawal...').start();

      try {
        const balance = await escrowClient.getBuyerBalance(address);
        if (balance.pendingWithdrawal === 0n) {
          spinner.fail(chalk.yellow('No pending withdrawal to execute.'));
          return;
        }

        console.log(chalk.dim(`Pending: ${formatUsdc(balance.pendingWithdrawal)} USDC`));

        spinner.text = 'Executing withdrawal...';
        const txHash = await escrowClient.executeWithdrawal(wallet);
        spinner.succeed(chalk.green(`Withdrew ${formatUsdc(balance.pendingWithdrawal)} USDC`));
        console.log(chalk.dim(`Transaction: ${txHash}`));
      } catch (err) {
        spinner.fail(chalk.red(`Withdrawal execution failed: ${(err as Error).message}`));
        process.exit(1);
      }
    });

  withdraw
    .command('cancel')
    .description('Cancel a pending withdrawal request')
    .action(async () => {
      const globalOpts = getGlobalOptions(program);
      const config = await loadConfig(globalOpts.config);

      const { wallet, address } = await loadCryptoContext(globalOpts.dataDir);
      const escrowClient = createEscrowClient(config);

      console.log(chalk.dim(`Wallet: ${address}`));

      const spinner = ora('Cancelling withdrawal...').start();

      try {
        const txHash = await escrowClient.cancelWithdrawal(wallet);
        spinner.succeed(chalk.green('Withdrawal cancelled'));
        console.log(chalk.dim(`Transaction: ${txHash}`));
      } catch (err) {
        spinner.fail(chalk.red(`Cancel failed: ${(err as Error).message}`));
        process.exit(1);
      }
    });
}
