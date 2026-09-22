import { getAddress, ZeroAddress } from 'ethers';

export interface SavedBuyer { address: string; label: string; }
export interface BuyerList { buyers: SavedBuyer[]; selected: string | null; }
export type BuyerAuthorization =
  | { status: 'authorized' | 'view-only'; operator: string }
  | { status: 'unlinked'; operator: null }
  | { status: 'error'; operator: null; error: string };

export async function verifyBuyer(buyer: string, wallet: string, getOperator: (address: string) => Promise<string>): Promise<BuyerAuthorization> {
  try {
    const operator = getAddress(await getOperator(buyer));
    if (operator === ZeroAddress) return { status: 'unlinked', operator: null };
    return { status: operator.toLowerCase() === wallet.toLowerCase() ? 'authorized' : 'view-only', operator };
  } catch (error) {
    return { status: 'error', operator: null, error: error instanceof Error ? error.message : String(error) };
  }
}

const EMPTY: BuyerList = { buyers: [], selected: null };
const cleanLabel = (label: unknown) => String(label ?? '').trim().slice(0, 60);

/** Buyer accounts a wallet has saved, per chain; falls back to memory when browser storage is unusable. */
export class BuyerStore {
  private memory = new Map<string, BuyerList>();
  persistent = true;
  constructor(private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null) {
    this.persistent = !!storage;
  }
  private key(chainId: number, wallet: string): string {
    return `ants.hosted.buyers.v1:${chainId}:${wallet.toLowerCase()}`;
  }
  load(chainId: number, wallet: string): BuyerList {
    const key = this.key(chainId, wallet);
    if (!this.storage || !this.persistent) return this.memory.get(key) ?? EMPTY;
    try {
      const raw = this.storage.getItem(key);
      if (!raw) return this.memory.get(key) ?? EMPTY;
      const parsed = JSON.parse(raw) as BuyerList;
      if (!Array.isArray(parsed.buyers)) throw new Error('Invalid saved buyer accounts.');
      const buyers: SavedBuyer[] = [];
      for (const buyer of parsed.buyers) {
        const address = this.address(buyer.address);
        if (!buyers.some(entry => entry.address === address)) buyers.push({ address, label: String(buyer.label ?? '').slice(0, 60) });
      }
      const list = { buyers, selected: buyers.find(buyer => buyer.address === parsed.selected)?.address ?? null };
      this.memory.set(key, list);
      return list;
    } catch {
      this.persistent = false;
      return this.memory.get(key) ?? EMPTY;
    }
  }
  save(chainId: number, wallet: string, list: BuyerList): void {
    const key = this.key(chainId, wallet);
    this.memory.set(key, list);
    try { this.storage?.setItem(key, JSON.stringify(list)); }
    catch { this.persistent = false; }
  }
  address(value: string): string {
    const address = getAddress(value.trim());
    if (address === ZeroAddress) throw new Error('Enter a nonzero buyer address.');
    return address;
  }
  add(chainId: number, wallet: string, value: string, label: string): BuyerList {
    const address = this.address(value);
    const list = this.load(chainId, wallet);
    if (list.buyers.some(buyer => buyer.address === address)) throw new Error('This buyer is already saved. Select it from the list.');
    const next = { buyers: [...list.buyers, { address, label: cleanLabel(label) }], selected: address };
    this.save(chainId, wallet, next);
    return next;
  }
  select(chainId: number, wallet: string, address: string | null): BuyerList {
    const list = this.load(chainId, wallet);
    if (address && !list.buyers.some(buyer => buyer.address === address)) throw new Error('Unknown buyer account.');
    const next = { ...list, selected: address };
    this.save(chainId, wallet, next);
    return next;
  }
  rename(chainId: number, wallet: string, address: string, label: string): BuyerList {
    const list = this.load(chainId, wallet);
    const next = { ...list, buyers: list.buyers.map(buyer => buyer.address === address ? { ...buyer, label: cleanLabel(label) } : buyer) };
    this.save(chainId, wallet, next);
    return next;
  }
  remove(chainId: number, wallet: string, address: string): BuyerList {
    const list = this.load(chainId, wallet);
    const next = { buyers: list.buyers.filter(buyer => buyer.address !== address), selected: list.selected === address ? null : list.selected };
    this.save(chainId, wallet, next);
    return next;
  }
}
