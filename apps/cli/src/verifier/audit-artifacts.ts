import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { canonicalJsonStringify } from '@antseed/fingerprints'
import { writeJsonAtomic, writeTextAtomic } from './atomic-files.js'
import type { AuditCostSummaryV1 } from './proxy-evidence.js'
import type {
  ModelVerificationFailure,
  ModelVerificationSkip,
  ModelVerificationTargetResult,
} from './model-run.js'
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
  skipped: number
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
  results: ModelVerificationTargetResult[]
  failures: ModelVerificationFailure[]
  skipped: ModelVerificationSkip[]
  cost: AuditCostSummaryV1
}

export interface VerifierRunManifestV1 {
  version: 1
  kind: 'antseed-verifier-run-manifest'
  runId: string
  state: 'completed' | 'completed-with-failures'
  epoch: string
  epochSource: 'onchain' | 'utc-day'
  epochStartedAt: string
  epochEndsAt: string
  startedAt: string
  completedAt: string
  summaryPath: string
  modelOrder: string[]
  models: EpochAuditSummaryV1['models']
  failureCount: number
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
  reportPath: string
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

interface SellerAuditReportResult {
  peerId: string
  displayName: string | null
  status: string
  parsedProbeCount: number
  probeCount: number
  correctProbeCount: number
  incorrectProbeCount: number
  correctRate: number | null
}

interface SellerAuditReportFailure {
  peerId: string
  status: 'FAILED'
  reason: string
}

type SellerAuditReportSkip = ModelVerificationSkip

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

export function epochAuditReportPath(evidenceDir: string, epoch: string): string {
  return join(epochDirectory(evidenceDir, epoch), 'report.md')
}

export function verifierRunManifestPath(evidenceDir: string, runId: string): string {
  return join(evidenceDir, 'runs', `${runId}.json`)
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

export async function writeVerifierRunManifest(
  evidenceDir: string,
  manifest: VerifierRunManifestV1,
): Promise<string> {
  const path = verifierRunManifestPath(evidenceDir, manifest.runId)
  await writeJsonAtomic(path, manifest)
  return path
}

export async function readVerifierRunManifest(
  evidenceDir: string,
  runId: string,
): Promise<VerifierRunManifestV1> {
  const path = verifierRunManifestPath(evidenceDir, runId)
  let parsed: VerifierRunManifestV1
  try {
    parsed = JSON.parse(await readFile(path, 'utf8')) as VerifierRunManifestV1
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`verifier run manifest not found: ${path}`)
    }
    throw error
  }
  if (parsed.version !== 1 || parsed.kind !== 'antseed-verifier-run-manifest' || parsed.runId !== runId) {
    throw new Error(`invalid verifier run manifest: ${path}`)
  }
  return parsed
}

export async function writeEpochAuditReport(
  evidenceDir: string,
  epoch: string,
  summary: EpochAuditSummaryV1,
): Promise<string> {
  const sections = await Promise.all(summary.models.map(async (model) => {
    const modelSummary = JSON.parse(await readFile(model.summaryPath, 'utf8')) as {
      results?: SellerAuditReportResult[]
      failures?: SellerAuditReportFailure[]
      skipped?: SellerAuditReportSkip[]
    }
    const results = [...(modelSummary.results ?? [])].sort((left, right) => {
      if (left.correctRate === null && right.correctRate !== null) return 1
      if (left.correctRate !== null && right.correctRate === null) return -1
      if (left.correctRate !== null && right.correctRate !== null && left.correctRate !== right.correctRate) {
        return right.correctRate - left.correctRate
      }
      return sellerLabel(left).localeCompare(sellerLabel(right))
    })
    const rows = results.map((result) => [
      sellerLabel(result),
      `${result.parsedProbeCount}/${result.probeCount}`,
      result.parsedProbeCount === 0 ? '—' : String(result.correctProbeCount),
      result.parsedProbeCount === 0 ? '—' : String(result.incorrectProbeCount),
      result.correctRate === null ? 'N/A' : `**${(result.correctRate * 100).toFixed(1)}%**`,
      result.status,
    ])
    for (const failure of modelSummary.failures ?? []) {
      rows.push([sellerLabel(failure), '—', '—', '—', 'N/A', `FAILED: ${failure.reason}`])
    }
    const skippedResults = [...(modelSummary.skipped ?? [])]
      .sort((left, right) => sellerLabel(left).localeCompare(sellerLabel(right)))
    for (const skipped of skippedResults) {
      rows.push([sellerLabel(skipped), '—', '—', '—', 'N/A', `SKIPPED: ${skipped.reason}`])
    }
    return [
      `## ${escapeMarkdownCell(model.model)}`,
      '',
      '| Seller | Coverage | Correct | Incorrect | Correct Rate | Verdict |',
      '|---|---:|---:|---:|---:|---|',
      ...rows.map((row) => `| ${row.map(escapeMarkdownCell).join(' | ')} |`),
    ].join('\n')
  }))
  const text = [
    '# AntSeed Verifier Audit Report',
    '',
    `- Run ID: \`${summary.runId}\``,
    `- Epoch: \`${summary.epoch}\``,
    `- Started: ${summary.startedAt}`,
    `- Completed: ${summary.completedAt}`,
    `- Estimated cost: $${summary.cost.estimatedCostUsd.toFixed(6)}`,
    '',
    ...sections.flatMap((section) => [section, '']),
  ].join('\n').trimEnd()
  const path = epochAuditReportPath(evidenceDir, epoch)
  await writeTextAtomic(path, `${text}\n`)
  return path
}

function sellerLabel(value: { peerId: string; displayName?: string | null }): string {
  const peer = `${value.peerId.slice(0, 12)}…`
  return value.displayName ? `${value.displayName} (${peer})` : peer
}

function escapeMarkdownCell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\n', ' ')
}
