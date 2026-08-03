import assert from 'node:assert/strict'
import test from 'node:test'
import { createQueuedAuditPlan } from './audit-queue.js'

test('manual audit queue entries contain no generated, committed, or assigned artifacts', () => {
  const plan = createQueuedAuditPlan({
    source: 'manual',
    durationMs: 3_600_000,
    targetPeerId: `0x${'11'.repeat(20)}`,
    targetService: '  GPT-Test  ',
    jobTimeoutMs: 30_000,
    now: 1_800_000_000_000,
  })

  assert.equal(plan.state, 'queued')
  assert.equal(plan.targetPeerId, '11'.repeat(20))
  assert.equal(plan.targetService, 'GPT-Test')
  assert.equal(plan.durationMs, 3_600_000)
  assert.equal(plan.referenceId, null)
  assert.equal(plan.probeRoot, null)
  assert.equal(plan.auditJobRoot, null)
  assert.equal(plan.commitTxHash, null)
  assert.equal(plan.payoutPerJobUsdc, null)
  assert.equal(plan.executeAfter, null)
  assert.equal(plan.executeBefore, null)
})
