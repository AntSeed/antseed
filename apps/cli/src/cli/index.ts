#!/usr/bin/env node

import { Command } from 'commander';
import { createRequire } from 'node:module';
import { loadEnvFromFiles } from '../env/load-env.js';
import { registerSeedCommand } from './commands/seed.js';
import { registerConnectCommand } from './commands/connect.js';
import { registerStatusCommand } from './commands/status.js';
import { registerConfigCommand } from './commands/config.js';
import { registerDashboardCommand } from './commands/dashboard.js';
import { registerDevCommand } from './commands/dev.js';
import { registerBrowseCommand } from './commands/browse.js';
import { registerInitCommand } from './commands/init.js';
import { registerPluginCommand } from './commands/plugin.js';
import { registerProfileCommand, registerPeerCommand } from './commands/profile.js';
import { registerDepositCommand } from './commands/deposit.js';
import { registerWithdrawCommand } from './commands/withdraw.js';
import { registerBalanceCommand } from './commands/balance.js';

loadEnvFromFiles();

const require = createRequire(import.meta.url);
const { version } = require('../../package.json') as { version: string };

const program = new Command();

program
  .name('antseed')
  .description('P2P network for AI services')
  .version(version)
  .option('-c, --config <path>', 'path to config file', '~/.antseed/config.json')
  .option('--data-dir <path>', 'path to node identity/state directory', '~/.antseed')
  .option('-v, --verbose', 'enable verbose logging', false);

registerSeedCommand(program);
registerConnectCommand(program);
registerStatusCommand(program);
registerConfigCommand(program);
registerDashboardCommand(program);
registerDevCommand(program);
registerBrowseCommand(program);
registerInitCommand(program);
registerPluginCommand(program);
registerProfileCommand(program);
registerPeerCommand(program);
registerDepositCommand(program);
registerWithdrawCommand(program);
registerBalanceCommand(program);

program.parse(process.argv);
