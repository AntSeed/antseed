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

      const { wallet, address } = await loadCryptoContext(globalOpts.dataDir);
      const identityClient = createIdentityClient(config);

      console.log(chalk.dim(`Wallet: ${address}`));

      // Check if already registered
      const spinner = ora('Checking registration status...').start();

      try {
        const alreadyRegistered = await identityClient.isRegistered(address);
        if (alreadyRegistered) {
          const tokenId = await identityClient.getTokenId(address);
          spinner.succeed(chalk.yellow(`Already registered (token ID: ${tokenId})`));
          return;
        }

        // Derive a short peerId from the address for on-chain registration
        // Use first 31 bytes of the address hex (bytes32 limit for encodeBytes32String)
        const peerId = address.slice(2, 33).toLowerCase();

        spinner.text = 'Registering peer identity...';
        const txHash = await identityClient.register(wallet, peerId, options.metadata as string);
        spinner.succeed(chalk.green('Peer identity registered'));

        const tokenId = await identityClient.getTokenId(address);
        console.log(chalk.dim(`Token ID: ${tokenId}`));
        console.log(chalk.dim(`Transaction: ${txHash}`));
      } catch (err) {
        spinner.fail(chalk.red(`Registration failed: ${(err as Error).message}`));
        process.exit(1);
      }
    });
}
