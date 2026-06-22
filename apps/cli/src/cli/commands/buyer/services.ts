import type { Command } from 'commander';
import chalk from 'chalk';
import { getGlobalOptions } from '../types.js';
import { loadConfig, saveConfig } from '../../../config/loader.js';
import { getTrustedServicePlugins } from '../../../plugins/registry.js';

function availableNames(): string {
  return getTrustedServicePlugins().map((plugin) => plugin.name).join(', ') || '(none)';
}

export function registerBuyerServiceCommands(buyerCmd: Command): void {
  buyerCmd
    .command('enable-service <name>')
    .description(`Approve a service plugin so it runs while the buyer proxy is up. Available: ${availableNames()}`)
    .action(async (name: string) => {
      const plugin = getTrustedServicePlugins().find((candidate) => candidate.name === name);
      if (!plugin) {
        console.error(chalk.red(`Unknown service plugin "${name}". Available: ${availableNames()}`));
        process.exit(1);
      }
      const globalOpts = getGlobalOptions(buyerCmd);
      const config = await loadConfig(globalOpts.config);
      config.buyer.services = {
        ...(config.buyer.services ?? {}),
        [name]: { enabled: true, approvedAt: new Date().toISOString() },
      };
      await saveConfig(globalOpts.config, config);

      console.log(chalk.green(`Service "${name}" enabled.`));
      console.log(chalk.dim(plugin.description));
      console.log(chalk.dim('It runs only on networks that support it; otherwise it stays idle until you switch networks.'));
    });

  buyerCmd
    .command('disable-service <name>')
    .description('Stop a service plugin (consent only; any on-chain state, e.g. an EIP-7702 delegation, persists)')
    .action(async (name: string) => {
      const plugin = getTrustedServicePlugins().find((candidate) => candidate.name === name);
      if (!plugin) {
        console.error(chalk.red(`Unknown service plugin "${name}". Available: ${availableNames()}`));
        process.exit(1);
      }
      const globalOpts = getGlobalOptions(buyerCmd);
      const config = await loadConfig(globalOpts.config);
      config.buyer.services = {
        ...(config.buyer.services ?? {}),
        [name]: { enabled: false },
      };
      await saveConfig(globalOpts.config, config);

      console.log(chalk.green(`Service "${name}" disabled.`));
    });
}
