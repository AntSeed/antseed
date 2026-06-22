import type { Command } from 'commander';
import { registerEmissionsCommand } from '../emissions.js';

export function registerSellerEmissionsCommand(sellerCmd: Command): void {
  registerEmissionsCommand(sellerCmd, 'seller');
}
