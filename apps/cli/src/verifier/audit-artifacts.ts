import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { canonicalJsonStringify } from '@antseed/fingerprints'
import { writeJsonAtomic } from './atomic-files.js'
import type { AuditCostSummaryV1 } from './proxy-evidence.js'
import { safeServiceSlug } from './slug.js'

export interface VerifierStatusV1 {
  version: 1
  kind: 'antseed-verifier-status'
  state: 'running' | 'completed' | 'failed'
  runId: string
  epoch: string
  startedAt: string
  completedAt: string | null
  epochStartedAt: string
  epochEndsAt: string
  currentModel: string | null
  currentPeerId: string | null
  activeAudits: Array<{ model: string; peerId: string; startedAt: string }>
  queuedAudits: number
  modelsCompleted: number
  modelsTotal: number
  auditsCompleted: number
  failures: number
  cost: AuditCostSummaryV1
  message: string
}

export interface ModelAuditSummaryV1 {
  version: 1
  kind: 'antseed-verifier-model-summary'
  runId: string
  epoch: string
  model: string
  startedAt: string
  completedAt: string
  results: unknown[]
  failures: unknown[]
  skipped: unknown[]
  cost: AuditCostSummaryV1
}

export interface EpochAuditSummaryV1 {
  version: 1
  kind: 'antseed-verifier-epoch-summary'
  runId: string
  epoch: string
  epochStartedAt: string
  epochEndsAt: string
  startedAt: string
  completedAt: string
  models: Array<{
    model: string
    summaryPath: string
    resultCount: number
    failureCount: number
    skippedCount: number
    cost: AuditCostSummaryV1
  }>
  failureCount: number
  cost: AuditCostSummaryV1
}

export function verifierStatusPath(evidenceDir: string): string {
  return join(evidenceDir, 'status.json')
}

export function epochDirectory(evidenceDir: string, epoch: string): string {
  return join(evidenceDir, 'epochs', epoch)
}

export function modelDirectory(evidenceDir: string, epoch: string, model: string): string {
  return join(epochDirectory(evidenceDir, epoch), safeServiceSlug(model))
}

export function modelAuditsDirectory(evidenceDir: string, epoch: string, model: string): string {
  return join(modelDirectory(evidenceDir, epoch, model), 'audits')
}

export async function writeVerifierStatus(evidenceDir: string, status: VerifierStatusV1): Promise<string> {
  const path = verifierStatusPath(evidenceDir)
  await writeJsonAtomic(path, status)
  return path
}

export async function readVerifierStatus(evidenceDir: string): Promise<VerifierStatusV1 | null> {
  try {
    return JSON.parse(await readFile(verifierStatusPath(evidenceDir), 'utf8')) as VerifierStatusV1
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

export async function appendVerifierEvent(
  evidenceDir: string,
  epoch: string,
  event: Record<string, unknown>,
): Promise<string> {
  const path = join(epochDirectory(evidenceDir, epoch), 'events.jsonl')
  await mkdir(dirname(path), { recursive: true })
  await appendFile(path, `${canonicalJsonStringify(event)}\n`)
  return path
}

export async function writeModelAuditSummary(
  evidenceDir: string,
  epoch: string,
  model: string,
  summary: ModelAuditSummaryV1,
): Promise<string> {
  const path = join(modelDirectory(evidenceDir, epoch, model), 'summary.json')
  await writeJsonAtomic(path, summary)
  return path
}

export async function writeEpochAuditSummary(
  evidenceDir: string,
  epoch: string,
  summary: EpochAuditSummaryV1,
): Promise<string> {
  const path = join(epochDirectory(evidenceDir, epoch), 'summary.json')
  await writeJsonAtomic(path, summary)
  return path
}
