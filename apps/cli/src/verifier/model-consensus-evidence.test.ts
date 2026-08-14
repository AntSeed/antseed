import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createReferenceQueryProfile } from '@antseed/fingerprints'
import { emptyAuditCostSummary, writeProxyAuditEvidence, type ProxyAuditEvidenceV1 } from './proxy-evidence.js'
import { writeModelProbeConsensusEvidence } from './model-consensus-evidence.js'

function audit(peerId: string, answer: number, match: 0 | 1): ProxyAuditEvidenceV1 {
  return {
    version: 1, kind: 'antseed-buyer-proxy-kbf-audit',
    evidenceLevel: 'proxy-observation-with-verified-response-auth-no-payment-evidence',
    createdAt: '2026-08-13T10:00:00.000Z',
    buyerProxy: { baseUrl: 'http://127.0.0.1:8377', statePath: '/tmp/buyer.state.json', pid: 1 },
    target: { peerId, displayName: null, agentId: null, service: 'model-a' },
    reference: {
      referenceId: 'reference-1', referenceModel: 'model-a', queryProfileHash: `0x${'11'.repeat(32)}`,
      queryProfile: createReferenceQueryProfile({ upstreamModel: 'upstream/model-a' }),
      statisticalPower: 0.99, statisticalPowerEvidence: { power: 0.99 },
      selfTest: { hamming: 0, total: 1, coverage: 1, errorRate: 0,
        outcomes: [{ probeId: 'probe-1', answer: 10, match: 1 }] },
      probes: [{ id: 'probe-1', name: 'probe', domain: 'math', template: 'Value is ___.',
        consensus: 10, range: [0, 20], tolerance: { mode: 'absolute', value: 0 },
        enrollmentEvidence: { temperatures: [0, 0.7, 0.7], answers: [10, 10, 10], rule: 'rounded-exact-agreement' } }],
    },
    exchanges: [{
      batchIndex: 0, attemptCount: 1, requestIds: ['request-1'], probeIds: ['probe-1'],
      request: { method: 'POST', url: '/v1/chat/completions', headers: {}, bodyBase64: 'e30=', hash: 'local-request' },
      response: { statusCode: 200, headers: {}, bodyBase64: 'e30=', hash: 'local-response' },
      timing: { startedAt: 1, completedAt: 2, responseLatencyMs: 1 }, answers: [answer], matches: [match],
      status: 'succeeded', failureReason: null, cost: null,
      responseAuth: {
        requestId: 'request-1', status: 'verified', failureReason: null,
        record: { version: 1, requestId: 'request-1', buyerPeerId: '33'.repeat(20), sellerPeerId: peerId,
          advertisedService: 'model-a', provider: 'test', statusCode: 200,
          requestHash: `0x${'44'.repeat(32)}`, responseHash: `0x${'55'.repeat(32)}`,
          responseStartedAt: 1, responseCompletedAt: 2, signature: `0x${'66'.repeat(65)}`,
          receivedAt: 3, verified: true, verificationError: null },
        signedPreimages: { encoding: 'antseed-http-codec-v1', signatureEncoding: 'antseed-response-auth-signing-v1',
          hashAlgorithm: 'keccak256', requestBase64: 'AA==', responseBase64: 'AA==',
          responseAuthSigningBase64: 'AA==', requestHash: `0x${'44'.repeat(32)}`, responseHash: `0x${'55'.repeat(32)}` },
      },
    }],
    result: { selectedProbeCount: 1, parsedProbeCount: 1, matchVector: [match], matchVectorHash: `0x${'77'.repeat(32)}`,
      stats: { selfHamming: 0, selfTotal: 1, targetHamming: match ? 0 : 1, targetTotal: 1,
        selfCoverage: 1, targetCoverage: 1, p0Cp99: 0.1, pValueBinomial: 1 },
      verdict: match ? 'SAME' : 'DIFF', verdictReason: null, cost: emptyAuditCostSummary() },
  }
}

test('model consensus evidence aggregates authenticated seller support by probe', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-model-consensus-'))
  try {
    const runDirectory = join(directory, 'audits', 'run-1')
    const results = []
    for (const [index, match] of ([1, 0] as const).entries()) {
      const peerId = String(index + 1).repeat(40)
      const auditId = `audit-${index}`
      const written = await writeProxyAuditEvidence(
        join(runDirectory, 'sellers'),
        auditId,
        audit(peerId, match ? 10 : 11, match),
      )
      results.push({ peerId, displayName: null, agentId: null, service: 'model-a', status: match ? 'SAME' as const : 'DIFF' as const,
        auditId, parsedProbeCount: 1, probeCount: 1, correctProbeCount: match, incorrectProbeCount: match ? 0 : 1,
        correctRate: match, requestCount: 1, cost: emptyAuditCostSummary(), evidencePath: written.path,
        evidenceHash: written.evidenceHash })
    }
    const written = await writeModelProbeConsensusEvidence({
      directory: runDirectory,
      referencesDirectory: join(directory, 'references'),
      runId: 'run-1', epoch: '2026-08-13', model: 'model-a',
      createdAt: '2026-08-13T10:01:00.000Z', results,
    })
    const evidence = JSON.parse(await readFile(written.consensusPath, 'utf8')) as {
      version: number
      evidenceLevel?: string
      scope: { referenceIntegrity: string; rawSellerResponses: string; paymentEvidence: boolean }
      reference: { relativeIntegrityPath: string }
      summary: { authenticatedSellerCount: number; referenceMatchCount: number; referenceMismatchCount: number }
      probes: Array<{
        sellerAnswers: Array<{ rawResponse: { exchangePath: string; signedResponsePreimageField: string } }>
        probeId: string
        referenceConsensus: number
      }>
    }
    assert.equal(evidence.version, 1)
    assert.equal(evidence.evidenceLevel, undefined)
    assert.deepEqual(evidence.scope, {
      referenceConsensus: true,
      referenceIntegrity: 'linked-model-reference-file',
      sellerAnswers: 'verified-response-auth-with-exact-preimages-only',
      rawSellerResponses: 'linked-seller-exchange-files',
      paymentEvidence: false,
      onChainInclusionProof: false,
    })
    assert.deepEqual(evidence.summary, {
      probeCount: 1, auditedSellerCount: 2, authenticatedSellerCount: 2, signedExchangeCount: 2,
      authenticatedAnswerCount: 2, referenceMatchCount: 1, referenceMismatchCount: 1,
      unparsedAnswerCount: 0, referenceMatchRate: 0.5,
    })
    assert.equal(evidence.probes[0]?.sellerAnswers.length, 2)
    assert.equal(
      evidence.probes[0]?.sellerAnswers[0]?.rawResponse.exchangePath,
      'sellers/1111111111111111111111111111111111111111/exchanges/000.json',
    )
    assert.equal(
      evidence.probes[0]?.sellerAnswers[0]?.rawResponse.signedResponsePreimageField,
      'responseAuth.signedPreimages.responseBase64',
    )
    assert.equal(evidence.probes[0]?.probeId, 'probe-1')
    assert.equal(evidence.probes[0]?.referenceConsensus, 10)
    assert.match(evidence.reference.relativeIntegrityPath, /^\.\.\/\.\.\/references\/reference-1\/probe-integrity\.json$/)
    assert.ok(written.referenceIntegrityPath)
    const integrity = JSON.parse(await readFile(written.referenceIntegrityPath!, 'utf8')) as {
      kind: string
      probes: Array<{ probe: { enrollmentEvidence?: unknown } }>
    }
    assert.equal(integrity.kind, 'antseed-kbf-reference-integrity')
    assert.ok(integrity.probes[0]?.probe.enrollmentEvidence)

    const manifest = JSON.parse(await readFile(written.manifestPath, 'utf8')) as {
      version: number
      evidenceLevel?: string
      scope: { rawSellerResponses: string }
    }
    assert.equal(manifest.version, 1)
    assert.equal(manifest.evidenceLevel, undefined)
    assert.equal(manifest.scope.rawSellerResponses, 'linked-seller-exchange-files')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
