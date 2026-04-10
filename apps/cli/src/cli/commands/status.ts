import type { Command } from 'commander';
import chalk from 'chalk';
import Table from 'cli-table3';
import { getGlobalOptions } from './types.js';
import { loadConfig } from '../../config/loader.js';
import { resolveEffectiveSellerConfig } from '../../config/effective.js';
import { getNodeStatus } from '../../status/node-status.js';
import type { NodeStatus } from '../../status/node-status.js';
import { formatEarnings, formatTokens } from '../formatters.js';

/** Possible node states */
export type NodeState = 'seeding' | 'connected' | 'idle';

/**
 * Register the `antseed status` command on the Commander program.
 */
export function registerStatusCommand(program: Command): void {
  program
    .command('status')
    .description('Show current Antseed node status')
    .option('--json', 'output as JSON', false)
    .action(async (options) => {
      try {
        const globalOpts = getGlobalOptions(program);
        const config = await loadConfig(globalOpts.config);
        const effectiveSeller = resolveEffectiveSellerConfig({ config });
        const status: NodeStatus = await getNodeStatus(config);

        if (options.json) {
          console.log(JSON.stringify(status, null, 2));
          return;
        }

        // State badge
        const stateColors: Record<NodeState, (s: string) => string> = {
          seeding: chalk.green,
          connected: chalk.cyan,
          idle: chalk.gray,
        };
        const colorFn = stateColors[status.state] ?? chalk.white;
        console.log(chalk.bold('Status: ') + colorFn(status.state.toUpperCase()));
        console.log('');

        // Summary table
        const table = new Table({
          head: [chalk.bold('Metric'), chalk.bold('Value')],
          colWidths: [25, 35],
        });

        table.push(
          ['Peers connected', chalk.cyan(String(status.peerCount))],
          ['Earnings today', chalk.green(formatEarnings(status.earningsToday))],
          ['Tokens today', formatTokens(status.tokensToday)],
          ['Active channels', String(status.activeChannels)],
          ['Uptime', status.uptime],
          ['Wallet address', status.walletAddress ?? chalk.dim('not configured')],
          ['Proxy port', status.proxyPort ? String(status.proxyPort) : chalk.dim('n/a')],
        );

        if (status.state === 'seeding') {
          const providerLines: string[] = [];
          for (const [name, cfg] of Object.entries(effectiveSeller.providers)) {
            const defaults = cfg.defaults;
            const serviceCount = Object.keys(cfg.services).length;
            const priceLabel = defaults
              ? `${defaults.inputUsdPerMillion}/${defaults.outputUsdPerMillion}`
              : 'per-service';
            providerLines.push(`${name}: ${serviceCount} service(s), defaults ${priceLabel}`);
          }
          table.push([
            'Seller providers',
            providerLines.length > 0 ? providerLines.join('\n') : chalk.dim('(none)'),
          ]);
        }

        console.log(table.toString());
      } catch (err) {
        console.error(chalk.red(`Error: ${(err as Error).message}`));
        process.exitCode = 1;
      }
    });
}
