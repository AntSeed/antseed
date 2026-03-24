import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { getGlobalOptions } from './types.js';
import { loadConfig } from '../../config/loader.js';
import { loadOrCreateIdentity, identityToEvmAddress } from '@antseed/node';
import { checkSellerReadiness, checkBuyerReadiness } from '@antseed/node/payments';
import {
  createDepositsClient,
  createIdentityClient,
} from '../payment-utils.js';

export function registerSetupCommand(program: Command): void {
  program
    .command('setup')
    .description('Guided onboarding — check readiness and walk through setup steps')
    .option('--role <role>', 'role to check: provider or buyer', 'provider')
    .action(async (options) => {
      const globalOpts = getGlobalOptions(program);
      const config = await loadConfig(globalOpts.config);

      const role = options.role as string;
      if (role !== 'provider' && role !== 'buyer') {
        console.error(chalk.red('Error: --role must be "provider" or "buyer".'));
        process.exit(1);
      }

      const identity = await loadOrCreateIdentity(globalOpts.dataDir);
      const address = identityToEvmAddress(identity);

      console.log(chalk.bold('\nAntseed Setup\n'));
      console.log(chalk.dim(`Wallet: ${address}`));
      console.log(chalk.dim(`Role:   ${role}\n`));

      const spinner = ora('Running readiness checks...').start();

      try {
        const depositsClient = createDepositsClient(config);

        if (role === 'provider') {
          const identityClient = createIdentityClient(config);
          const checks = await checkSellerReadiness(identity, identityClient);
          spinner.stop();

          console.log(chalk.bold('Provider Readiness:\n'));
          let allPassed = true;
          for (const check of checks) {
            const icon = check.passed ? chalk.green('✓') : chalk.red('✗');
            console.log(`  ${icon} ${chalk.bold(check.name)}: ${check.message}`);
            if (!check.passed && check.command) {
              console.log(chalk.dim(`    → ${check.command}`));
            }
            if (!check.passed) allPassed = false;
          }

          console.log('');
          if (allPassed) {
            console.log(chalk.green('All checks passed! You are ready to seed.'));
            console.log(chalk.dim('Run: antseed seed --provider <name>'));
          } else {
            console.log(chalk.yellow('Some checks failed. Follow the suggestions above to complete setup.'));
          }
        } else {
          const checks = await checkBuyerReadiness(identity, depositsClient);
          spinner.stop();

          console.log(chalk.bold('Buyer Readiness:\n'));
          let allPassed = true;
          for (const check of checks) {
            const icon = check.passed ? chalk.green('✓') : chalk.red('✗');
            console.log(`  ${icon} ${chalk.bold(check.name)}: ${check.message}`);
            if (!check.passed && check.command) {
              console.log(chalk.dim(`    → ${check.command}`));
            }
            if (!check.passed) allPassed = false;
          }

          console.log('');
          if (allPassed) {
            console.log(chalk.green('All checks passed! You are ready to connect.'));
            console.log(chalk.dim('Run: antseed connect --router <name>'));
          } else {
            console.log(chalk.yellow('Some checks failed. Follow the suggestions above to complete setup.'));
          }
        }
      } catch (err) {
        spinner.fail(chalk.red(`Setup check failed: ${(err as Error).message}`));
        process.exit(1);
      }
    });
}
