import type { Command } from 'commander';
import { registerEmissionsCommand } from '../emissions.js';

export function registerBuyerEmissionsCommand(buyerCmd: Command): void {
  registerEmissionsCommand(buyerCmd, 'buyer');
}
