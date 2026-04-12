import type { Command } from 'commander';
import { registerProfileCommand, registerPeerCommand } from './profile.js';

export function registerIdentityCommands(program: Command): void {
  registerProfileCommand(program);
  registerPeerCommand(program);
}
