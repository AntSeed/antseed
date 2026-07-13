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

/** Injectable fs surface (tests exercise persistence-failure paths). */
export interface VoucherStoreFs {
  appendFile: typeof appendFile
  mkdir: typeof mkdir
  readFile: typeof readFile
}

/**
 * Append-only JSONL store for received DelegateVouchers. A voucher is the
 * only proof of claimable delegate credits — the buyer's operator lists them
 * with `antseed delegate vouchers` and claims them on-chain with
 * `antseed delegate claim` (AntseedVerifierRegistry.claimDelegateCredits).
 *
 * Appends are dedup'd by signature: a re-delivered voucher (e.g. a verifier
 * retry) lands once. The signature enters the dedupe set only AFTER the
 * append succeeded — a transient persistence failure must not suppress
 * redelivery until restart. Initialization and writes are serialized through
 * a single promise chain so concurrent first deliveries cannot race the
 * signature-set load or interleave appends. Claims are NOT tracked here —
 * the contract's voucherClaimed(verifier, digest) replay guard is the
 * source of truth.
 */
export class VoucherStore {
  private readonly _path: string
  private readonly _fs: VoucherStoreFs
  private _signatures: Set<string> | null = null
  /** Serializes init + appends; failures are swallowed on the chain itself. */
  private _writeQueue: Promise<unknown> = Promise.resolve()

  constructor(path: string, fs?: Partial<VoucherStoreFs>) {
    this._path = path
    this._fs = {
      appendFile: fs?.appendFile ?? appendFile,
      mkdir: fs?.mkdir ?? mkdir,
      readFile: fs?.readFile ?? readFile,
    }
  }

  /** Persist a voucher. Returns false when it was already stored. */
  async add(voucher: DelegateVoucherPayload, verifierPeerId: string): Promise<boolean> {
    const run = this._writeQueue.then(() => this._addSerialized(voucher, verifierPeerId))
    // Keep the chain alive after a failed write; the failure still rejects
    // the caller's promise via `run`.
    this._writeQueue = run.catch(() => {})
    return run
  }

  private async _addSerialized(voucher: DelegateVoucherPayload, verifierPeerId: string): Promise<boolean> {
    const signatures = await this._loadSignatures()
    const key = voucher.signature.toLowerCase()
    if (signatures.has(key)) return false
    const stored: StoredDelegateVoucher = {
      ...voucher,
      verifierPeerId,
      receivedAt: new Date().toISOString(),
    }
    await this._fs.mkdir(dirname(this._path), { recursive: true })
    await this._fs.appendFile(this._path, `${JSON.stringify(stored)}\n`, 'utf8')
    // Only a durably persisted voucher may suppress redelivery.
    signatures.add(key)
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
      raw = await this._fs.readFile(this._path, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }
    return raw.split('\n').filter((line) => line.trim().length > 0)
  }
}
