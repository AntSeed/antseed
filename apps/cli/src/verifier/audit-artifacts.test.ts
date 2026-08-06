import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  appendVerifierEvent,
  modelAuditsDirectory,
  readVerifierStatus,
  writeEpochAuditSummary,
  writeModelAuditSummary,
  writeVerifierStatus,
} from './audit-artifacts.js'
import { emptyAuditCostSummary } from './proxy-evidence.js'

test('verifier artifacts use epoch and model directories', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-artifacts-'))
  try {
    const status = {
      version: 1 as const, kind: 'antseed-verifier-status' as const, state: 'running' as const,
      runId: 'run', epoch: '7', startedAt: '2026-08-06T00:00:00.000Z', completedAt: null,
      epochStartedAt: '2026-08-06T00:00:00.000Z', epochEndsAt: '2026-08-07T00:00:00.000Z',
      currentModel: 'Model A', currentPeerId: null, modelsCompleted: 0, modelsTotal: 1,
      auditsCompleted: 0, failures: 0, cost: emptyAuditCostSummary(), message: 'running',
    }
    await writeVerifierStatus(directory, status)
    assert.deepEqual(await readVerifierStatus(directory), status)
    const modelPath = await writeModelAuditSummary(directory, '7', 'Model A', {
      version: 1, kind: 'antseed-verifier-model-summary', runId: 'run', epoch: '7', model: 'Model A',
      startedAt: status.startedAt, completedAt: status.startedAt, results: [], failures: [], skipped: [],
      cost: emptyAuditCostSummary(),
    })
    assert.match(modelPath, /epochs\/7\/Model_A\/summary\.json$/)
    assert.match(modelAuditsDirectory(directory, '7', 'Model A'), /epochs\/7\/Model_A\/audits$/)
    const epochPath = await writeEpochAuditSummary(directory, '7', {
      version: 1, kind: 'antseed-verifier-epoch-summary', runId: 'run', epoch: '7',
      epochStartedAt: status.epochStartedAt, epochEndsAt: status.epochEndsAt,
      startedAt: status.startedAt, completedAt: status.startedAt, models: [], failureCount: 0,
      cost: emptyAuditCostSummary(),
    })
    assert.match(epochPath, /epochs\/7\/summary\.json$/)
    const eventsPath = await appendVerifierEvent(directory, '7', { type: 'test', at: status.startedAt })
    assert.equal((await readFile(eventsPath, 'utf8')).trim().length > 0, true)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
