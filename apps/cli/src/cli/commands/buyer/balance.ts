import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { getGlobalOptions } from '../types.js';
import { loadConfig } from '../../../config/loader.js';
import {
  loadOrCreateIdentity,
  DepositsClient,
  resolveChainConfig,
} from '@antseed/node';

function formatUsdc(baseUnits: bigint): string {
  const whole = baseUnits / 1_000_000n;
  const frac = baseUnits % 1_000_000n;
  const fracStr = frac.toString().padStart(6, '0').replace(/0+$/, '') || '0';
  return `${whole}.${fracStr}`;
}

export function registerBuyerBalanceCommand(buyerCmd: Command): void {
  buyerCmd
    .command('balance')
    .description('Show deposits balance for your wallet')
    .option('--json', 'output as JSON', false)
    .action(async (options) => {
      const globalOpts = getGlobalOptions(buyerCmd);
      const config = await loadConfig(globalOpts.config);

      const payments = config.payments;
      const chainConfig = resolveChainConfig({
        chainId: payments?.crypto?.chainId,
        rpcUrl: payments?.crypto?.rpcUrl,
        depositsContractAddress: payments?.crypto?.depositsContractAddress,
        usdcContractAddress: payments?.crypto?.usdcContractAddress,
      });

      const identity = await loadOrCreateIdentity(globalOpts.dataDir);
      const address = identity.wallet.address;

      const depositsClient = new DepositsClient({
        rpcUrl: chainConfig.rpcUrl,
        ...(chainConfig.fallbackRpcUrls ? { fallbackRpcUrls: chainConfig.fallbackRpcUrls } : {}),
        contractAddress: chainConfig.depositsContractAddress,
        usdcAddress: chainConfig.usdcContractAddress,
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
      } catch (err) {
        spinner.fail(chalk.red(`Failed to fetch balance: ${(err as Error).message}`));
        process.exit(1);
      }
    });
}
