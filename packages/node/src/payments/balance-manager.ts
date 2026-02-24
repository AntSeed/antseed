import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { WalletInfo, Transaction, TransactionType } from './types.js';

export interface UnifiedBalance {
  cryptoUSDC: number;
  inEscrowUSDC: number;
  totalUSD: number;
}

export class BalanceManager {
  private transactions: Transaction[] = [];

  getBalance(
    walletInfo: WalletInfo | null,
    inEscrowUSDC: number,
  ): UnifiedBalance {
    const cryptoUSDC = walletInfo ? parseFloat(walletInfo.balanceUSDC) : 0;
    const totalUSD = cryptoUSDC + inEscrowUSDC;

    return {
      cryptoUSDC,
      inEscrowUSDC,
      totalUSD,
    };
  }

  recordTransaction(tx: Transaction): void {
    this.transactions.push(tx);
  }

  getTransactionHistory(
    filter?: TransactionType,
    limit?: number,
    offset?: number,
  ): Transaction[] {
    let result = this.transactions;

    if (filter) {
      result = result.filter((tx) => tx.type === filter);
    }

    const start = offset ?? 0;
    const end = limit !== undefined ? start + limit : undefined;
    return result.slice(start, end);
  }

  getTotalEarnings(since?: number): number {
    return this.transactions
      .filter((tx) => tx.type === 'escrow_release')
      .filter((tx) => (since !== undefined ? tx.timestamp >= since : true))
      .reduce((sum, tx) => sum + tx.amountUSD, 0);
  }

  getTotalSpending(since?: number): number {
    return this.transactions
      .filter((tx) => tx.type === 'escrow_lock')
      .filter((tx) => (since !== undefined ? tx.timestamp >= since : true))
      .reduce((sum, tx) => sum + tx.amountUSD, 0);
  }

  async save(configDir: string): Promise<void> {
    await mkdir(configDir, { recursive: true });
    const filePath = join(configDir, 'transactions.json');
    await writeFile(filePath, JSON.stringify(this.transactions, null, 2), 'utf-8');
  }

  async load(configDir: string): Promise<void> {
    const filePath = join(configDir, 'transactions.json');
    try {
      const data = await readFile(filePath, 'utf-8');
      this.transactions = JSON.parse(data) as Transaction[];
    } catch {
      this.transactions = [];
    }
  }
}
