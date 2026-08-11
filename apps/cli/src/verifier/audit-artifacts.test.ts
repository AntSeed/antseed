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
  writeLatestEpochAuditSnapshot,
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
      auditsCompleted: 0, skipped: 1, failures: 0, cost: emptyAuditCostSummary(), message: 'running',
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
      }], failures: [], skipped: [{
        peerId: '22'.repeat(20), displayName: 'Skipped Seller', agentId: '2', service: 'Model A',
        status: 'SKIPPED', code: 'price_above_maximum', reason: 'price exceeds buyer maximum',
        outcomeReason: {
          code: 'price_above_maximum', summary: 'price exceeds buyer maximum', retryable: false,
          source: 'policy', affectedBatchCount: 0, totalBatchCount: 0,
          nextAction: 'adjust buyer routing policy',
        },
        source: 'runtime', auditId: `0x${'56'.repeat(32)}`, evidencePath: '/tmp/skip.json',
        evidenceHash: `0x${'78'.repeat(32)}`,
      }],
      cost: emptyAuditCostSummary(),
    })
    assert.match(modelPath, /epochs\/7\/Model_A\/runs\/run\.summary\.json$/)
    assert.match(modelAuditsDirectory(directory, '7', 'Model A'), /epochs\/7\/Model_A\/audits$/)
    const epochSummary = {
      version: 1 as const, kind: 'antseed-verifier-epoch-summary' as const, runId: 'run', epoch: '7',
      epochStartedAt: status.epochStartedAt, epochEndsAt: status.epochEndsAt,
      startedAt: status.startedAt, completedAt: status.startedAt,
      reportPath: epochAuditReportPath(directory, '7', 'run'),
      models: [{
        model: 'Model A', summaryPath: modelPath, resultCount: 1, failureCount: 0, skippedCount: 1,
        cost: emptyAuditCostSummary(),
      }], failureCount: 0,
      cost: emptyAuditCostSummary(),
    }
    const epochPath = await writeEpochAuditSummary(directory, '7', epochSummary)
    assert.match(epochPath, /epochs\/7\/runs\/run\/summary\.json$/)
    const reportPath = await writeEpochAuditReport(directory, '7', epochSummary)
    const report = await readFile(reportPath, 'utf8')
    assert.match(report, /\| Seller A \(111111111111…\) \| 10\/10 \| 9 \| 1 \| \*\*90\.0%\*\* \| SAME \| — \| — \|/)
    assert.match(report, /\| Skipped Seller \(222222222222…\) \| — \| — \| — \| N\/A \| SKIPPED \| price_above_maximum: price exceeds buyer maximum \| adjust buyer routing policy \|/)
    assert.match(report, /`price_above_maximum`: 1/)
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

test('latest epoch report merges repair outcomes without changing immutable run reports', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-latest-report-'))
  const epoch = '9'
  const baseCost = { ...emptyAuditCostSummary(), estimatedCostUsd: 1, pricedExchangeCount: 1 }
  const repairCost = { ...emptyAuditCostSummary(), estimatedCostUsd: 0.25, pricedExchangeCount: 1 }
  const result = (
    peerId: string,
    status: 'SAME' | 'UNDETERMINED',
    auditId: string,
    cost = emptyAuditCostSummary(),
  ) => ({
    peerId,
    displayName: peerId === 'peer-a' ? 'Seller A' : 'Seller B',
    agentId: null,
    service: 'model-a',
    status,
    outcomeReason: status === 'UNDETERMINED' ? {
      code: 'deadline_exceeded' as const,
      summary: 'one batch exceeded the seller deadline',
      retryable: true,
      source: 'transport' as const,
      affectedBatchCount: 1,
      totalBatchCount: 2,
      nextAction: 'resume audit' as const,
    } : null,
    auditId,
    parsedProbeCount: status === 'SAME' ? 20 : 10,
    probeCount: 20,
    correctProbeCount: status === 'SAME' ? 20 : 10,
    incorrectProbeCount: 0,
    correctRate: 1,
    requestCount: 2,
    cost,
    evidencePath: `/tmp/${auditId}.json`,
    evidenceHash: `0x${auditId.padEnd(64, '0').slice(0, 64)}`,
  })
  try {
    const baseModelPath = await writeModelAuditSummary(directory, epoch, 'model-a', {
      version: 1,
      kind: 'antseed-verifier-model-summary',
      runId: 'base-run',
      epoch,
      model: 'model-a',
      startedAt: '2026-08-10T00:00:00.000Z',
      completedAt: '2026-08-10T00:10:00.000Z',
      results: [result('peer-a', 'SAME', 'base-a'), result('peer-b', 'UNDETERMINED', 'base-b', baseCost)],
      failures: [],
      skipped: [],
      cost: baseCost,
      reasonCounts: { deadline_exceeded: 1 },
    })
    const baseSummary = {
      version: 1 as const,
      kind: 'antseed-verifier-epoch-summary' as const,
      runId: 'base-run',
      epoch,
      epochStartedAt: '2026-08-10T00:00:00.000Z',
      epochEndsAt: '2026-08-11T00:00:00.000Z',
      startedAt: '2026-08-10T00:00:00.000Z',
      completedAt: '2026-08-10T00:10:00.000Z',
      reportPath: epochAuditReportPath(directory, epoch, 'base-run'),
      models: [{
        model: 'model-a', summaryPath: baseModelPath, resultCount: 2, failureCount: 0,
        skippedCount: 0, cost: baseCost, reasonCounts: { deadline_exceeded: 1 },
      }],
      failureCount: 0,
      cost: baseCost,
      reasonCounts: { deadline_exceeded: 1 },
    }
    const baseRunReport = await writeEpochAuditReport(directory, epoch, baseSummary)
    await writeLatestEpochAuditSnapshot(directory, epoch, baseSummary, { mergeExisting: false })

    const repairModelPath = await writeModelAuditSummary(directory, epoch, 'model-a', {
      version: 1,
      kind: 'antseed-verifier-model-summary',
      runId: 'repair-run',
      epoch,
      model: 'model-a',
      startedAt: '2026-08-10T01:00:00.000Z',
      completedAt: '2026-08-10T01:05:00.000Z',
      results: [result('peer-b', 'SAME', 'repair-b', repairCost)],
      failures: [],
      skipped: [],
      cost: repairCost,
      reasonCounts: {},
    })
    const repairSummary = {
      ...baseSummary,
      runId: 'repair-run',
      startedAt: '2026-08-10T01:00:00.000Z',
      completedAt: '2026-08-10T01:05:00.000Z',
      reportPath: epochAuditReportPath(directory, epoch, 'repair-run'),
      models: [{
        model: 'model-a', summaryPath: repairModelPath, resultCount: 1, failureCount: 0,
        skippedCount: 0, cost: repairCost, reasonCounts: {},
      }],
      cost: repairCost,
      reasonCounts: {},
    }
    const repairRunReport = await writeEpochAuditReport(directory, epoch, repairSummary)
    const latest = await writeLatestEpochAuditSnapshot(directory, epoch, repairSummary, { mergeExisting: true })
    const latestReport = await readFile(latest.reportPath, 'utf8')
    assert.match(latestReport, /View: consolidated latest epoch snapshot/)
    assert.match(latestReport, /Seller A/)
    assert.match(latestReport, /Seller B/)
    assert.doesNotMatch(latestReport, /deadline_exceeded/)
    assert.match(latestReport, /Cumulative estimated cost: \$1\.250000/)
    assert.match(await readFile(baseRunReport, 'utf8'), /deadline_exceeded/)
    assert.doesNotMatch(await readFile(repairRunReport, 'utf8'), /Seller A/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
