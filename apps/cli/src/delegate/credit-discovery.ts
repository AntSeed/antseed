import type { AbstractProvider } from 'ethers'
import type { DelegateCreditsAccrual } from '@antseed/node'

interface AccrualReader {
  provider: Pick<AbstractProvider, 'getBlockNumber'>
  queryDelegateCreditsAccrued(
    buyer: string,
    fromBlock?: number | 'earliest',
    toBlock?: number | 'latest',
  ): Promise<DelegateCreditsAccrual[]>
}

/**
 * Largest eth_getLogs block range requested in one call. Public RPCs commonly
 * cap ranges around 10k blocks; staying under keeps every chunk servable.
 */
export const ACCRUAL_SCAN_CHUNK_BLOCKS = 9_000

/**
 * First-ever scan lookback (cursor still at genesis). A fresh delegate has no
 * accruals older than itself, so instead of scanning from block 1 — a range
 * most RPCs refuse outright and pointless to walk chunk by chunk — start
 * about a week back (~2s blocks).
 */
export const ACCRUAL_SCAN_INITIAL_LOOKBACK_BLOCKS = 302_400

/**
 * Scan a fixed chain range and advance through quiet blocks. The range is
 * queried in RPC-safe chunks; a chunk failure after partial progress returns
 * the accruals and blocks already covered so the caller's persisted cursor
 * advances and the next scan resumes where this one stopped.
 */
export async function discoverDelegateAccruals(
  reader: AccrualReader,
  buyer: string,
  fromBlock: number,
): Promise<{ accruals: DelegateCreditsAccrual[]; toBlock: number }> {
  const head = await reader.provider.getBlockNumber()
  if (fromBlock > head) return { accruals: [], toBlock: head }
  const start = fromBlock <= 1
    ? Math.max(fromBlock, head - ACCRUAL_SCAN_INITIAL_LOOKBACK_BLOCKS)
    : fromBlock
  const accruals: DelegateCreditsAccrual[] = []
  let scanned = start - 1
  while (scanned < head) {
    const chunkEnd = Math.min(scanned + ACCRUAL_SCAN_CHUNK_BLOCKS, head)
    try {
      accruals.push(...(await reader.queryDelegateCreditsAccrued(buyer, scanned + 1, chunkEnd)))
    } catch (err) {
      if (scanned >= start) return { accruals, toBlock: scanned }
      throw err
    }
    scanned = chunkEnd
  }
  return { accruals, toBlock: head }
}
