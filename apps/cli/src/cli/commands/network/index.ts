import type { Command } from 'commander';
import { registerNetworkBrowseCommand } from './browse.js';
import { registerNetworkPeerCommand } from './peer.js';
import { registerNetworkBootstrapCommand } from './bootstrap.js';
import { registerNetworkContractsCommand } from './contracts.js';

export function registerNetworkCommands(program: Command): void {
  const networkCmd = program
    .command('network')
    .description('Network discovery and infrastructure');

  registerNetworkBrowseCommand(networkCmd);
  registerNetworkPeerCommand(networkCmd);
  registerNetworkBootstrapCommand(networkCmd);
  registerNetworkContractsCommand(networkCmd);
}
