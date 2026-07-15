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

/** Scan a fixed chain range and advance through quiet blocks. */
export async function discoverDelegateAccruals(
  reader: AccrualReader,
  buyer: string,
  fromBlock: number,
): Promise<{ accruals: DelegateCreditsAccrual[]; toBlock: number }> {
  const toBlock = await reader.provider.getBlockNumber()
  if (fromBlock > toBlock) return { accruals: [], toBlock }
  const accruals = await reader.queryDelegateCreditsAccrued(buyer, fromBlock, toBlock)
  return { accruals, toBlock }
}
