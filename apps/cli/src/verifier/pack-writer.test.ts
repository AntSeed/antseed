import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { EvidenceBundle } from '@antseed/fingerprints'
import {
  computeEvidenceHash,
  computeProbeCommitment,
  generateProbeSet,
  probeBankSource,
} from '@antseed/fingerprints'
import { auditPackPath, canonicalProbeSetJson, writeAuditPack } from './pack-writer.js'

const COMMITMENT = '0x' + 'AB'.repeat(32)

function sha256Bytes32(text: string): string {
  return '0x' + createHash('sha256').update(text, 'utf8').digest('hex')
}

function probeSet() {
  return generateProbeSet({ service: 'kimi-k2', count: 3, seed: 'cd'.repeat(32), source: probeBankSource() })
}

function bundle(): EvidenceBundle {
  return {
    version: 1,
    service: 'kimi-k2',
    verifierAddress: '0x' + '11'.repeat(20),
    probeSet: probeSet(),
    sellers: [],
    cohortOptions: {
      alpha: 0.05,
      minConsensusProbes: 10,
      minCoverage: 0.5,
      epsilon: 0.02,
      minConsensusSellers: 3,
    },
    maxProbesPerRequest: 3,
    createdAt: '2026-07-14T00:00:00.000Z',
  }
}

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'antseed-pack-writer-'))
  try {
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('canonicalProbeSetJson bytes hash to exactly computeProbeCommitment', () => {
  const set = probeSet()
  assert.equal(sha256Bytes32(canonicalProbeSetJson(set)), computeProbeCommitment(set))
})

test('auditPackPath names the pack by lowercased commitment and refuses non-bytes32 values', () => {
  assert.equal(auditPackPath('/packs', COMMITMENT), join('/packs', `${COMMITMENT.toLowerCase()}.json`))
  assert.throws(() => auditPackPath('/packs', '../evil'), /bytes32/)
  assert.throws(() => auditPackPath('/packs', '0x1234'), /bytes32/)
  assert.throws(() => auditPackPath('/packs', 'ab'.repeat(32)), /bytes32/, 'must be 0x-prefixed')
})

test('writeAuditPack is deterministic: identical content regardless of key insertion order, sha256(file) == evidenceHash', async () => {
  await withTempDir(async (dir) => {
    const packA = bundle()
    // Same content, different property insertion order.
    const packB = {
      createdAt: packA.createdAt,
      maxProbesPerRequest: packA.maxProbesPerRequest,
      cohortOptions: packA.cohortOptions,
      sellers: packA.sellers,
      probeSet: packA.probeSet,
      verifierAddress: packA.verifierAddress,
      service: packA.service,
      version: packA.version,
    } as EvidenceBundle

    const pathA = await writeAuditPack(join(dir, 'a'), COMMITMENT, packA)
    const pathB = await writeAuditPack(join(dir, 'b'), COMMITMENT, packB)
    const bytesA = await readFile(pathA, 'utf8')
    const bytesB = await readFile(pathB, 'utf8')

    assert.equal(bytesA, bytesB, 'canonical serialization must be order-independent')
    assert.equal(sha256Bytes32(bytesA), computeEvidenceHash(packA), 'the file bytes ARE the evidenceHash preimage')

    // Round-trip: the persisted pack re-hashes to the same evidenceHash.
    const reloaded = JSON.parse(bytesA) as EvidenceBundle
    assert.equal(computeEvidenceHash(reloaded), computeEvidenceHash(packA))
  })
})

test('writeAuditPack creates the publish directory on demand and overwrites idempotently', async () => {
  await withTempDir(async (dir) => {
    const nested = join(dir, 'deeply', 'nested', 'packs')
    const first = await writeAuditPack(nested, COMMITMENT, bundle())
    const second = await writeAuditPack(nested, COMMITMENT, bundle())
    assert.equal(first, second)
    assert.equal(await readFile(first, 'utf8'), await readFile(second, 'utf8'))
    // Atomic tmp+rename write: only the final pack remains, no leftover temp files.
    assert.deepEqual(await readdir(nested), [`${COMMITMENT.toLowerCase()}.json`])
  })
})
