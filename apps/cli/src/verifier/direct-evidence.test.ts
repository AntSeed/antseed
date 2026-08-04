import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createReferenceQueryProfile } from '@antseed/fingerprints'
import {
  deriveDirectAuditId,
  directAuditEvidenceHash,
  verifyDirectAuditEvidenceFile,
  writeDirectAuditEvidence,
  type DirectAuditEvidenceV1,
} from './direct-evidence.js'

function evidence(): DirectAuditEvidenceV1 {
  return {
    version: 1,
    kind: 'antseed-direct-kbf-audit',
    createdAt: '2026-08-03T12:00:00.000Z',
    verifier: { peerId: '11'.repeat(20), address: `0x${'11'.repeat(20)}` },
    target: {
      peerId: '22'.repeat(20),
      agentId: '7',
      sellerAddress: `0x${'22'.repeat(20)}`,
      service: 'gpt-test',
      serviceHash: `0x${'33'.repeat(32)}`,
    },
    reference: {
      referenceId: 'reference-1',
      referenceModel: 'gpt-test',
      queryProfileHash: `0x${'44'.repeat(32)}`,
      queryProfile: createReferenceQueryProfile({ upstreamModel: 'gpt-test' }),
      statisticalPower: 0.99,
      statisticalPowerEvidence: { power: 0.99 },
      selfTest: { hamming: 0, total: 1, coverage: 1, errorRate: 0 },
      probes: [{
        id: 'probe-1', name: 'probe', domain: 'test', template: 'Value is ___.',
        consensus: 1, range: [0, 2], tolerance: { mode: 'absolute', value: 0 },
      }],
    },
    exchanges: [],
    result: {
      selectedProbeCount: 1,
      authenticatedProbeCount: 1,
      parsedProbeCount: 1,
      matchVector: [1],
      matchVectorHash: `0x${'55'.repeat(32)}`,
      stats: {
        selfHamming: 0,
        selfTotal: 1,
        targetHamming: 0,
        targetTotal: 1,
        selfCoverage: 1,
        targetCoverage: 1,
        p0Cp99: 0.1,
        pValueBinomial: 1,
      },
      verdict: 'SAME',
      verdictReason: null,
    },
  }
}

test('canonical evidence round-trips and deterministically derives its audit id', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'antseed-direct-evidence-'))
  try {
    const value = evidence()
    const hash = directAuditEvidenceHash(value)
    const auditId = deriveDirectAuditId({
      verifierAddress: value.verifier.address,
      targetPeerId: value.target.peerId,
      agentId: value.target.agentId,
      serviceHash: value.target.serviceHash,
      completedAt: Date.parse(value.createdAt),
      evidenceHash: hash,
    })
    const written = await writeDirectAuditEvidence(dir, auditId, value)
    assert.equal(written.evidenceHash, hash)
    assert.equal(readFileSync(written.path, 'utf8').endsWith('\n'), false)
    assert.deepEqual(await verifyDirectAuditEvidenceFile(written.path, hash), value)
    assert.equal(deriveDirectAuditId({
      verifierAddress: value.verifier.address.toUpperCase(),
      targetPeerId: value.target.peerId.toUpperCase(),
      agentId: value.target.agentId,
      serviceHash: value.target.serviceHash.toUpperCase(),
      completedAt: Date.parse(value.createdAt),
      evidenceHash: hash.toUpperCase(),
    }), auditId)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('evidence verification rejects non-canonical or mutated files', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'antseed-direct-evidence-'))
  try {
    const value = evidence()
    const hash = directAuditEvidenceHash(value)
    const written = await writeDirectAuditEvidence(dir, 'audit', value)
    writeFileSync(written.path, `${readFileSync(written.path, 'utf8')}\n`)
    await assert.rejects(verifyDirectAuditEvidenceFile(written.path, hash), /not canonical/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
