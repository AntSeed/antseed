import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  computeBinomialPower,
  computeReferenceId,
  createReferenceQueryProfile,
  type KbfReferenceV1,
} from '@antseed/fingerprints'
import {
  appendModelReferenceToBank,
  BANK_EXHAUSTED,
  reserveModelAuditReference,
  sellerLedgerPath,
} from './probe-bank.js'

function reference(count = 200): KbfReferenceV1 {
  const probes = Array.from({ length: count }, (_, index) => ({
    id: `probe-${index + 1}`,
    name: `probe ${index + 1}`,
    domain: 'test',
    template: `The test value ${index + 1} is ___.`,
    consensus: index + 1,
    range: [0, count + 1] as [number, number],
    tolerance: { mode: 'absolute' as const, value: 0 },
  }))
  const power = computeBinomialPower({
    selfHamming: 0, selfTotal: count, minimumMismatchDelta: 0.1, alpha: 0.05, cpConfidence: 0.99,
  })
  const value: KbfReferenceV1 = {
    version: 1,
    kind: 'kbf',
    referenceId: '',
    referenceModel: 'model-a',
    serviceAliases: ['model-a'],
    createdAt: '2026-08-06T00:00:00.000Z',
    source: 'generated',
    generator: { name: 'test', version: '1', verifierKind: 'kbf', params: {} },
    provenance: { sourceId: 'trusted', trust: 'trusted' },
    queryProfile: createReferenceQueryProfile({ upstreamModel: 'upstream-a' }),
    selfTest: {
      hamming: 0,
      total: count,
      coverage: 1,
      errorRate: 0,
      outcomes: probes.map((probe) => ({ probeId: probe.id, answer: probe.consensus, match: 1 })),
    },
    probes,
    selectedProbeCount: count,
    minimumMismatchDelta: 0.1,
    statisticalPower: power.power,
    statisticalPowerEvidence: {
      test: 'one-sided-binomial', alpha: 0.05, clopperPearsonConfidence: 0.99,
      selfHamming: 0, selfTotal: count, p0UpperBound: power.p0,
      alternativeMismatchRate: power.p1, criticalMismatchCount: power.criticalMismatchCount,
      power: power.power,
    },
    contrasts: [{ model: 'contrast-a', distinguishingProbeIds: probes.map((probe) => probe.id) }],
  }
  value.referenceId = computeReferenceId(value)
  return value
}

test('probe banks append, deduplicate, and reject conflicting probe IDs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-probe-bank-'))
  try {
    const first = await appendModelReferenceToBank({ banksDir: directory, model: 'model-a', reference: reference() })
    assert.equal(first.addedProbeCount, 200)
    const second = await appendModelReferenceToBank({ banksDir: directory, model: 'model-a', reference: reference() })
    assert.equal(second.addedProbeCount, 0)
    assert.equal(second.totalProbeCount, 200)

    const conflicting = reference()
    conflicting.probes[0]!.template = 'Conflicting value is ___.'
    conflicting.referenceId = computeReferenceId(conflicting)
    await assert.rejects(
      appendModelReferenceToBank({ banksDir: directory, model: 'model-a', reference: conflicting }),
      /conflicts with existing canonical content/,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('probe banks reject incompatible query profiles', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-probe-bank-'))
  try {
    await appendModelReferenceToBank({ banksDir: directory, model: 'model-a', reference: reference() })
    const incompatible = reference()
    incompatible.queryProfile = createReferenceQueryProfile({ upstreamModel: 'different-upstream' })
    incompatible.referenceId = computeReferenceId(incompatible)
    await assert.rejects(
      appendModelReferenceToBank({ banksDir: directory, model: 'model-a', reference: incompatible }),
      /incompatible/,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('seller ledgers prevent reuse while allowing cross-seller reuse', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-probe-bank-'))
  const identityShuffle = <T>(values: readonly T[]) => [...values]
  try {
    await appendModelReferenceToBank({ banksDir: directory, model: 'model-a', reference: reference() })
    const first = await reserveModelAuditReference({
      banksDir: directory, model: 'model-a', sellerPeerId: '11'.repeat(20),
      service: 'model-a', epoch: '4', shuffle: identityShuffle,
    })
    const second = await reserveModelAuditReference({
      banksDir: directory, model: 'model-a', sellerPeerId: '11'.repeat(20),
      service: 'model-a', epoch: '4', shuffle: identityShuffle,
    })
    assert.equal(first.reference.probes.length, 100)
    assert.equal(second.reference.probes.length, 100)
    assert.equal(first.reference.probes.some((probe) => second.reference.probes.some((other) => other.id === probe.id)), false)
    await assert.rejects(
      reserveModelAuditReference({
        banksDir: directory, model: 'model-a', sellerPeerId: '11'.repeat(20),
        service: 'model-a', epoch: '4', shuffle: identityShuffle,
      }),
      new RegExp(BANK_EXHAUSTED),
    )

    const otherSeller = await reserveModelAuditReference({
      banksDir: directory, model: 'model-a', sellerPeerId: '22'.repeat(20),
      service: 'model-a', epoch: '4', shuffle: identityShuffle,
    })
    assert.deepEqual(
      otherSeller.reference.probes.map((probe) => probe.id),
      first.reference.probes.map((probe) => probe.id),
    )
    const ledger = JSON.parse(await readFile(sellerLedgerPath(directory, 'model-a', '11'.repeat(20)), 'utf8'))
    assert.equal(ledger.usedProbeIds.length, 200)
    assert.equal(ledger.assignments.length, 2)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
