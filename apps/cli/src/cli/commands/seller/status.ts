import type { Command } from 'commander';
import chalk from 'chalk';
import Table from 'cli-table3';
import { getGlobalOptions } from '../types.js';
import { loadConfig } from '../../../config/loader.js';
import { resolveEffectiveSellerConfig } from '../../../config/effective.js';
import { getNodeStatus } from '../../../status/node-status.js';
import { loadCryptoContext } from '../../payment-utils.js';
import { formatEarnings, formatTokens } from '../../formatters.js';

type SellerNodeState = 'seeding' | 'connected' | 'idle';

export function registerSellerStatusCommand(sellerCmd: Command): void {
  sellerCmd
    .command('status')
    .description('Show seller node status and readiness')
    .option('--json', 'output as JSON', false)
    .action(async (options) => {
      try {
        const globalOpts = getGlobalOptions(sellerCmd);
        const config = await loadConfig(globalOpts.config);
        const effectiveSeller = resolveEffectiveSellerConfig({ config });
        const status = await getNodeStatus(config, globalOpts.dataDir);
        const walletAddress = status.walletAddress ?? await (async () => {
          try {
            return (await loadCryptoContext(globalOpts.dataDir)).address;
          } catch {
            return null;
          }
        })();

        const providerSummary = Object.entries(effectiveSeller.providers).map(([name, cfg]) => {
          const defaults = cfg.defaults;
          const serviceCount = Object.keys(cfg.services).length;
          const priceLabel = defaults
            ? `${defaults.inputUsdPerMillion}/${defaults.outputUsdPerMillion}`
            : 'per-service';
          return {
            name,
            services: serviceCount,
            pricing: priceLabel,
            plugin: cfg.plugin,
          };
        });

        if (options.json) {
          console.log(JSON.stringify({
            state: status.state,
            peerCount: status.peerCount,
            earningsToday: status.earningsToday,
            tokensToday: status.tokensToday,
            activeChannels: status.activeChannels,
            uptime: status.uptime,
            walletAddress,
            providers: providerSummary,
          }, null, 2));
          return;
        }

        const stateColors: Record<SellerNodeState, (s: string) => string> = {
          seeding: chalk.green,
          connected: chalk.cyan,
          idle: chalk.gray,
        };
        const colorFn = stateColors[status.state] ?? chalk.white;
        console.log(chalk.bold('Seller Status: ') + colorFn(status.state.toUpperCase()));
        console.log('');

        const table = new Table({
          head: [chalk.bold('Metric'), chalk.bold('Value')],
          colWidths: [25, 55],
        });

        table.push(
          ['Peers connected', chalk.cyan(String(status.peerCount))],
          ['Earnings today', chalk.green(formatEarnings(status.earningsToday))],
          ['Tokens today', formatTokens(status.tokensToday)],
          ['Active channels', String(status.activeChannels)],
          ['Uptime', status.uptime],
          ['Wallet address', walletAddress ?? chalk.dim('not configured')],
        );

        table.push([
          'Configured providers',
          providerSummary.length > 0
            ? providerSummary.map((provider) => `${provider.name} (${provider.plugin}): ${provider.services} service(s), defaults ${provider.pricing}`).join('\n')
            : chalk.dim('(none)'),
        ]);

        console.log(table.toString());
      } catch (err) {
        console.error(chalk.red(`Error: ${(err as Error).message}`));
        process.exitCode = 1;
      }
    });
}
