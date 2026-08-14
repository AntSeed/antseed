import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  appendVerifierEvent,
  modelAuditsDirectory,
  modelAuditReportPath,
  modelAuditSellersDirectory,
  modelReferenceDirectory,
  readVerifierRunManifest,
  readVerifierStatus,
  writeEpochAuditSummary,
  writeModelAuditReports,
  writeModelAuditSummary,
  writeVerifierRunManifest,
  writeVerifierStatus,
} from './audit-artifacts.js'
import { emptyAuditCostSummary } from './proxy-evidence.js'

test('verifier artifacts use model-first epoch directories', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-artifacts-'))
  try {
    const status = {
      version: 1 as const, kind: 'antseed-verifier-status' as const, state: 'running' as const,
      runId: 'run', epoch: '7', startedAt: '2026-08-06T00:00:00.000Z', completedAt: null,
      epochStartedAt: '2026-08-06T00:00:00.000Z', epochEndsAt: '2026-08-07T00:00:00.000Z',
      currentModel: 'Model A', currentPeerId: null, activeAudits: [], queuedAudits: 1,
      modelsCompleted: 0, modelsTotal: 1, auditsCompleted: 0, skipped: 1, failures: 0,
      cost: emptyAuditCostSummary(), message: 'running',
    }
    await writeVerifierStatus(directory, status)
    assert.deepEqual(await readVerifierStatus(directory), status)

    const auditPackDirectory = join(directory, 'audit-pack')
    await mkdir(join(auditPackDirectory, 'exchanges'), { recursive: true })
    await writeFile(join(auditPackDirectory, 'manifest.json'), JSON.stringify({
      files: [
        { path: 'evidence.json', purpose: 'Canonical complete audit evidence' },
        { path: 'exchanges/000.json', purpose: 'Signed exchange batch 0' },
      ],
    }))
    const consensusPath = join(modelAuditsDirectory(directory, '7', 'Model A', 'run'), 'probe-consensus.json')
    const referencePath = join(modelReferenceDirectory(directory, '7', 'Model A', 'reference:1'), 'probe-integrity.json')
    const modelPath = await writeModelAuditSummary(directory, '7', 'Model A', {
      version: 1, kind: 'antseed-verifier-model-summary', runId: 'run', epoch: '7', model: 'Model A',
      startedAt: status.startedAt, completedAt: status.startedAt, results: [{
        peerId: '11'.repeat(20), displayName: 'Seller A', status: 'SAME', parsedProbeCount: 10,
        probeCount: 10, correctProbeCount: 9, incorrectProbeCount: 1, correctRate: 0.9,
        agentId: '1', service: 'Model A', auditId: `0x${'12'.repeat(32)}`, requestCount: 1,
        cost: emptyAuditCostSummary(), evidencePath: join(auditPackDirectory, 'evidence.json'),
        evidenceHash: `0x${'34'.repeat(32)}`,
      }], failures: [], skipped: [], cost: emptyAuditCostSummary(),
      consensusEvidencePath: consensusPath,
      referenceIntegrityPath: referencePath,
    })
    assert.match(modelPath, /epochs\/7\/Model_A\/audits\/run\/summary\.json$/)
    assert.match(
      modelAuditSellersDirectory(directory, '7', 'Model A', 'run'),
      /epochs\/7\/Model_A\/audits\/run\/sellers$/,
    )
    assert.match(referencePath, /epochs\/7\/Model_A\/references\/reference_1\/probe-integrity\.json$/)

    const epochSummary = {
      version: 1 as const, kind: 'antseed-verifier-epoch-summary' as const, runId: 'run', epoch: '7',
      epochStartedAt: status.epochStartedAt, epochEndsAt: status.epochEndsAt,
      startedAt: status.startedAt, completedAt: status.startedAt,
      reportPaths: [{ model: 'Model A', path: modelAuditReportPath(directory, '7', 'Model A') }],
      models: [{
        model: 'Model A', summaryPath: modelPath, resultCount: 1, failureCount: 0, skippedCount: 0,
        reportPath: modelAuditReportPath(directory, '7', 'Model A'),
        cost: emptyAuditCostSummary(),
      }], failureCount: 0, cost: emptyAuditCostSummary(),
    }
    const epochPath = await writeEpochAuditSummary(directory, '7', epochSummary)
    assert.match(epochPath, /runs\/run\.summary\.json$/)
    await writeVerifierRunManifest(directory, {
      version: 1, kind: 'antseed-verifier-run-manifest', runId: 'run', state: 'completed', epoch: '7',
      epochSource: 'onchain', epochStartedAt: status.epochStartedAt, epochEndsAt: status.epochEndsAt,
      startedAt: status.startedAt, completedAt: status.startedAt, summaryPath: epochPath,
      modelOrder: ['Model A'], models: epochSummary.models, failureCount: 0,
    })
    const reports = await writeModelAuditReports(directory, '7', epochSummary)
    const reportPath = reports[0]!.path
    const report = await readFile(reportPath, 'utf8')
    assert.match(reportPath, /epochs\/7\/Model_A\/report\.html$/)
    assert.match(report, /^<!doctype html>/)
    assert.match(report, /Seller A \(111111111111…\)/)
    assert.match(report, /Open audit folder/)
    assert.match(report, /Probe consensus JSON/)
    assert.match(report, /Reference probe integrity/)
    assert.match(report, /Open folder/)
    assert.match(report, /Evidence JSON/)
    assert.match(report, /All evidence files \(4\)/)
    assert.match(report, /exchanges\/000\.json/)
    assert.doesNotMatch(report, /index\.html/)
    assert.equal((await readVerifierRunManifest(directory, 'run')).models[0]!.summaryPath, modelPath)
    const eventsPath = await appendVerifierEvent(directory, '7', { type: 'test', at: status.startedAt })
    assert.equal((await readFile(eventsPath, 'utf8')).trim().length > 0, true)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
