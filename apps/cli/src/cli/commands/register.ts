import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { getGlobalOptions } from './types.js';
import { loadConfig } from '../../config/loader.js';
import {
  createIdentityClient,
  loadCryptoContext,
} from '../payment-utils.js';

export function registerRegisterCommand(program: Command): void {
  program
    .command('register')
    .description('Register your peer identity on-chain')
    .option('--metadata <uri>', 'metadata URI (optional)', '')
    .action(async (options) => {
      const globalOpts = getGlobalOptions(program);
      const config = await loadConfig(globalOpts.config);

      const spinner = ora('Checking registration status...').start();

      try {
        const { wallet, address } = await loadCryptoContext(globalOpts.dataDir);
        const identityClient = createIdentityClient(config);
        console.log(chalk.dim(`Wallet: ${address}`));
        const alreadyRegistered = await identityClient.isRegistered(address);
        if (alreadyRegistered) {
          spinner.succeed(chalk.yellow('Already registered'));
          return;
        }

        spinner.text = 'Registering peer identity...';
        const agentId = await identityClient.register(wallet, options.metadata as string || undefined);
        spinner.succeed(chalk.green('Peer identity registered'));

        console.log(chalk.dim(`Agent ID: ${agentId}`));
      } catch (err) {
        spinner.fail(chalk.red(`Registration failed: ${(err as Error).message}`));
        process.exit(1);
      }
    });
}
