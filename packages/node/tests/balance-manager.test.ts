import { describe, it, expect, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { BalanceManager } from '../src/payments/balance-manager.js';
import type { Transaction } from '../src/payments/types.js';
import type { WalletInfo } from '../src/payments/types.js';

function tmpDir(): string {
  return path.join(os.tmpdir(), `antseed-bm-test-${randomBytes(8).toString('hex')}`);
}

const dirsToClean: string[] = [];

afterEach(() => {
  for (const dir of dirsToClean) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
  dirsToClean.length = 0;
});

function makeTx(overrides?: Partial<Transaction>): Transaction {
  return {
    txId: `tx-${Math.random().toString(36).slice(2)}`,
    type: 'escrow_lock',
    amountUSD: 10,
    from: 'buyer',
    to: 'seller',
    timestamp: Date.now(),
    status: 'confirmed',
    ...overrides,
  };
}

describe('BalanceManager.getBalance', () => {
  it('should compute unified balance from crypto + escrow', () => {
    const bm = new BalanceManager();
    const wallet: WalletInfo = { address: '0x1', chainId: 'base-local', balanceETH: '0', balanceUSDC: '50.5' };
    const result = bm.getBalance(wallet, 10);

    expect(result.cryptoUSDC).toBeCloseTo(50.5);
    expect(result.inEscrowUSDC).toBe(10);
    expect(result.totalUSD).toBeCloseTo(60.5);
  });

  it('should handle null wallet', () => {
    const bm = new BalanceManager();
    const result = bm.getBalance(null, 0);
    expect(result.cryptoUSDC).toBe(0);
    expect(result.totalUSD).toBe(0);
  });

  it('should include escrow in total', () => {
    const bm = new BalanceManager();
    const wallet: WalletInfo = { address: '0x1', chainId: 'base-local', balanceETH: '0', balanceUSDC: '100' };
    const result = bm.getBalance(wallet, 5);
    expect(result.totalUSD).toBe(105);
  });

  it('should handle both null wallet and zero escrow', () => {
    const bm = new BalanceManager();
    const result = bm.getBalance(null, 0);
    expect(result.totalUSD).toBe(0);
  });
});

describe('BalanceManager.recordTransaction / getTransactionHistory', () => {
  it('should record and retrieve transactions', () => {
    const bm = new BalanceManager();
    const tx = makeTx();
    bm.recordTransaction(tx);

    const history = bm.getTransactionHistory();
    expect(history).toHaveLength(1);
    expect(history[0]!.txId).toBe(tx.txId);
  });

  it('should filter by type', () => {
    const bm = new BalanceManager();
    bm.recordTransaction(makeTx({ type: 'escrow_lock' }));
    bm.recordTransaction(makeTx({ type: 'escrow_release' }));
    bm.recordTransaction(makeTx({ type: 'escrow_lock' }));

    expect(bm.getTransactionHistory('escrow_lock')).toHaveLength(2);
    expect(bm.getTransactionHistory('escrow_release')).toHaveLength(1);
  });

  it('should support limit and offset', () => {
    const bm = new BalanceManager();
    for (let i = 0; i < 10; i++) {
      bm.recordTransaction(makeTx({ txId: `tx-${i}` }));
    }

    const page = bm.getTransactionHistory(undefined, 3, 2);
    expect(page).toHaveLength(3);
    expect(page[0]!.txId).toBe('tx-2');
  });
});

describe('BalanceManager.getTotalEarnings / getTotalSpending', () => {
  it('should sum escrow_release transactions for earnings', () => {
    const bm = new BalanceManager();
    bm.recordTransaction(makeTx({ type: 'escrow_release', amountUSD: 10 }));
    bm.recordTransaction(makeTx({ type: 'escrow_release', amountUSD: 20 }));
    bm.recordTransaction(makeTx({ type: 'escrow_lock', amountUSD: 100 }));

    expect(bm.getTotalEarnings()).toBe(30);
  });

  it('should sum escrow_lock transactions for spending', () => {
    const bm = new BalanceManager();
    bm.recordTransaction(makeTx({ type: 'escrow_lock', amountUSD: 5 }));
    bm.recordTransaction(makeTx({ type: 'escrow_lock', amountUSD: 15 }));
    bm.recordTransaction(makeTx({ type: 'escrow_release', amountUSD: 100 }));

    expect(bm.getTotalSpending()).toBe(20);
  });

  it('should filter by since timestamp', () => {
    const bm = new BalanceManager();
    const now = Date.now();
    bm.recordTransaction(makeTx({ type: 'escrow_release', amountUSD: 10, timestamp: now - 2000 }));
    bm.recordTransaction(makeTx({ type: 'escrow_release', amountUSD: 20, timestamp: now - 500 }));

    expect(bm.getTotalEarnings(now - 1000)).toBe(20);
    expect(bm.getTotalEarnings()).toBe(30);
  });
});

describe('BalanceManager.save / load', () => {
  it('should persist and restore transactions', async () => {
    const dir = tmpDir();
    dirsToClean.push(dir);

    const bm1 = new BalanceManager();
    bm1.recordTransaction(makeTx({ txId: 'saved-tx', amountUSD: 42 }));
    await bm1.save(dir);

    const bm2 = new BalanceManager();
    await bm2.load(dir);

    const history = bm2.getTransactionHistory();
    expect(history).toHaveLength(1);
    expect(history[0]!.txId).toBe('saved-tx');
    expect(history[0]!.amountUSD).toBe(42);
  });

  it('should start fresh if load file does not exist', async () => {
    const bm = new BalanceManager();
    await bm.load('/nonexistent/path');
    expect(bm.getTransactionHistory()).toEqual([]);
  });
});
