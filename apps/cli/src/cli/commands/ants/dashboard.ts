import type { Command } from 'commander';
import chalk from 'chalk';
import { createAntsServer } from '@antseed/ants';
import { loadAntsContext } from './shared.js';

export const DEFAULT_ANTS_PORT = 3119;

export function registerAntsDashboardAction(antsCmd: Command): void {
  antsCmd
    .option('-p, --port <port>', 'dashboard port', String(DEFAULT_ANTS_PORT))
    .option('--no-open', 'do not open the browser automatically')
    .action(async (options: { port: string; open: boolean }) => {
      const port = Number(options.port) || DEFAULT_ANTS_PORT;
      try {
        const { ctx, chain, dataDir, configPath } = await loadAntsContext(antsCmd);
        const server = await createAntsServer({ port, dataDir, configPath, chain, signer: ctx.signer!, address: ctx.address });
        const url = await server.listen();
        console.log('');
        console.log(chalk.bold('ANTS staking dashboard'));
        console.log(`  Wallet:  ${ctx.address}`);
        console.log(`  Chain:   ${chain.chainId} (${chain.rpcUrl})`);
        console.log(`  URL:     ${chalk.cyan(url)}`);
        console.log(chalk.dim('  The URL carries a one-time session token; only this browser session can act with your wallet.'));
        console.log(chalk.dim('  Every dashboard action has a CLI equivalent: antseed ants --help. Press Ctrl+C to stop.'));
        console.log('');
        if (options.open) {
          try {
            const { default: open } = await import('open');
            await open(url);
          } catch {
            console.log(chalk.yellow('Could not open a browser automatically; open the URL above manually.'));
          }
        }
        const shutdown = async () => {
          await server.close();
          process.exit(0);
        };
        process.on('SIGINT', () => { void shutdown(); });
        process.on('SIGTERM', () => { void shutdown(); });
      } catch (error) {
        console.error(chalk.red(`Failed to start the ANTS dashboard: ${(error as Error).message}`));
        process.exit(1);
      }
    });
}
