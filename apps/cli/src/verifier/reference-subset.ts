import {
  computeBinomialPower,
  sha256Hex,
  subsetReferenceSelfTest,
  type KbfReferenceV1,
} from '@antseed/fingerprints'
import type { VerificationStorage } from '@antseed/node'

export function selectAndReserveReferenceSubset(input: {
  storage: VerificationStorage
  auditId: string
  agentId: string
  service: string
  reference: KbfReferenceV1
  probeCount: number
  /** @deprecated Probes are permanently single-use per agent/service. */
  maxUses?: number
}): KbfReferenceV1 {
  assertProbeCount(input.probeCount)
  const exposures = input.storage.getProbeExposureCounts(input.agentId, input.service)
  const reserved = new Set(input.storage.listActiveReservedProbeIds(
    input.agentId,
    input.service,
    input.auditId,
  ))
  const eligible = input.reference.probes
    .filter((probe) => !exposures.has(probe.id) && !reserved.has(probe.id))
    .sort((left, right) => {
      return sha256Hex(`${input.auditId}:${left.id}`).localeCompare(sha256Hex(`${input.auditId}:${right.id}`))
    })
  if (eligible.length < input.probeCount) {
    throw new Error(
      `reference ${input.reference.referenceId} has only ${eligible.length} eligible probes for `
      + `${input.agentId}/${input.service}; rebuild required`,
    )
  }
  const selectedIds = eligible.slice(0, input.probeCount).map((probe) => probe.id)
  input.storage.reserveAuditProbes(input.auditId, selectedIds)
  return subsetReference(input.reference, selectedIds)
}

export function loadReservedReferenceSubset(
  storage: VerificationStorage,
  auditId: string,
  reference: KbfReferenceV1,
): KbfReferenceV1 {
  const selections = storage.listAuditProbeSelections(auditId)
  if (selections.length === 0) return reference
  return subsetReference(reference, selections.map((selection) => selection.probeId))
}

export function subsetReference(reference: KbfReferenceV1, probeIds: readonly string[]): KbfReferenceV1 {
  const byId = new Map(reference.probes.map((probe) => [probe.id, probe]))
  const probes = probeIds.map((probeId) => {
    const probe = byId.get(probeId)
    if (!probe) throw new Error(`reference ${reference.referenceId} does not contain reserved probe ${probeId}`)
    return probe
  })
  const selfTest = subsetReferenceSelfTest(reference, probeIds)
  const power = computeBinomialPower({
    selfHamming: selfTest.hamming,
    selfTotal: selfTest.total,
    minimumMismatchDelta: reference.minimumMismatchDelta,
  })
  return {
    ...reference,
    probes,
    selectedProbeCount: probes.length,
    selfTest: {
      ...selfTest,
      outcomes: probeIds.map((probeId) => reference.selfTest.outcomes.find((outcome) => outcome.probeId === probeId)!),
      parentReferenceProbeCount: reference.probes.length,
    },
    statisticalPower: power.power,
    statisticalPowerEvidence: {
      test: 'one-sided-binomial',
      alpha: 0.05,
      clopperPearsonConfidence: 0.99,
      selfHamming: selfTest.hamming,
      selfTotal: selfTest.total,
      p0UpperBound: power.p0,
      alternativeMismatchRate: power.p1,
      criticalMismatchCount: power.criticalMismatchCount,
      power: power.power,
    },
    parentReferenceId: reference.referenceId,
  }
}

function assertProbeCount(probeCount: number): void {
  if (!Number.isInteger(probeCount) || probeCount < 10 || probeCount > 500 || probeCount % 10 !== 0) {
    throw new Error('audit probe count must be a multiple of 10 from 10 through 500')
  }
}
