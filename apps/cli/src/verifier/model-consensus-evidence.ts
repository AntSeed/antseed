import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { canonicalHashBytes32, type KbfProbe } from '@antseed/fingerprints'
import { writeJsonAtomic, writeTextAtomic } from './atomic-files.js'
import type { ModelVerificationTargetResult } from './model-run.js'
import { verifyProxyAuditEvidenceFile } from './proxy-evidence.js'

export interface ModelProbeConsensusEvidenceV1 {
  version: 1
  kind: 'antseed-verifier-model-probe-consensus'
  runId: string
  epoch: string
  model: string
  createdAt: string
  evidenceLevel: 'authenticated-seller-consensus-no-payment-evidence'
  scope: {
    referenceConsensus: true
    sellerAnswers: 'verified-response-auth-with-exact-preimages-only'
    paymentEvidence: false
    onChainInclusionProof: false
  }
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
  audits: Array<{
    auditId: string
    peerId: string
    evidenceHash: string
    evidencePath: string
  }>
  probes: Array<{
    probe: KbfProbe
    referenceId: string
    referenceSelfTest: { answer: number | null; match: 0 | 1 | null }
    authenticatedSellerAnswerCount: number
    referenceMatchCount: number
    referenceMismatchCount: number
    unparsedAnswerCount: number
    referenceMatchRate: number | null
    sellerAnswers: Array<{
      peerId: string
      auditId: string
      evidenceHash: string
      batchIndex: number
      requestId: string
      requestHash: string
      responseHash: string
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
  runId: string
  epoch: string
  model: string
  createdAt: string
  results: ModelVerificationTargetResult[]
}): Promise<{ directory: string; consensusPath: string; manifestPath: string }> {
  const packDirectory = join(input.directory, `${input.runId}.evidence-pack`)
  await mkdir(packDirectory, { recursive: true })
  const probeById = new Map<string, ProbeAccumulator>()
  const audits: ModelProbeConsensusEvidenceV1['audits'] = []
  const authenticatedSellers = new Set<string>()
  let signedExchangeCount = 0

  for (const result of input.results) {
    const evidence = await verifyProxyAuditEvidenceFile(result.evidencePath, result.evidenceHash)
    audits.push({
      auditId: result.auditId,
      peerId: result.peerId,
      evidenceHash: result.evidenceHash,
      evidencePath: result.evidencePath,
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
          auditId: result.auditId,
          evidenceHash: result.evidenceHash,
          batchIndex: exchange.batchIndex,
          requestId: auth.requestId,
          requestHash: auth.record.requestHash,
          responseHash: auth.record.responseHash,
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
        ...entry,
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
  const consensus: ModelProbeConsensusEvidenceV1 = {
    version: 1,
    kind: 'antseed-verifier-model-probe-consensus',
    runId: input.runId,
    epoch: input.epoch,
    model: input.model,
    createdAt: input.createdAt,
    evidenceLevel: 'authenticated-seller-consensus-no-payment-evidence',
    scope: {
      referenceConsensus: true,
      sellerAnswers: 'verified-response-auth-with-exact-preimages-only',
      paymentEvidence: false,
      onChainInclusionProof: false,
    },
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
    audits: audits.sort((left, right) => left.peerId.localeCompare(right.peerId)),
    probes,
  }
  const consensusPath = join(packDirectory, 'probe-consensus.json')
  await writeJsonAtomic(consensusPath, consensus, true)
  const manifest = {
    version: 1,
    kind: 'antseed-verifier-model-evidence-pack',
    runId: input.runId,
    epoch: input.epoch,
    model: input.model,
    evidenceLevel: consensus.evidenceLevel,
    files: [{
      path: 'probe-consensus.json',
      hash: canonicalHashBytes32(consensus),
      purpose: 'Reference consensus and authenticated seller support by probe',
    }],
  }
  const manifestPath = join(packDirectory, 'manifest.json')
  await writeJsonAtomic(manifestPath, manifest, true)
  await writeTextAtomic(join(packDirectory, 'README.md'), modelEvidencePackReadme(consensus))
  return { directory: packDirectory, consensusPath, manifestPath }
}

function modelEvidencePackReadme(evidence: ModelProbeConsensusEvidenceV1): string {
  return `# AntSeed Model Consensus Evidence\n\n`
    + `Model: ${evidence.model}\n\n`
    + `This pack groups ${evidence.summary.signedExchangeCount} seller-signed exchanges from `
    + `${evidence.summary.authenticatedSellerCount} authenticated seller(s) by reference probe.\n\n`
    + `- probe-consensus.json: reference probes, enrollment evidence, self-test results, and signed seller support\n`
    + `- manifest.json: canonical file hashes and evidence scope\n\n`
    + `Each seller answer points to its audit ID, evidence hash, batch, request ID, and signed request/response hashes. `
    + `The corresponding audit evidence pack contains the exact request, response, and signature preimages. `
    + `Evidence level describes proof scope; this pack proves seller-authenticated responses, not payment or on-chain inclusion.\n`
}
