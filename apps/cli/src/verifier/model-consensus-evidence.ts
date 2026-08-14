import { readFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { canonicalHashBytes32, type KbfProbe, type ReferenceQueryProfileV1 } from '@antseed/fingerprints'
import { writeJsonAtomic } from './atomic-files.js'
import type { ModelVerificationTargetResult } from './model-run.js'
import { verifyProxyAuditEvidenceFile, type ProxyAuditEvidenceV1 } from './proxy-evidence.js'
import { safeServiceSlug } from './slug.js'

interface ReferenceIntegrityEvidenceV1 {
  version: 1
  kind: 'antseed-kbf-reference-integrity'
  referenceId: string
  referenceModel: string
  queryProfileHash: string
  queryProfile: ReferenceQueryProfileV1
  statisticalPower: number
  statisticalPowerEvidence: Record<string, unknown>
  selfTest: ProxyAuditEvidenceV1['reference']['selfTest']
  summary: {
    totalProbeCount: number
    referenceConsensusConfirmedCount: number
    referenceSelfMismatchCount: number
    referenceSelfMissingCount: number
  }
  probes: Array<{
    probe: KbfProbe
    referenceSelfTest: { answer: number | null; match: 0 | 1 | null }
    referenceConsensusConfirmed: boolean
  }>
}

export interface ModelProbeConsensusEvidenceV1 {
  version: 1
  kind: 'antseed-verifier-model-probe-consensus'
  runId: string
  epoch: string
  model: string
  createdAt: string
  scope: {
    referenceConsensus: true
    referenceIntegrity: 'linked-model-reference-file'
    sellerAnswers: 'verified-response-auth-with-exact-preimages-only'
    rawSellerResponses: 'linked-seller-exchange-files'
    paymentEvidence: false
    onChainInclusionProof: false
  }
  reference: {
    referenceId: string
    integrityHash: string
    integrityPath: string
    relativeIntegrityPath: string
  } | null
  summary: {
    probeCount: number
    auditedSellerCount: number
    authenticatedSellerCount: number
    signedExchangeCount: number
    authenticatedAnswerCount: number
    referenceMatchCount: number
    referenceMismatchCount: number
    unparsedAnswerCount: number
    referenceMatchRate: number | null
  }
  sellers: Array<{
    sellerEvidenceId: string
    peerId: string
    evidenceHash: string
    evidencePath: string
    relativeEvidencePath: string
  }>
  probes: Array<{
    probeId: string
    referenceId: string
    referenceConsensus: number
    referenceSelfTest: { answer: number | null; match: 0 | 1 | null }
    authenticatedSellerAnswerCount: number
    referenceMatchCount: number
    referenceMismatchCount: number
    unparsedAnswerCount: number
    referenceMatchRate: number | null
    sellerAnswers: Array<{
      peerId: string
      sellerEvidenceId: string
      evidenceHash: string
      batchIndex: number
      requestId: string
      requestHash: string
      responseHash: string
      rawResponse: {
        exchangePath: string
        buyerProxyBodyField: 'response.bodyBase64'
        signedResponsePreimageField: 'responseAuth.signedPreimages.responseBase64'
      }
      answer: number | null
      match: 0 | 1 | null
    }>
  }>
}

interface ProbeAccumulator {
  probe: KbfProbe
  referenceId: string
  referenceSelfTest: { answer: number | null; match: 0 | 1 | null }
  sellerAnswers: ModelProbeConsensusEvidenceV1['probes'][number]['sellerAnswers']
}

export async function writeModelProbeConsensusEvidence(input: {
  directory: string
  referencesDirectory: string
  runId: string
  epoch: string
  model: string
  createdAt: string
  results: ModelVerificationTargetResult[]
}): Promise<{
  directory: string
  consensusPath: string
  manifestPath: string
  referenceIntegrityPath: string | null
}> {
  const probeById = new Map<string, ProbeAccumulator>()
  const sellers: ModelProbeConsensusEvidenceV1['sellers'] = []
  const authenticatedSellers = new Set<string>()
  let signedExchangeCount = 0
  let referenceEvidence: ProxyAuditEvidenceV1['reference'] | null = null
  let referenceEvidenceHash: string | null = null

  for (const result of input.results) {
    const evidence = await verifyProxyAuditEvidenceFile(result.evidencePath, result.evidenceHash)
    const currentReferenceHash = canonicalHashBytes32(evidence.reference)
    if (referenceEvidenceHash && referenceEvidenceHash !== currentReferenceHash) {
      throw new Error(`conflicting reference evidence while building ${input.model} run ${input.runId}`)
    }
    referenceEvidence ??= evidence.reference
    referenceEvidenceHash ??= currentReferenceHash
    sellers.push({
      sellerEvidenceId: result.auditId,
      peerId: result.peerId,
      evidenceHash: result.evidenceHash,
      evidencePath: result.evidencePath,
      relativeEvidencePath: relativePath(input.directory, result.evidencePath),
    })
    const selfTestByProbeId = new Map(
      (evidence.reference.selfTest.outcomes ?? []).map((outcome) => [outcome.probeId, outcome]),
    )
    for (const probe of evidence.reference.probes) {
      const existing = probeById.get(probe.id)
      if (existing && canonicalHashBytes32(existing.probe) !== canonicalHashBytes32(probe)) {
        throw new Error(`conflicting reference probe ${probe.id} while building ${input.model} consensus evidence`)
      }
      if (!existing) {
        probeById.set(probe.id, {
          probe,
          referenceId: evidence.reference.referenceId,
          referenceSelfTest: selfTestByProbeId.get(probe.id) ?? { answer: null, match: null },
          sellerAnswers: [],
        })
      }
    }
    for (const exchange of evidence.exchanges) {
      const auth = exchange.responseAuth
      if (exchange.status !== 'succeeded'
        || auth.status !== 'verified'
        || !auth.record
        || !auth.signedPreimages
        || !auth.requestId) continue
      signedExchangeCount += 1
      authenticatedSellers.add(result.peerId.toLowerCase())
      for (const [index, probeId] of exchange.probeIds.entries()) {
        const accumulator = probeById.get(probeId)
        if (!accumulator) continue
        accumulator.sellerAnswers.push({
          peerId: result.peerId,
          sellerEvidenceId: result.auditId,
          evidenceHash: result.evidenceHash,
          batchIndex: exchange.batchIndex,
          requestId: auth.requestId,
          requestHash: auth.record.requestHash,
          responseHash: auth.record.responseHash,
          rawResponse: {
            exchangePath: relativePath(
              input.directory,
              join(dirname(result.evidencePath), 'exchanges', `${String(exchange.batchIndex).padStart(3, '0')}.json`),
            ),
            buyerProxyBodyField: 'response.bodyBase64',
            signedResponsePreimageField: 'responseAuth.signedPreimages.responseBase64',
          },
          answer: exchange.answers[index] ?? null,
          match: exchange.matches[index] ?? null,
        })
      }
    }
  }

  const probes = [...probeById.values()]
    .sort((left, right) => left.probe.id.localeCompare(right.probe.id))
    .map((entry) => {
      const referenceMatchCount = entry.sellerAnswers.filter((answer) => answer.match === 1).length
      const referenceMismatchCount = entry.sellerAnswers.filter((answer) => answer.match === 0).length
      const authenticatedSellerAnswerCount = referenceMatchCount + referenceMismatchCount
      return {
        probeId: entry.probe.id,
        referenceId: entry.referenceId,
        referenceConsensus: entry.probe.consensus,
        referenceSelfTest: entry.referenceSelfTest,
        sellerAnswers: entry.sellerAnswers.sort((left, right) => left.peerId.localeCompare(right.peerId)),
        authenticatedSellerAnswerCount,
        referenceMatchCount,
        referenceMismatchCount,
        unparsedAnswerCount: entry.sellerAnswers.filter((answer) => answer.match === null).length,
        referenceMatchRate: authenticatedSellerAnswerCount === 0
          ? null
          : referenceMatchCount / authenticatedSellerAnswerCount,
      }
    })
  const referenceMatchCount = probes.reduce((total, probe) => total + probe.referenceMatchCount, 0)
  const referenceMismatchCount = probes.reduce((total, probe) => total + probe.referenceMismatchCount, 0)
  const authenticatedAnswerCount = referenceMatchCount + referenceMismatchCount
  const referenceIntegrity = referenceEvidence ? createReferenceIntegrityEvidence(referenceEvidence) : null
  const referenceIntegrityPath = referenceIntegrity
    ? join(input.referencesDirectory, safeServiceSlug(referenceIntegrity.referenceId), 'probe-integrity.json')
    : null
  if (referenceIntegrity && referenceIntegrityPath) await writeJsonAtomic(referenceIntegrityPath, referenceIntegrity, true)
  const reference = referenceIntegrity && referenceIntegrityPath ? {
    referenceId: referenceIntegrity.referenceId,
    integrityHash: canonicalHashBytes32(referenceIntegrity),
    integrityPath: referenceIntegrityPath,
    relativeIntegrityPath: relativePath(input.directory, referenceIntegrityPath),
  } : null
  const consensus: ModelProbeConsensusEvidenceV1 = {
    version: 1,
    kind: 'antseed-verifier-model-probe-consensus',
    runId: input.runId,
    epoch: input.epoch,
    model: input.model,
    createdAt: input.createdAt,
    scope: {
      referenceConsensus: true,
      referenceIntegrity: 'linked-model-reference-file',
      sellerAnswers: 'verified-response-auth-with-exact-preimages-only',
      rawSellerResponses: 'linked-seller-exchange-files',
      paymentEvidence: false,
      onChainInclusionProof: false,
    },
    reference,
    summary: {
      probeCount: probes.length,
      auditedSellerCount: input.results.length,
      authenticatedSellerCount: authenticatedSellers.size,
      signedExchangeCount,
      authenticatedAnswerCount,
      referenceMatchCount,
      referenceMismatchCount,
      unparsedAnswerCount: probes.reduce((total, probe) => total + probe.unparsedAnswerCount, 0),
      referenceMatchRate: authenticatedAnswerCount === 0 ? null : referenceMatchCount / authenticatedAnswerCount,
    },
    sellers: sellers.sort((left, right) => left.peerId.localeCompare(right.peerId)),
    probes,
  }
  const consensusPath = join(input.directory, 'probe-consensus.json')
  await writeJsonAtomic(consensusPath, consensus, true)
  const manifest = {
    version: 1,
    kind: 'antseed-verifier-model-evidence-pack',
    runId: input.runId,
    epoch: input.epoch,
    model: input.model,
    scope: consensus.scope,
    reference,
    files: [{
      path: 'probe-consensus.json',
      hash: canonicalHashBytes32(consensus),
      purpose: 'Reference consensus and authenticated seller support by probe',
    }],
  }
  const manifestPath = join(input.directory, 'manifest.json')
  await writeJsonAtomic(manifestPath, manifest, true)
  return { directory: input.directory, consensusPath, manifestPath, referenceIntegrityPath }
}

export async function writeModelAuditManifest(input: {
  directory: string
  runId: string
  epoch: string
  model: string
  summaryPath: string
  consensusPath: string
  referenceIntegrityPath: string | null
  results: ModelVerificationTargetResult[]
}): Promise<string> {
  const summary = JSON.parse(await readFile(input.summaryPath, 'utf8')) as unknown
  const consensus = JSON.parse(await readFile(input.consensusPath, 'utf8')) as ModelProbeConsensusEvidenceV1
  const manifest = {
    version: 1,
    kind: 'antseed-verifier-model-evidence-pack',
    runId: input.runId,
    epoch: input.epoch,
    model: input.model,
    scope: consensus.scope,
    reference: consensus.reference,
    files: [
      {
        path: relativePath(input.directory, input.summaryPath),
        hash: canonicalHashBytes32(summary),
        purpose: 'Seller results, failures, skips, cost, and outcome reasons for this model run',
      },
      {
        path: relativePath(input.directory, input.consensusPath),
        hash: canonicalHashBytes32(consensus),
        purpose: 'Reference consensus and authenticated seller support by probe',
      },
    ],
    sellers: input.results
      .map((result) => ({
        peerId: result.peerId,
        sellerEvidenceId: result.auditId,
        evidenceHash: result.evidenceHash,
        evidencePath: relativePath(input.directory, result.evidencePath),
      }))
      .sort((left, right) => left.peerId.localeCompare(right.peerId)),
    referenceIntegrityPath: input.referenceIntegrityPath
      ? relativePath(input.directory, input.referenceIntegrityPath)
      : null,
  }
  const manifestPath = join(input.directory, 'manifest.json')
  await writeJsonAtomic(manifestPath, manifest, true)
  return manifestPath
}

function createReferenceIntegrityEvidence(reference: ProxyAuditEvidenceV1['reference']): ReferenceIntegrityEvidenceV1 {
  const selfTestByProbeId = new Map(
    (reference.selfTest.outcomes ?? []).map((outcome) => [outcome.probeId, outcome]),
  )
  const probes = reference.probes.map((probe) => {
    const referenceSelfTest = selfTestByProbeId.get(probe.id) ?? { answer: null, match: null }
    return {
      probe,
      referenceSelfTest,
      referenceConsensusConfirmed: referenceSelfTest.match === 1,
    }
  })
  return {
    version: 1,
    kind: 'antseed-kbf-reference-integrity',
    referenceId: reference.referenceId,
    referenceModel: reference.referenceModel,
    queryProfileHash: reference.queryProfileHash,
    queryProfile: reference.queryProfile,
    statisticalPower: reference.statisticalPower,
    statisticalPowerEvidence: reference.statisticalPowerEvidence,
    selfTest: reference.selfTest,
    summary: {
      totalProbeCount: probes.length,
      referenceConsensusConfirmedCount: probes.filter((entry) => entry.referenceSelfTest.match === 1).length,
      referenceSelfMismatchCount: probes.filter((entry) => entry.referenceSelfTest.match === 0).length,
      referenceSelfMissingCount: probes.filter((entry) => entry.referenceSelfTest.match === null).length,
    },
    probes,
  }
}

function relativePath(from: string, to: string): string {
  return relative(from, to).split(sep).join('/')
}
