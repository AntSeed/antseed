import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { DelegateVoucherPayload } from '@antseed/node'

/** A received voucher plus where it came from, as persisted on disk. */
export interface StoredDelegateVoucher extends DelegateVoucherPayload {
  /** Peer id of the verifier that issued the voucher. */
  verifierPeerId: string
  /** ISO timestamp of receipt. */
  receivedAt: string
}

/**
 * Append-only JSONL store for received DelegateVouchers. A voucher is the
 * only proof of claimable delegate credits — the buyer's operator reads this
 * file (or the `antseed delegate vouchers` listing) and claims each voucher
 * on-chain via AntseedVerifierRegistry.claimDelegateCredits.
 *
 * Appends are dedup'd by signature: a re-delivered voucher (e.g. a verifier
 * retry) lands once. Claims are NOT tracked here — the contract's
 * voucherClaimed(digest) is the source of truth.
 */
export class VoucherStore {
  private readonly _path: string
  private _signatures: Set<string> | null = null

  constructor(path: string) {
    this._path = path
  }

  /** Persist a voucher. Returns false when it was already stored. */
  async add(voucher: DelegateVoucherPayload, verifierPeerId: string): Promise<boolean> {
    const signatures = await this._loadSignatures()
    const key = voucher.signature.toLowerCase()
    if (signatures.has(key)) return false
    signatures.add(key)
    const stored: StoredDelegateVoucher = {
      ...voucher,
      verifierPeerId,
      receivedAt: new Date().toISOString(),
    }
    await mkdir(dirname(this._path), { recursive: true })
    await appendFile(this._path, `${JSON.stringify(stored)}\n`, 'utf8')
    return true
  }

  async list(): Promise<StoredDelegateVoucher[]> {
    const lines = await this._readLines()
    const vouchers: StoredDelegateVoucher[] = []
    for (const line of lines) {
      try {
        vouchers.push(JSON.parse(line) as StoredDelegateVoucher)
      } catch {
        // A torn write on the final line must not brick the whole store.
      }
    }
    return vouchers
  }

  private async _loadSignatures(): Promise<Set<string>> {
    if (this._signatures) return this._signatures
    const vouchers = await this.list()
    this._signatures = new Set(vouchers.map((v) => v.signature.toLowerCase()))
    return this._signatures
  }

  private async _readLines(): Promise<string[]> {
    let raw: string
    try {
      raw = await readFile(this._path, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }
    return raw.split('\n').filter((line) => line.trim().length > 0)
  }
}
