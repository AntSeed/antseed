import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { DelegateCreditsAccrual } from '@antseed/node'

/**
 * A discovered delegate-credit accrual as persisted on disk. The
 * (verifier, probeCommitment, buyer, agentId, serviceHash) tuple is the
 * claim's entire input; the authoritative accrued/claimed amounts are read
 * from the contract at claim time, so `credits`/`blockNumber` here are only
 * for display and cursor math.
 */
export interface StoredCreditAccrual {
  verifier: string
  probeCommitment: string
  buyer: string
  /** Audited target's ERC-8004 agent id the carried probes were for. */
  agentId: number
  /** Audited target's normalized service hash. */
  serviceHash: string
  /** Credits from the last `DelegateCreditsAccrued` event seen for this key. */
  credits: number
  /** Block of the last event seen for this key. */
  blockNumber: number
  /** ISO timestamp the accrual was first discovered. */
  firstSeenAt: string
}

interface CreditStoreFile {
  version: 1
  /** Highest block scanned for `DelegateCreditsAccrued` logs (exclusive lower bound for the next scan is this + 1). */
  cursorBlock: number
  accruals: StoredCreditAccrual[]
}

/** Injectable fs surface (tests exercise persistence-failure paths). */
export interface CreditStoreFs {
  readFile: typeof readFile
  writeFile: typeof writeFile
  mkdir: typeof mkdir
}

function accrualKey(a: Pick<StoredCreditAccrual, 'verifier' | 'probeCommitment' | 'buyer' | 'agentId' | 'serviceHash'>): string {
  return `${a.verifier.toLowerCase()}|${a.probeCommitment.toLowerCase()}|${a.buyer.toLowerCase()}|${a.agentId}|${a.serviceHash.toLowerCase()}`
}

/**
 * Durable store for delegate-credit accruals discovered on-chain. Replaces the
 * former off-chain DelegateVoucher store: a carrier's credits now accrue when
 * the verifier anchors the seller-signed exchanges naming that buyer
 * (AntseedVerifierRegistry.anchorExchangeBatch), and the carrier discovers
 * them from `DelegateCreditsAccrued` logs. The buyer's deposits operator lists
 * them with `antseed delegate credits` and claims them on-chain with
 * `antseed delegate claim` (AntseedVerifierRegistry.claimDelegateCredits).
 *
 * The file also holds a block cursor so log scans are incremental across
 * restarts. Distinct (verifier, probeCommitment, buyer) triples are deduped —
 * a later accrual on an existing triple refreshes its credits/block. Reads +
 * writes are serialized through one promise chain so concurrent scans cannot
 * interleave a read-modify-write.
 */
export class CreditStore {
  private readonly _path: string
  private readonly _fs: CreditStoreFs
  private _cache: CreditStoreFile | null = null
  private _writeQueue: Promise<unknown> = Promise.resolve()

  constructor(path: string, fs?: Partial<CreditStoreFs>) {
    this._path = path
    this._fs = {
      readFile: fs?.readFile ?? readFile,
      writeFile: fs?.writeFile ?? writeFile,
      mkdir: fs?.mkdir ?? mkdir,
    }
  }

  /** Highest block already scanned (0 when nothing has been scanned yet). */
  async getCursor(): Promise<number> {
    return (await this._load()).cursorBlock
  }

  /** All discovered accruals, newest block first. */
  async list(): Promise<StoredCreditAccrual[]> {
    const file = await this._load()
    return [...file.accruals].sort((a, b) => b.blockNumber - a.blockNumber)
  }

  /**
   * Merge a scan's results and advance the cursor. New triples are appended;
   * repeats refresh credits/block. Returns the count of newly discovered
   * triples. Serialized so concurrent scans cannot clobber each other.
   */
  async recordScan(accruals: readonly DelegateCreditsAccrual[], toBlock: number): Promise<number> {
    const run = this._writeQueue.then(() => this._recordScanSerialized(accruals, toBlock))
    this._writeQueue = run.catch(() => {})
    return run
  }

  private async _recordScanSerialized(
    accruals: readonly DelegateCreditsAccrual[],
    toBlock: number,
  ): Promise<number> {
    const file = await this._load()
    const byKey = new Map(file.accruals.map((a) => [accrualKey(a), a]))
    const now = new Date().toISOString()
    let added = 0
    for (const accrual of accruals) {
      const key = accrualKey(accrual)
      const existing = byKey.get(key)
      if (existing) {
        existing.credits = accrual.credits
        existing.blockNumber = Math.max(existing.blockNumber, accrual.blockNumber)
      } else {
        byKey.set(key, {
          verifier: accrual.verifier,
          probeCommitment: accrual.probeCommitment,
          buyer: accrual.buyer,
          agentId: accrual.agentId,
          serviceHash: accrual.serviceHash,
          credits: accrual.credits,
          blockNumber: accrual.blockNumber,
          firstSeenAt: now,
        })
        added += 1
      }
    }
    const next: CreditStoreFile = {
      version: 1,
      cursorBlock: Math.max(file.cursorBlock, toBlock),
      accruals: [...byKey.values()],
    }
    await this._fs.mkdir(dirname(this._path), { recursive: true })
    await this._fs.writeFile(this._path, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    // Only a durable write updates the cache.
    this._cache = next
    return added
  }

  private async _load(): Promise<CreditStoreFile> {
    if (this._cache) return this._cache
    let raw: string
    try {
      raw = await this._fs.readFile(this._path, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this._cache = { version: 1, cursorBlock: 0, accruals: [] }
        return this._cache
      }
      throw err
    }
    try {
      const parsed = JSON.parse(raw) as Partial<CreditStoreFile>
      this._cache = {
        version: 1,
        cursorBlock: typeof parsed.cursorBlock === 'number' ? parsed.cursorBlock : 0,
        // Entries persisted before target-keyed claims (no agentId /
        // serviceHash) are unclaimable under the current contract — drop
        // them rather than carry unusable rows.
        accruals: Array.isArray(parsed.accruals)
          ? parsed.accruals.filter((a): a is StoredCreditAccrual =>
              typeof a?.verifier === 'string'
              && typeof a?.probeCommitment === 'string'
              && typeof a?.buyer === 'string'
              && typeof a?.agentId === 'number'
              && typeof a?.serviceHash === 'string')
          : [],
      }
    } catch {
      // A torn write must not brick the store — start clean rather than throw.
      this._cache = { version: 1, cursorBlock: 0, accruals: [] }
    }
    return this._cache
  }
}
