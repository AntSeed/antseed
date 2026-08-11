import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { canonicalJsonStringify } from '@antseed/fingerprints'
import { readJsonIfExists, writeJsonAtomic, writeTextAtomic } from './atomic-files.js'
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
  displayName?: string | null
  status: 'FAILED'
  reason: string
  outcomeReason?: VerificationOutcomeReasonV1
}

type SellerAuditReportSkip = ModelVerificationSkip

interface SellerAuditReportRow {
  seller: string
  coverage: string
  correct: string
  incorrect: string
  correctRate: string
  verdict: string
  reason: string
  nextAction: string
  auditId?: string
  evidencePath?: string
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

export function epochAuditReportPath(evidenceDir: string, epoch: string, runId?: string): string {
  return runId
    ? join(epochDirectory(evidenceDir, epoch), 'runs', safeServiceSlug(runId), 'report.html')
    : join(epochDirectory(evidenceDir, epoch), 'report.html')
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
  return readJsonIfExists(verifierStatusPath(evidenceDir))
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
    const rows: SellerAuditReportRow[] = results.map((result) => {
      countReason(result.outcomeReason)
      return {
        seller: sellerLabel(result),
        coverage: `${result.parsedProbeCount}/${result.probeCount}`,
        correct: result.parsedProbeCount === 0 ? '—' : String(result.correctProbeCount),
        incorrect: result.parsedProbeCount === 0 ? '—' : String(result.incorrectProbeCount),
        correctRate: result.correctRate === null ? 'N/A' : `${(result.correctRate * 100).toFixed(1)}%`,
        verdict: result.status,
        reason: reportReason(result.outcomeReason),
        nextAction: result.outcomeReason?.nextAction ?? '—',
        auditId: result.auditId,
        evidencePath: result.evidencePath,
      }
    })
    for (const failure of modelSummary.failures ?? []) {
      countReason(failure.outcomeReason)
      rows.push({
        seller: sellerLabel(failure), coverage: '—', correct: '—', incorrect: '—', correctRate: 'N/A',
        verdict: 'FAILED', reason: reportReason(failure.outcomeReason, failure.reason),
        nextAction: failure.outcomeReason?.nextAction ?? 'inspect verifier evidence',
      })
    }
    const skippedResults = [...(modelSummary.skipped ?? [])]
      .sort((left, right) => sellerLabel(left).localeCompare(sellerLabel(right)))
    for (const skipped of skippedResults) {
      countReason(skipped.outcomeReason)
      rows.push({
        seller: sellerLabel(skipped), coverage: '—', correct: '—', incorrect: '—', correctRate: 'N/A',
        verdict: 'SKIPPED', reason: reportReason(skipped.outcomeReason, skipped.reason),
        nextAction: skipped.outcomeReason?.nextAction ?? 'inspect verifier evidence',
        auditId: skipped.auditId ?? undefined,
        evidencePath: skipped.evidencePath ?? undefined,
      })
    }
    const reasonBreakdown = [...reasonCounts.entries()].sort(([left], [right]) => left.localeCompare(right))
    return { reasonCounts, html: renderModelReportSection(model.model, rows, reasonBreakdown) }
  }))
  const overallReasons = new Map<string, number>()
  for (const section of rendered) {
    for (const [code, count] of section.reasonCounts) {
      overallReasons.set(code, (overallReasons.get(code) ?? 0) + count)
    }
  }
  const overallBreakdown = [...overallReasons.entries()].sort(([left], [right]) => left.localeCompare(right))
  const text = renderEpochAuditReportHtml(summary, options.latest === true, overallBreakdown, rendered.map((entry) => entry.html))
  const path = epochAuditReportPath(evidenceDir, epoch, options.latest ? undefined : summary.runId)
  await writeTextAtomic(path, text)
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

function renderEpochAuditReportHtml(
  summary: EpochAuditSummaryV1,
  latest: boolean,
  reasonBreakdown: Array<[string, number]>,
  modelSections: string[],
): string {
  const title = `AntSeed Verifier Audit Report — ${summary.epoch}`
  const view = latest ? 'consolidated latest epoch snapshot' : 'immutable run report'
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light dark; --bg: #f4f6f8; --panel: #fff; --text: #17202a; --muted: #5d6d7e; --line: #d5dbe1; --accent: #315efb; --same: #16794a; --diff: #b42318; --undetermined: #9a6700; --skipped: #59636e; --failed: #8e1b1b; }
    @media (prefers-color-scheme: dark) { :root { --bg: #11151a; --panel: #1a2027; --text: #edf2f7; --muted: #aeb8c4; --line: #36404b; --accent: #8aa4ff; --same: #56d597; --diff: #ff8c82; --undetermined: #f2c14e; --skipped: #b8c0ca; --failed: #ff7b72; } }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    main { width: min(1600px, calc(100% - 32px)); margin: 32px auto 64px; }
    header, section { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; box-shadow: 0 2px 8px rgb(0 0 0 / 6%); }
    header { padding: 24px; margin-bottom: 20px; }
    h1, h2 { margin: 0; line-height: 1.2; }
    h1 { font-size: clamp(24px, 4vw, 38px); }
    h2 { font-size: 22px; }
    .subtitle { color: var(--muted); margin: 6px 0 20px; }
    .metadata { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; margin: 0; }
    .metadata div { border-left: 3px solid var(--accent); padding-left: 10px; min-width: 0; }
    dt { color: var(--muted); font-size: 12px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; }
    dd { margin: 2px 0 0; overflow-wrap: anywhere; }
    section { padding: 20px; margin-top: 20px; }
    .reasons { color: var(--muted); margin: 10px 0 0; padding-left: 20px; }
    .table-wrap { overflow-x: auto; margin-top: 16px; }
    table { border-collapse: collapse; width: 100%; min-width: 1120px; }
    th, td { border-bottom: 1px solid var(--line); padding: 10px 12px; text-align: left; vertical-align: top; }
    th { color: var(--muted); font-size: 12px; letter-spacing: .03em; text-transform: uppercase; white-space: nowrap; }
    tbody tr:last-child td { border-bottom: 0; }
    td.numeric { font-variant-numeric: tabular-nums; white-space: nowrap; }
    .badge { border: 1px solid currentColor; border-radius: 999px; display: inline-block; font-size: 12px; font-weight: 800; letter-spacing: .03em; padding: 2px 8px; }
    .same { color: var(--same); } .diff { color: var(--diff); } .undetermined { color: var(--undetermined); } .skipped { color: var(--skipped); } .failed { color: var(--failed); }
    a { color: var(--accent); overflow-wrap: anywhere; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .92em; }
    .empty { color: var(--muted); font-style: italic; }
  </style>
</head>
<body>
<main>
  <header>
    <h1>AntSeed Verifier Audit Report</h1>
    <p class="subtitle">Epoch ${escapeHtml(summary.epoch)}</p>
    <dl class="metadata">
      ${renderMetadata('Run ID', summary.runId)}
      ${renderMetadata('View', view)}
      ${renderMetadata('Epoch window', `${summary.epochStartedAt} – ${summary.epochEndsAt}`)}
      ${renderMetadata('Started', summary.startedAt)}
      ${renderMetadata('Completed', summary.completedAt)}
      ${renderMetadata(latest ? 'Cumulative estimated cost' : 'Estimated cost', `$${summary.cost.estimatedCostUsd.toFixed(6)}`)}
    </dl>
    ${renderReasonBreakdown('Overall reason breakdown', reasonBreakdown)}
  </header>
  ${modelSections.join('\n  ')}
</main>
</body>
</html>
`
}

function renderModelReportSection(
  model: string,
  rows: SellerAuditReportRow[],
  reasonBreakdown: Array<[string, number]>,
): string {
  const body = rows.length === 0
    ? '<tr><td class="empty" colspan="9">No advertised sellers were audited for this model.</td></tr>'
    : rows.map((row) => `<tr>
          <td>${escapeHtml(row.seller)}</td>
          <td class="numeric">${escapeHtml(row.coverage)}</td>
          <td class="numeric">${escapeHtml(row.correct)}</td>
          <td class="numeric">${escapeHtml(row.incorrect)}</td>
          <td class="numeric">${escapeHtml(row.correctRate)}</td>
          <td>${renderVerdict(row.verdict)}</td>
          <td>${escapeHtml(row.reason)}</td>
          <td>${escapeHtml(row.nextAction)}</td>
          <td>${renderEvidence(row.auditId, row.evidencePath)}</td>
        </tr>`).join('\n        ')
  return `<section>
    <h2>${escapeHtml(model)}</h2>
    ${renderReasonBreakdown('Model reason breakdown', reasonBreakdown)}
    <div class="table-wrap">
      <table>
        <thead><tr><th>Seller</th><th>Coverage</th><th>Correct</th><th>Incorrect</th><th>Correct Rate</th><th>Verdict</th><th>Reason</th><th>Next Action</th><th>Evidence</th></tr></thead>
        <tbody>
        ${body}
        </tbody>
      </table>
    </div>
  </section>`
}

function renderMetadata(label: string, value: string): string {
  return `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`
}

function renderReasonBreakdown(title: string, reasons: Array<[string, number]>): string {
  if (reasons.length === 0) return ''
  const items = reasons
    .map(([code, count]) => `<li><code>${escapeHtml(code)}</code>: ${count}</li>`)
    .join('')
  return `<div><strong>${escapeHtml(title)}</strong><ul class="reasons">${items}</ul></div>`
}

function renderVerdict(verdict: string): string {
  const normalized = verdict.toLowerCase()
  const className = ['same', 'diff', 'undetermined', 'skipped', 'failed'].includes(normalized)
    ? normalized
    : 'skipped'
  return `<span class="badge ${className}">${escapeHtml(verdict)}</span>`
}

function renderEvidence(auditId?: string, evidencePath?: string): string {
  if (!auditId && !evidencePath) return '—'
  const audit = auditId ? `audit ${auditId.slice(0, 14)}…` : 'evidence'
  if (!evidencePath) return escapeHtml(audit)
  const href = pathToFileURL(evidencePath).href
  return `<a href="${escapeHtml(href)}" title="${escapeHtml(evidencePath)}">${escapeHtml(audit)}</a>`
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function sellerLabel(value: { peerId: string; displayName?: string | null }): string {
  const peer = `${value.peerId.slice(0, 12)}…`
  return value.displayName ? `${value.displayName} (${peer})` : peer
}
