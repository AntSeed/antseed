import type { Command } from 'commander';
import { registerBuyerStartCommand } from './start.js';
import { registerBuyerStatusCommand } from './status.js';
import { registerBuyerDepositCommand } from './deposit.js';
import { registerBuyerWithdrawCommand } from './withdraw.js';
import { registerBuyerBalanceCommand } from './balance.js';
import { registerBuyerConnectionCommand } from './connection.js';
import { registerBuyerChannelsCommand } from './channels.js';
import { registerBuyerMeteringCommand } from './metering.js';
import { registerBuyerEmissionsCommand } from './emissions.js';
import { registerRelayClaimsCommand } from '../relay/claims.js';

export function registerBuyerCommands(program: Command): void {
  const buyerCmd = program
    .command('buyer')
    .description('Buyer commands — connect to sellers and manage payments');

  registerBuyerStartCommand(buyerCmd);
  registerBuyerStatusCommand(buyerCmd);
  registerBuyerDepositCommand(buyerCmd);
  registerBuyerWithdrawCommand(buyerCmd);
  registerBuyerBalanceCommand(buyerCmd);
  registerBuyerConnectionCommand(buyerCmd);
  registerBuyerChannelsCommand(buyerCmd);
  registerBuyerMeteringCommand(buyerCmd);
  registerBuyerEmissionsCommand(buyerCmd);

  const relayCmd = buyerCmd
    .command('relay')
    .description('Embedded audit relay management');
  registerRelayClaimsCommand(relayCmd);
}
