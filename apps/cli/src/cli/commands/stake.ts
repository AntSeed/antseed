import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { getGlobalOptions } from './types.js';
import { loadConfig } from '../../config/loader.js';
import {
  createEscrowClient,
  createIdentityClient,
  loadCryptoContext,
  formatUsdc,
  parseUsdcToBaseUnits,
} from '../payment-utils.js';

export function registerStakeCommand(program: Command): void {
  program
    .command('stake <amount>')
    .description('Stake USDC as a provider (amount in human-readable USDC, e.g. "10" = 10 USDC)')
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
      const identityClient = createIdentityClient(config);

      // Verify registration
      const spinner = ora('Verifying registration...').start();

      try {
        const isReg = await identityClient.isRegistered(address);
        if (!isReg) {
          spinner.fail(chalk.red('Not registered. Run: antseed register'));
          process.exit(1);
        }

        const amountFloat = parseFloat(amount);
        console.log(chalk.dim(`Wallet: ${address}`));
        console.log(chalk.dim(`Amount: ${amountFloat} USDC (${amountBaseUnits} base units)`));

        spinner.text = 'Staking USDC...';
        const txHash = await escrowClient.stake(wallet, amountBaseUnits);
        spinner.succeed(chalk.green(`Staked ${amountFloat} USDC`));
        console.log(chalk.dim(`Transaction: ${txHash}`));
      } catch (err) {
        spinner.fail(chalk.red(`Staking failed: ${(err as Error).message}`));
        process.exit(1);
      }
    });

  program
    .command('unstake')
    .description('Unstake USDC (subject to slash conditions)')
    .action(async () => {
      const globalOpts = getGlobalOptions(program);
      const config = await loadConfig(globalOpts.config);

      const { wallet, address } = await loadCryptoContext(globalOpts.dataDir);
      const escrowClient = createEscrowClient(config);

      console.log(chalk.dim(`Wallet: ${address}`));

      // Show current stake info
      const spinner = ora('Fetching stake info...').start();

      try {
        const account = await escrowClient.getSellerAccount(address);
        if (account.stake === 0n) {
          spinner.fail(chalk.yellow('No active stake to withdraw.'));
          return;
        }

        console.log(chalk.dim(`Current stake: ${formatUsdc(account.stake)} USDC`));
        console.log(chalk.dim(`Earnings: ${formatUsdc(account.earnings)} USDC`));

        spinner.text = 'Unstaking...';
        const txHash = await escrowClient.unstake(wallet);
        spinner.succeed(chalk.green('Unstaked successfully'));
        console.log(chalk.dim(`Transaction: ${txHash}`));
      } catch (err) {
        spinner.fail(chalk.red(`Unstake failed: ${(err as Error).message}`));
        process.exit(1);
      }
    });
}
