import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import open from 'open';
import { getGlobalOptions } from './types.js';
import { loadConfig } from '../../config/loader.js';
import { createDashboardServer } from '@antseed/dashboard';
import type { DashboardServer } from '@antseed/dashboard';
import { setupShutdownHandler } from '../shutdown.js';

const DEFAULT_DASHBOARD_PORT = 3117;

/**
 * Register the `antseed dashboard` command on the Commander program.
 */
export function registerDashboardCommand(program: Command): void {
  program
    .command('dashboard')
    .description('Start the web dashboard for monitoring and configuration')
    .option('-p, --port <number>', 'dashboard port', (v) => parseInt(v, 10), DEFAULT_DASHBOARD_PORT)
    .option('--no-open', 'do not open browser automatically')
    .action(async (options) => {
      const globalOpts = getGlobalOptions(program);
      const config = await loadConfig(globalOpts.config);

      const port = (options.port ?? DEFAULT_DASHBOARD_PORT) as number;
      const spinner = ora('Starting dashboard server...').start();

      let server: DashboardServer;
      try {
        server = await createDashboardServer(
          config as unknown as Parameters<typeof createDashboardServer>[0],
          port,
          { configPath: globalOpts.config }
        );
        await server.start();
        spinner.succeed(chalk.green('Dashboard running'));
      } catch (err) {
        spinner.fail(chalk.red(`Failed to start dashboard: ${(err as Error).message}`));
        process.exit(1);
      }

      const url = `http://localhost:${port}`;
      console.log('');
      console.log(chalk.bold('Dashboard: ') + chalk.cyan(url));
      console.log(chalk.dim('Press Ctrl+C to stop'));
      console.log('');

      if (options.open !== false) {
        await open(url);
      }

      setupShutdownHandler(async () => {
        spinner.start('Stopping dashboard server...');
        await server.stop();
        spinner.succeed('Dashboard stopped.');
      });
    });
}
