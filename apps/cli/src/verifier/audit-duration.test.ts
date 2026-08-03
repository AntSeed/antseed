import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertAuditDurationMs,
  DEFAULT_AUDIT_DURATION_MS,
  MAX_AUDIT_DURATION_MS,
  MIN_AUDIT_DURATION_MS,
} from './audit-duration.js'

test('audit duration accepts any integer duration from 24 through 48 hours', () => {
  assert.equal(assertAuditDurationMs(MIN_AUDIT_DURATION_MS), 24 * 60 * 60 * 1_000)
  assert.equal(assertAuditDurationMs(36 * 60 * 60 * 1_000), 36 * 60 * 60 * 1_000)
  assert.equal(assertAuditDurationMs(MAX_AUDIT_DURATION_MS), 48 * 60 * 60 * 1_000)
  assert.equal(DEFAULT_AUDIT_DURATION_MS, MIN_AUDIT_DURATION_MS)
})

test('audit duration rejects values outside 24 through 48 hours', () => {
  assert.throws(() => assertAuditDurationMs(MIN_AUDIT_DURATION_MS - 1), /between 24 and 48 hours/)
  assert.throws(() => assertAuditDurationMs(MAX_AUDIT_DURATION_MS + 1), /between 24 and 48 hours/)
  assert.throws(() => assertAuditDurationMs(Number.NaN), /between 24 and 48 hours/)
})
