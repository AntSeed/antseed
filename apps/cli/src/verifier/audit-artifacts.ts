import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { canonicalJsonStringify } from '@antseed/fingerprints'
import { writeJsonAtomic, writeTextAtomic } from './atomic-files.js'
import { addAuditCostSummaries, type AuditCostSummaryV1 } from './proxy-evidence.js'
import type { VerificationOutcomeReasonV1 } from './outcome-reason.js'
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
  reasonCounts?: Record<string, number>
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
  reasonCounts?: Record<string, number>
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
    reasonCounts?: Record<string, number>
  }>
  failureCount: number
  cost: AuditCostSummaryV1
  reasonCounts?: Record<string, number>
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
  auditId?: string
  evidencePath?: string
  outcomeReason?: VerificationOutcomeReasonV1 | null
}

interface SellerAuditReportFailure {
  peerId: string
  status: 'FAILED'
  reason: string
  outcomeReason?: VerificationOutcomeReasonV1
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

export function epochAuditReportPath(evidenceDir: string, epoch: string, runId?: string): string {
  return runId
    ? join(epochDirectory(evidenceDir, epoch), 'runs', safeServiceSlug(runId), 'report.md')
    : join(epochDirectory(evidenceDir, epoch), 'report.md')
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
  const path = join(modelDirectory(evidenceDir, epoch, model), 'runs', `${safeServiceSlug(summary.runId)}.summary.json`)
  await writeJsonAtomic(path, summary)
  return path
}

export async function writeEpochAuditSummary(
  evidenceDir: string,
  epoch: string,
  summary: EpochAuditSummaryV1,
): Promise<string> {
  const path = join(epochDirectory(evidenceDir, epoch), 'runs', safeServiceSlug(summary.runId), 'summary.json')
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
  options: { latest?: boolean } = {},
): Promise<string> {
  const rendered = await Promise.all(summary.models.map(async (model) => {
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
    const reasonCounts = new Map<string, number>()
    const countReason = (reason?: VerificationOutcomeReasonV1 | null): void => {
      if (!reason) return
      reasonCounts.set(reason.code, (reasonCounts.get(reason.code) ?? 0) + 1)
    }
    const rows = results.map((result) => {
      countReason(result.outcomeReason)
      return [
        sellerLabel(result),
        `${result.parsedProbeCount}/${result.probeCount}`,
        result.parsedProbeCount === 0 ? '—' : String(result.correctProbeCount),
        result.parsedProbeCount === 0 ? '—' : String(result.incorrectProbeCount),
        result.correctRate === null ? 'N/A' : `**${(result.correctRate * 100).toFixed(1)}%**`,
        result.status,
        reportReason(result.outcomeReason),
        result.outcomeReason?.nextAction ?? '—',
        reportEvidence(result.auditId, result.evidencePath),
      ]
    })
    for (const failure of modelSummary.failures ?? []) {
      countReason(failure.outcomeReason)
      rows.push([
        sellerLabel(failure), '—', '—', '—', 'N/A', 'FAILED',
        reportReason(failure.outcomeReason, failure.reason),
        failure.outcomeReason?.nextAction ?? 'inspect verifier evidence',
        '—',
      ])
    }
    const skippedResults = [...(modelSummary.skipped ?? [])]
      .sort((left, right) => sellerLabel(left).localeCompare(sellerLabel(right)))
    for (const skipped of skippedResults) {
      countReason(skipped.outcomeReason)
      rows.push([
        sellerLabel(skipped), '—', '—', '—', 'N/A', 'SKIPPED',
        reportReason(skipped.outcomeReason, skipped.reason),
        skipped.outcomeReason?.nextAction ?? 'inspect verifier evidence',
        reportEvidence(skipped.auditId ?? undefined, skipped.evidencePath ?? undefined),
      ])
    }
    const reasonBreakdown = [...reasonCounts.entries()].sort(([left], [right]) => left.localeCompare(right))
    return { reasonCounts, text: [
      `## ${escapeMarkdownCell(model.model)}`,
      '',
      '| Seller | Coverage | Correct | Incorrect | Correct Rate | Verdict | Reason | Next Action | Evidence |',
      '|---|---:|---:|---:|---:|---|---|---|---|',
      ...rows.map((row) => `| ${row.map(escapeMarkdownCell).join(' | ')} |`),
      ...(reasonBreakdown.length > 0 ? [
        '',
        `Reason breakdown: ${reasonBreakdown.map(([code, count]) => `\`${code}\`: ${count}`).join(', ')}`,
      ] : []),
    ].join('\n') }
  }))
  const overallReasons = new Map<string, number>()
  for (const section of rendered) {
    for (const [code, count] of section.reasonCounts) {
      overallReasons.set(code, (overallReasons.get(code) ?? 0) + count)
    }
  }
  const overallBreakdown = [...overallReasons.entries()].sort(([left], [right]) => left.localeCompare(right))
  const text = [
    '# AntSeed Verifier Audit Report',
    '',
    `- Run ID: \`${summary.runId}\``,
    `- Epoch: \`${summary.epoch}\``,
    ...(options.latest ? ['- View: consolidated latest epoch snapshot'] : []),
    `- Started: ${summary.startedAt}`,
    `- Completed: ${summary.completedAt}`,
    `- ${options.latest ? 'Cumulative estimated cost' : 'Estimated cost'}: $${summary.cost.estimatedCostUsd.toFixed(6)}`,
    ...(overallBreakdown.length > 0 ? [
      '',
      '## Outcome Reason Summary',
      '',
      ...overallBreakdown.map(([code, count]) => `- \`${code}\`: ${count}`),
    ] : []),
    '',
    ...rendered.flatMap((section) => [section.text, '']),
  ].join('\n').trimEnd()
  const path = epochAuditReportPath(evidenceDir, epoch, options.latest ? undefined : summary.runId)
  await writeTextAtomic(path, `${text}\n`)
  return path
}

export async function writeLatestEpochAuditSnapshot(
  evidenceDir: string,
  epoch: string,
  current: EpochAuditSummaryV1,
  options: { mergeExisting: boolean },
): Promise<{ summaryPath: string; reportPath: string; summary: EpochAuditSummaryV1 }> {
  const existingPath = join(epochDirectory(evidenceDir, epoch), 'summary.json')
  const existing = options.mergeExisting
    ? await readJsonIfExists<EpochAuditSummaryV1>(existingPath)
    : null
  const modelSummaries = new Map<string, ModelAuditSummaryV1>()
  if (existing?.version === 1 && existing.kind === 'antseed-verifier-epoch-summary') {
    for (const model of existing.models) {
      const summary = await readJsonIfExists<ModelAuditSummaryV1>(model.summaryPath)
      if (summary?.version === 1 && summary.kind === 'antseed-verifier-model-summary') {
        modelSummaries.set(normalizedModel(summary.model), summary)
      }
    }
  }
  for (const model of current.models) {
    const update = JSON.parse(await readFile(model.summaryPath, 'utf8')) as ModelAuditSummaryV1
    const key = normalizedModel(update.model)
    const previous = modelSummaries.get(key)
    modelSummaries.set(key, previous ? mergeModelAuditSummaries(previous, update, current.runId) : update)
  }

  const models: EpochAuditSummaryV1['models'] = []
  for (const modelSummary of [...modelSummaries.values()].sort((left, right) => left.model.localeCompare(right.model))) {
    const summaryPath = join(modelDirectory(evidenceDir, epoch, modelSummary.model), 'summary.json')
    await writeJsonAtomic(summaryPath, modelSummary)
    models.push({
      model: modelSummary.model,
      summaryPath,
      resultCount: modelSummary.results.length,
      failureCount: modelSummary.failures.length,
      skippedCount: modelSummary.skipped.length,
      cost: modelSummary.cost,
      reasonCounts: modelSummary.reasonCounts,
    })
  }
  const reasonCounts = mergeReasonCounts(...models.map((model) => model.reasonCounts ?? {}))
  const summary = {
    ...current,
    startedAt: existing?.startedAt ?? current.startedAt,
    reportPath: epochAuditReportPath(evidenceDir, epoch),
    models,
    failureCount: models.reduce((total, model) => total + model.failureCount, 0),
    cost: addAuditCostSummaries(...models.map((model) => model.cost)),
    reasonCounts,
  }
  await writeJsonAtomic(existingPath, summary)
  const reportPath = await writeEpochAuditReport(evidenceDir, epoch, summary, { latest: true })
  return { summaryPath: existingPath, reportPath, summary }
}

function mergeModelAuditSummaries(
  previous: ModelAuditSummaryV1,
  update: ModelAuditSummaryV1,
  runId: string,
): ModelAuditSummaryV1 {
  const outcomes = new Map<string, {
    type: 'result' | 'failure' | 'skip'
    value: ModelVerificationTargetResult | ModelVerificationFailure | ModelVerificationSkip
  }>()
  const add = (
    type: 'result' | 'failure' | 'skip',
    values: Array<ModelVerificationTargetResult | ModelVerificationFailure | ModelVerificationSkip>,
  ): void => {
    for (const value of values) outcomes.set(normalizedPeer(value.peerId), { type, value })
  }
  add('result', previous.results)
  add('failure', previous.failures)
  add('skip', previous.skipped)
  add('result', update.results)
  add('failure', update.failures)
  add('skip', update.skipped)
  const results: ModelVerificationTargetResult[] = []
  const failures: ModelVerificationFailure[] = []
  const skipped: ModelVerificationSkip[] = []
  for (const outcome of outcomes.values()) {
    if (outcome.type === 'result') results.push(outcome.value as ModelVerificationTargetResult)
    else if (outcome.type === 'failure') failures.push(outcome.value as ModelVerificationFailure)
    else skipped.push(outcome.value as ModelVerificationSkip)
  }
  const byPeer = <T extends { peerId: string }>(left: T, right: T): number => left.peerId.localeCompare(right.peerId)
  results.sort(byPeer)
  failures.sort(byPeer)
  skipped.sort(byPeer)
  return {
    ...update,
    runId,
    startedAt: previous.startedAt,
    results,
    failures,
    skipped,
    cost: addAuditCostSummaries(previous.cost, update.cost),
    reasonCounts: countModelOutcomeReasons(results, failures, skipped),
  }
}

function countModelOutcomeReasons(
  results: ModelVerificationTargetResult[],
  failures: ModelVerificationFailure[],
  skipped: ModelVerificationSkip[],
): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const entry of [...results, ...failures, ...skipped]) {
    const code = entry.outcomeReason?.code
    if (code) counts[code] = (counts[code] ?? 0) + 1
  }
  return counts
}

function mergeReasonCounts(...groups: Record<string, number>[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const group of groups) {
    for (const [code, count] of Object.entries(group)) counts[code] = (counts[code] ?? 0) + count
  }
  return counts
}

async function readJsonIfExists<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function normalizedModel(value: string): string {
  return value.trim().toLowerCase()
}

function normalizedPeer(value: string): string {
  return value.trim().toLowerCase()
}

function reportReason(reason?: VerificationOutcomeReasonV1 | null, fallback = '—'): string {
  if (!reason) return fallback
  const progress = reason.totalBatchCount > 0
    ? ` (${reason.affectedBatchCount}/${reason.totalBatchCount} batches)`
    : ''
  return `${reason.code}: ${reason.summary}${progress}${reason.retryable ? '; resumable' : ''}`
}

function reportEvidence(auditId?: string, evidencePath?: string): string {
  if (!auditId && !evidencePath) return '—'
  const audit = auditId ? `audit ${auditId.slice(0, 14)}…` : ''
  return evidencePath ? `${audit}${audit ? '; ' : ''}${evidencePath}` : audit
}

function sellerLabel(value: { peerId: string; displayName?: string | null }): string {
  const peer = `${value.peerId.slice(0, 12)}…`
  return value.displayName ? `${value.displayName} (${peer})` : peer
}

function escapeMarkdownCell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\n', ' ')
}
