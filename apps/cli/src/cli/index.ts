#!/usr/bin/env node

import { Command } from 'commander';
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
import { registerBootstrapCommand } from './commands/bootstrap.js';
import { registerConnectionCommand } from './commands/connection.js';

loadEnvFromFiles();

import pkg from '../../package.json' with { type: 'json' };
const version = pkg.version;

const program = new Command();

program
  .name('antseed')
  .description('P2P network for AI services')
  .version(version)
  .option('-c, --config <path>', 'path to config file (env: ANTSEED_CONFIG, default: ~/.antseed/config.json)')
  .option('--data-dir <path>', 'path to node identity/state directory (env: ANTSEED_DATA_DIR, default: ~/.antseed)')
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
registerBootstrapCommand(program);
registerConnectionCommand(program);

program.parse(process.argv);
