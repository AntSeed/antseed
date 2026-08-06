import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  appendVerifierEvent,
  epochAuditReportPath,
  modelAuditsDirectory,
  readVerifierRunManifest,
  readVerifierStatus,
  writeEpochAuditReport,
  writeEpochAuditSummary,
  writeModelAuditSummary,
  writeVerifierStatus,
  writeVerifierRunManifest,
} from './audit-artifacts.js'
import { emptyAuditCostSummary } from './proxy-evidence.js'

test('verifier artifacts use epoch and model directories', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-artifacts-'))
  try {
    const status = {
      version: 1 as const, kind: 'antseed-verifier-status' as const, state: 'running' as const,
      runId: 'run', epoch: '7', startedAt: '2026-08-06T00:00:00.000Z', completedAt: null,
      epochStartedAt: '2026-08-06T00:00:00.000Z', epochEndsAt: '2026-08-07T00:00:00.000Z',
      currentModel: 'Model A', currentPeerId: null, activeAudits: [], queuedAudits: 1,
      modelsCompleted: 0, modelsTotal: 1,
      auditsCompleted: 0, failures: 0, cost: emptyAuditCostSummary(), message: 'running',
    }
    await writeVerifierStatus(directory, status)
    assert.deepEqual(await readVerifierStatus(directory), status)
    const modelPath = await writeModelAuditSummary(directory, '7', 'Model A', {
      version: 1, kind: 'antseed-verifier-model-summary', runId: 'run', epoch: '7', model: 'Model A',
      startedAt: status.startedAt, completedAt: status.startedAt, results: [{
        peerId: '11'.repeat(20), displayName: 'Seller A', status: 'SAME', parsedProbeCount: 10,
        probeCount: 10, correctProbeCount: 9, incorrectProbeCount: 1, correctRate: 0.9,
        agentId: '1', service: 'Model A', auditId: `0x${'12'.repeat(32)}`, requestCount: 1,
        cost: emptyAuditCostSummary(), evidencePath: '/tmp/audit.json', evidenceHash: `0x${'34'.repeat(32)}`,
      }], failures: [], skipped: [],
      cost: emptyAuditCostSummary(),
    })
    assert.match(modelPath, /epochs\/7\/Model_A\/summary\.json$/)
    assert.match(modelAuditsDirectory(directory, '7', 'Model A'), /epochs\/7\/Model_A\/audits$/)
    const epochSummary = {
      version: 1 as const, kind: 'antseed-verifier-epoch-summary' as const, runId: 'run', epoch: '7',
      epochStartedAt: status.epochStartedAt, epochEndsAt: status.epochEndsAt,
      startedAt: status.startedAt, completedAt: status.startedAt,
      reportPath: epochAuditReportPath(directory, '7'),
      models: [{
        model: 'Model A', summaryPath: modelPath, resultCount: 1, failureCount: 0, skippedCount: 0,
        cost: emptyAuditCostSummary(),
      }], failureCount: 0,
      cost: emptyAuditCostSummary(),
    }
    const epochPath = await writeEpochAuditSummary(directory, '7', epochSummary)
    assert.match(epochPath, /epochs\/7\/summary\.json$/)
    const reportPath = await writeEpochAuditReport(directory, '7', epochSummary)
    const report = await readFile(reportPath, 'utf8')
    assert.match(report, /\| Seller A \(111111111111…\) \| 10\/10 \| 9 \| 1 \| \*\*90\.0%\*\* \| SAME \|/)
    await writeVerifierRunManifest(directory, {
      version: 1,
      kind: 'antseed-verifier-run-manifest',
      runId: 'run',
      state: 'completed',
      epoch: '7',
      epochSource: 'onchain',
      epochStartedAt: status.epochStartedAt,
      epochEndsAt: status.epochEndsAt,
      startedAt: status.startedAt,
      completedAt: status.startedAt,
      summaryPath: epochPath,
      modelOrder: ['Model A'],
      models: epochSummary.models,
      failureCount: 0,
    })
    assert.equal((await readVerifierRunManifest(directory, 'run')).models[0]!.summaryPath, modelPath)
    const eventsPath = await appendVerifierEvent(directory, '7', { type: 'test', at: status.startedAt })
    assert.equal((await readFile(eventsPath, 'utf8')).trim().length > 0, true)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
