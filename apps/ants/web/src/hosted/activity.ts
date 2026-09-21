import { getAddress, type Provider } from 'ethers';
import type { BrowserTransaction } from '../../../src/browser-signer';
import { mergePositionBarrier, parsePositionBarrier } from '../../../src/service/position-barrier';

export interface TransactionRecord extends BrowserTransaction {
  buyer: string | null;
  at: number;
  resolved?: boolean;
}

export class ActivityStore {
  constructor(private readonly storage: Storage | null, private readonly chainId: number) {}
  key(wallet: string, kind: string): string {
    return `ants.hosted.${kind}.v1:${this.chainId}:${wallet.toLowerCase()}`;
  }
  read<T>(wallet: string, kind: string, fallback: T): T {
    if (!this.storage) throw new Error('Browser storage is required for safe transaction recovery.');
    const value = this.storage.getItem(this.key(wallet, kind));
    return value ? JSON.parse(value) as T : fallback;
  }
  write(wallet: string, kind: string, value: unknown): void {
    if (!this.storage) throw new Error('Browser storage is required for safe transaction recovery.');
    this.storage.setItem(this.key(wallet, kind), JSON.stringify(value));
  }
  transactions(wallet: string): TransactionRecord[] {
    const records = this.read<TransactionRecord[]>(wallet, 'transactions', []);
    if (!Array.isArray(records) || records.some(record => !record || record.chainId !== this.chainId || typeof record.from !== 'string' || record.from.toLowerCase() !== wallet.toLowerCase() || typeof record.id !== 'string' || !Number.isFinite(record.at) || !/^0x[0-9a-fA-F]{40}$/.test(record.to) || !/^0x(?:[0-9a-fA-F]{2})*$/.test(record.data) || !/^\d+$/.test(record.value) || (record.submittedHash !== undefined && !/^0x[0-9a-fA-F]{64}$/.test(record.submittedHash)))) throw new Error('Invalid saved transactions. Check your wallet before continuing.');
    return records;
  }
  record(request: BrowserTransaction, buyer: string | null): void {
    const records = this.transactions(request.from);
    const previous = records.find(record => record.id === request.id);
    const next = { ...previous, ...request, buyer, at: previous?.at ?? Date.now() };
    this.write(request.from, 'transactions', [...records.filter(record => record.id !== request.id), next]);
  }
  resolve(wallet: string, id: string): void {
    this.write(wallet, 'transactions', this.transactions(wallet).map(record => record.id === id ? { ...record, resolved: true } : record));
  }
  positionBarrier(wallet: string) {
    const saved = this.read<unknown>(wallet, 'position-checkpoint', null);
    return saved === null ? undefined : parsePositionBarrier(saved);
  }
  confirmPositionRead(wallet: string, block: number) {
    const barrier = mergePositionBarrier(this.positionBarrier(wallet), block);
    this.write(wallet, 'position-checkpoint', barrier);
    return barrier;
  }
  async track(provider: Provider, record: TransactionRecord): Promise<'pending' | 'confirmed' | 'reverted'> {
    if (!record.submittedHash) throw new Error('This approval has no recorded hash. Check the original wallet before clearing it.');
    const receipt = await provider.getTransactionReceipt(record.submittedHash);
    if (!receipt) return 'pending';
    const transaction = await provider.getTransaction(record.submittedHash);
    if (!transaction || transaction.chainId !== BigInt(this.chainId) || getAddress(transaction.from) !== getAddress(record.from) || !transaction.to || getAddress(transaction.to) !== getAddress(record.to) || transaction.data.toLowerCase() !== record.data.toLowerCase() || transaction.value !== BigInt(record.value) || transaction.nonce < (record.nonceFloor ?? 0)) throw new Error('Transaction does not match the saved approval.');
    if (receipt.status === 1) this.confirmPositionRead(record.from, receipt.blockNumber);
    this.resolve(record.from, record.id);
    return receipt.status === 1 ? 'confirmed' : 'reverted';
  }
}

export async function withWalletLock<T>(locks: Pick<LockManager, 'request'> | undefined, chainId: number, wallet: string, work: () => Promise<T>): Promise<T> {
  if (!locks) throw new Error('This browser cannot safely coordinate wallet actions across tabs. Use a browser with Web Locks support over HTTPS.');
  return locks.request(`ants.hosted.write:${chainId}:${wallet.toLowerCase()}`, { ifAvailable: true }, async lock => {
    if (!lock) throw new Error('Another tab is using this wallet. Finish that action before continuing.');
    return work();
  });
}
