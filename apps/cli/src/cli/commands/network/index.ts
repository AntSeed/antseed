import type { Command } from 'commander';
import { registerNetworkBrowseCommand } from './browse.js';
import { registerNetworkBootstrapCommand } from './bootstrap.js';

export function registerNetworkCommands(program: Command): void {
  const networkCmd = program
    .command('network')
    .description('Network discovery and infrastructure');

  registerNetworkBrowseCommand(networkCmd);
  registerNetworkBootstrapCommand(networkCmd);
}
