import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { getGlobalOptions } from './types.js';
import { loadConfig } from '../../config/loader.js';
import {
  createEscrowClient,
  createIdentityClient,
  loadCryptoContext,
  formatUsdc,
} from '../payment-utils.js';

export function registerBalanceCommand(program: Command): void {
  program
    .command('balance')
    .description('Show escrow balance, stake, earnings, and reputation summary')
    .option('--json', 'output as JSON', false)
    .action(async (options) => {
      const globalOpts = getGlobalOptions(program);
      const config = await loadConfig(globalOpts.config);

      const { address } = await loadCryptoContext(globalOpts.dataDir);
      const escrowClient = createEscrowClient(config);

      const spinner = ora('Fetching balance...').start();

      try {
        const [buyerBalance, sellerAccount, usdcBalance] = await Promise.all([
          escrowClient.getBuyerBalance(address),
          escrowClient.getSellerAccount(address),
          escrowClient.getUSDCBalance(address),
        ]);

        // Try to get reputation info if identity contract is configured
        let reputationInfo: { tokenId: number; firstSignCount: number; qualifiedProvenSignCount: number; ghostCount: number } | null = null;
        try {
          const identityClient = createIdentityClient(config);
          const isReg = await identityClient.isRegistered(address);
          if (isReg) {
            const tokenId = await identityClient.getTokenId(address);
            const rep = await identityClient.getReputation(tokenId);
            reputationInfo = {
              tokenId,
              firstSignCount: rep.firstSignCount,
              qualifiedProvenSignCount: rep.qualifiedProvenSignCount,
              ghostCount: rep.ghostCount,
            };
          }
        } catch {
          // Identity contract not configured or not available — non-fatal
        }

        spinner.stop();

        if (options.json) {
          console.log(JSON.stringify({
            address,
            walletUSDC: formatUsdc(usdcBalance),
            buyer: {
              available: formatUsdc(buyerBalance.available),
              reserved: formatUsdc(buyerBalance.reserved),
              pendingWithdrawal: formatUsdc(buyerBalance.pendingWithdrawal),
            },
            seller: {
              stake: formatUsdc(sellerAccount.stake),
              earnings: formatUsdc(sellerAccount.earnings),
              tokenRate: sellerAccount.tokenRate.toString(),
            },
            reputation: reputationInfo,
          }, null, 2));
          return;
        }

        console.log(chalk.bold('Wallet: ') + chalk.cyan(address));
        console.log('');
        console.log(chalk.bold('USDC Balance (wallet): ') + chalk.green(formatUsdc(usdcBalance) + ' USDC'));
        console.log('');
        console.log(chalk.bold('Buyer Account:'));
        console.log(`  Available:           ${chalk.green(formatUsdc(buyerBalance.available) + ' USDC')}`);
        console.log(`  Reserved:            ${chalk.yellow(formatUsdc(buyerBalance.reserved) + ' USDC')}`);
        console.log(`  Pending withdrawal:  ${chalk.dim(formatUsdc(buyerBalance.pendingWithdrawal) + ' USDC')}`);
        console.log('');
        console.log(chalk.bold('Seller Account:'));
        console.log(`  Stake:               ${chalk.green(formatUsdc(sellerAccount.stake) + ' USDC')}`);
        console.log(`  Earnings:            ${chalk.green(formatUsdc(sellerAccount.earnings) + ' USDC')}`);
        console.log(`  Token rate:          ${chalk.dim(sellerAccount.tokenRate.toString())}`);

        if (reputationInfo) {
          console.log('');
          console.log(chalk.bold('Reputation (token #' + reputationInfo.tokenId + '):'));
          console.log(`  First signs:         ${chalk.green(String(reputationInfo.firstSignCount))}`);
          console.log(`  Proven signs:        ${chalk.green(String(reputationInfo.qualifiedProvenSignCount))}`);
          console.log(`  Ghost sessions:      ${chalk.red(String(reputationInfo.ghostCount))}`);
        }
      } catch (err) {
        spinner.fail(chalk.red(`Failed to fetch balance: ${(err as Error).message}`));
        process.exit(1);
      }
    });
}
