import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeJsonAtomic } from './atomic-files.js'

export type ModelSubmissionStatus = 'pending' | 'submitted' | 'failed' | 'skipped'

export interface ModelSubmissionLedgerEntryV1 {
  model: string
  bundleId: string
  serviceHashes: string[]
  evidenceHash: string
  evidencePath: string
  resultCount: number
  inferenceCostUsdMicros: string
  referenceCostUsdMicros: string
  totalAuditCostUsdMicros: string
  awardedCreditUsdMicros: string | null
  status: ModelSubmissionStatus
  transactionHash: string | null
  blockNumber: number | null
  error: string | null
  lastAttemptAt: string
  referenceCostIds: string[]
}

export interface SubmissionLedgerV1 {
  version: 1
  kind: 'antseed-verifier-submission-ledger'
  runId: string
  chainId: string
  contractAddress: string
  expectedEpoch: string
  createdAt: string
  updatedAt: string
  models: Record<string, ModelSubmissionLedgerEntryV1>
}

export function submissionLedgerPath(
  evidenceDir: string,
  chainId: bigint | string,
  contractAddress: string,
  runId: string,
): string {
  return join(
    evidenceDir,
    'submissions',
    String(chainId),
    contractAddress.toLowerCase(),
    `${runId}.json`,
  )
}

export async function readSubmissionLedger(path: string): Promise<SubmissionLedgerV1 | null> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as SubmissionLedgerV1
    if (parsed.version !== 1 || parsed.kind !== 'antseed-verifier-submission-ledger') {
      throw new Error(`unsupported submission ledger: ${path}`)
    }
    return parsed
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

export async function writeSubmissionLedger(path: string, ledger: SubmissionLedgerV1): Promise<void> {
  ledger.updatedAt = new Date().toISOString()
  await writeJsonAtomic(path, ledger)
}
