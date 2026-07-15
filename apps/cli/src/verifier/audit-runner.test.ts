import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Wallet } from 'ethers'
import type { AntseedNode, ExchangeRecord, Identity, PeerInfo, ResponseAuthPayload, SerializedHttpRequest, SerializedHttpResponse, VerifierRegistryClient } from '@antseed/node'
import { computeBatchRoot, createResponseAuthPayload, verifyResponseAuth } from '@antseed/node'
import { probeBankSource } from '@antseed/fingerprints'
import type { FingerprintReference } from '@antseed/fingerprints'
import {
  combineVerdicts,
  drainPendingReveals,
  loadBurnedReferenceIds,
  loadPendingReveals,
  runCohortAudit,
  selectCohort,
} from './audit-runner.js'
import type { AuditRunnerOptions, ProbeExecutor, RevealQueueOptions } from './audit-runner.js'
import type { ProbeExchangeEvidence, SellerProbeRun } from './probing.js'
import { loadUsedProbeIds, recordUsedProbeIds } from './probe-log.js'

const VERIFIER_WALLET = new Wallet('0x' + '22'.repeat(32))
const SELLER_A_WALLET = new Wallet('0x' + '33'.repeat(32))
const SELLER_B_WALLET = new Wallet('0x' + '44'.repeat(32))
const SERVICE = 'kimi-k2'

const noop = (): void => {}
const identity = { wallet: VERIFIER_WALLET } as unknown as Identity
const node = {} as unknown as AntseedNode

function sellerPeer(wallet: Wallet, agentId: number): PeerInfo {
  return {
    peerId: wallet.address.slice(2).toLowerCase(),
    onChainAgentId: agentId,
    capabilities: ['verification.response-auth.v1'],
  } as unknown as PeerInfo
}

interface FakeRegistry {
  client: VerifierRegistryClient
  commits: string[]
  attestations: Array<{ agentId: number | bigint; probeCount: number; batchRoot: string; evidenceHash: string }>
  anchors: Array<{
    probeCommitment: string
    probeCount: number
    records: ExchangeRecord[]
    signingPayloads: Uint8Array[]
    recordProbeCounts: number[]
    batchRoot: string
  }>
  reveals: Array<{ probeCommitment: string; probeSetJson: string }>
  /** Chronological call sequence, for transparent-audit ordering assertions. */
  sequence: string[]
}

/**
 * Fake AntseedVerifierRegistry: records commits/anchors/attestations/reveals
 * (with their call order) and lets tests choose whether submissions actually
 * CREDIT (advance lastCreditedAt) — mirroring the contract's cooldown /
 * epoch-cap behavior.
 */
function fakeRegistry(options?: {
  creditOnSubmit?: (agentId: number) => boolean
  commitError?: Error
  anchorError?: Error
  revealError?: Error
}): FakeRegistry {
  const commits: string[] = []
  const attestations: FakeRegistry['attestations'] = []
  const anchors: FakeRegistry['anchors'] = []
  const reveals: FakeRegistry['reveals'] = []
  const sequence: string[] = []
  const creditedAt = new Map<number, number>()
  const client = {
    async lastCreditedAt(agentId: number | bigint): Promise<number> {
      return creditedAt.get(Number(agentId)) ?? 0
    },
    async commitProbeSet(_wallet: unknown, commitment: string): Promise<string> {
      if (options?.commitError) throw options.commitError
      sequence.push('commit')
      commits.push(commitment)
      return '0x' + 'c'.repeat(64)
    },
    async anchorExchangeBatch(
      _wallet: unknown,
      input: {
        probeCommitment: string
        records: ExchangeRecord[]
        signingPayloads: Uint8Array[]
        recordProbeCounts: number[]
      },
    ): Promise<{ txHash: string; batchRoot: string }> {
      if (options?.anchorError) throw options.anchorError
      // Mirror the real client's guards: the three per-record arrays must be
      // aligned, and every per-record probe count must be a positive integer.
      if (input.records.length === 0) {
        throw new Error('anchorExchangeBatch: cannot anchor an empty exchange batch')
      }
      if (input.signingPayloads.length !== input.records.length
        || input.recordProbeCounts.length !== input.records.length) {
        throw new Error('anchorExchangeBatch: array length mismatch')
      }
      for (const count of input.recordProbeCounts) {
        if (!Number.isInteger(count) || count < 1) {
          throw new Error(`anchorExchangeBatch: recordProbeCounts entry (${count}) must be an integer >= 1`)
        }
      }
      // Every anchored record MUST carry the full signing preimage — the
      // contract reverts otherwise. Sanity-check each is non-empty bytes.
      for (const payload of input.signingPayloads) {
        if (!(payload instanceof Uint8Array) || payload.length === 0) {
          throw new Error('anchorExchangeBatch: each signingPayload must be non-empty bytes')
        }
      }
      sequence.push('anchor')
      const batchRoot = computeBatchRoot(input.records)
      const probeCount = input.recordProbeCounts.reduce((sum, c) => sum + c, 0)
      anchors.push({
        probeCommitment: input.probeCommitment,
        probeCount,
        records: input.records,
        signingPayloads: input.signingPayloads,
        recordProbeCounts: input.recordProbeCounts,
        batchRoot,
      })
      return { txHash: '0x' + 'b'.repeat(64), batchRoot }
    },
    async submitAttestation(
      _wallet: unknown,
      input: { agentId: number | bigint; probeCount: number; batchRoot: string; evidenceHash: string },
    ): Promise<string> {
      sequence.push('attest')
      attestations.push(input)
      const agentId = Number(input.agentId)
      if (options?.creditOnSubmit?.(agentId) ?? true) {
        creditedAt.set(agentId, Math.floor(Date.now() / 1000))
      }
      return '0x' + 'a'.repeat(64)
    },
    async revealProbeSet(
      _wallet: unknown,
      input: { probeCommitment: string; probeSetJson: string },
    ): Promise<string> {
      if (options?.revealError) throw options.revealError
      sequence.push('reveal')
      reveals.push(input)
      return '0x' + 'd'.repeat(64)
    },
  } as unknown as VerifierRegistryClient
  return { client, commits, attestations, anchors, reveals, sequence }
}

/**
 * Honest probe executor: answers every plan with a signed ResponseAuth over
 * the exact request/response, exactly as a cooperating seller would — the
 * evidence it produces is fully re-verifiable.
 */
function honestExecutor(walletsByPeer: Map<string, Wallet>, calls?: Array<{ peerId: string; service: string }>): ProbeExecutor {
  return async (peer, service, probeSet, _maxPerRequest) => {
    calls?.push({ peerId: peer.peerId, service })
    const wallet = walletsByPeer.get(peer.peerId)
    if (!wallet) throw new Error(`no wallet for ${peer.peerId}`)
    const bodyBytes = new TextEncoder().encode(JSON.stringify({ model: service, messages: [] }))
    const request: SerializedHttpRequest = {
      requestId: `req-${peer.peerId.slice(0, 6)}`,
      method: 'POST',
      path: '/v1/chat/completions',
      headers: { 'content-type': 'application/json' },
      body: bodyBytes,
    }
    const responseBody = new TextEncoder().encode(JSON.stringify({
      choices: [{ message: { content: 'probably 42 for all of them' } }],
    }))
    const response: SerializedHttpResponse = {
      requestId: request.requestId,
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: responseBody,
    }
    const auth = createResponseAuthPayload({
      request,
      response,
      buyerPeerId: VERIFIER_WALLET.address,
      sellerPeerId: peer.peerId,
      advertisedService: service,
      provider: 'openai',
      responseStartedAt: 1,
      responseCompletedAt: 2,
    }, wallet)
    const exchange: ProbeExchangeEvidence = {
      requestId: request.requestId,
      request: {
        method: request.method,
        path: request.path,
        headers: { ...request.headers },
        bodyBase64: Buffer.from(bodyBytes).toString('base64'),
      },
      response: {
        statusCode: 200,
        headers: { ...response.headers },
        bodyBase64: Buffer.from(responseBody).toString('base64'),
      },
      responseAuth: auth,
    }
    const run: SellerProbeRun = {
      peerId: peer.peerId,
      agentId: peer.onChainAgentId,
      answers: new Array<number | null>(probeSet.probes.length).fill(42),
      requestIds: [request.requestId],
      probesPerRequest: [probeSet.probes.length],
      responseAuths: [{ requestHash: auth.requestHash, responseHash: auth.responseHash, signature: auth.signature }],
      exchanges: [exchange],
      fullyAuthenticated: true,
      errors: [],
    }
    return { run }
  }
}

interface TempDirs {
  publishDir: string
  probeLogDir: string
  revealQueueDir: string
}

async function withTempDirs(fn: (dirs: TempDirs) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'antseed-audit-runner-'))
  try {
    await fn({
      publishDir: join(root, 'packs'),
      probeLogDir: join(root, 'probe-log'),
      revealQueueDir: join(root, 'verifier'),
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

function baseOptions(dirs: TempDirs, overrides?: Partial<AuditRunnerOptions>): AuditRunnerOptions {
  return {
    probesPerAudit: 4,
    minProbeCount: 1,
    cohortMinSize: 1,
    cohortMaxSize: 10,
    stalenessWindowSecs: 0,
    maxProbesPerRequest: 3,
    publishDir: dirs.publishDir,
    probeSource: 'bank',
    probeLogDir: dirs.probeLogDir,
    probeRotationHistory: 0,
    revealQueueDir: dirs.revealQueueDir,
    log: noop,
    warn: noop,
    ...overrides,
  }
}

function queueOptions(dirs: TempDirs, overrides?: Partial<RevealQueueOptions>): RevealQueueOptions {
  return {
    revealQueueDir: dirs.revealQueueDir,
    probeLogDir: dirs.probeLogDir,
    probeRotationHistory: 0,
    log: noop,
    warn: noop,
    ...overrides,
  }
}

test('skips (no commit, no probes) when the effective probe count falls below minProbeCount', async () => {
  await withTempDirs(async (dirs) => {
    const registry = fakeRegistry()
    const executorCalls: Array<{ peerId: string; service: string }> = []
    const result = await runCohortAudit(
      node, identity, registry.client, SERVICE,
      [sellerPeer(SELLER_A_WALLET, 7)],
      undefined,
      baseOptions(dirs, {
        probesPerAudit: 2,
        minProbeCount: 5,
        probeExecutor: honestExecutor(new Map([[sellerPeer(SELLER_A_WALLET, 7).peerId, SELLER_A_WALLET]]), executorCalls),
      }),
    )
    assert.equal(result, null)
    assert.equal(registry.commits.length, 0, 'must not commit before skipping')
    assert.equal(registry.attestations.length, 0)
    assert.equal(executorCalls.length, 0, 'must not send any probe traffic')
  })
})

test('skips before commit or probes when maxProbesPerRequest exceeds the contract limit', async () => {
  await withTempDirs(async (dirs) => {
    const registry = fakeRegistry()
    const executorCalls: Array<{ peerId: string; service: string }> = []
    const peer = sellerPeer(SELLER_A_WALLET, 7)
    const result = await runCohortAudit(
      node, identity, registry.client, SERVICE, [peer], undefined,
      baseOptions(dirs, {
        maxProbesPerRequest: 4,
        probeExecutor: honestExecutor(new Map([[peer.peerId, SELLER_A_WALLET]]), executorCalls),
      }),
    )
    assert.equal(result, null)
    assert.equal(registry.commits.length, 0)
    assert.equal(executorCalls.length, 0)
  })
})

test('skips before commit or probes when a round can exceed 256 anchor records', async () => {
  await withTempDirs(async (dirs) => {
    const registry = fakeRegistry()
    const executorCalls: Array<{ peerId: string; service: string }> = []
    const peer = sellerPeer(SELLER_A_WALLET, 7)
    const cohort = Array.from({ length: 257 }, () => peer)
    const result = await runCohortAudit(
      node, identity, registry.client, SERVICE, cohort, undefined,
      baseOptions(dirs, {
        probesPerAudit: 1,
        maxProbesPerRequest: 1,
        probeExecutor: honestExecutor(new Map([[peer.peerId, SELLER_A_WALLET]]), executorCalls),
      }),
    )
    assert.equal(result, null)
    assert.equal(registry.commits.length, 0)
    assert.equal(executorCalls.length, 0)
  })
})

test('rotation exhaustion expires the oldest exclusions instead of throwing', async () => {
  await withTempDirs(async (dirs) => {
    // Burn the ENTIRE bank pool into the rotation log.
    const source = probeBankSource()
    const allIds = source.generate({ count: source.size, seed: 'ab'.repeat(32) }).map((p) => p.id)
    await recordUsedProbeIds(dirs.probeLogDir, SERVICE, allIds, source.size + 10, new Date().toISOString())

    const registry = fakeRegistry()
    const peer = sellerPeer(SELLER_A_WALLET, 7)
    const result = await runCohortAudit(
      node, identity, registry.client, SERVICE, [peer], undefined,
      baseOptions(dirs, {
        probesPerAudit: 4,
        probeRotationHistory: source.size + 10,
        probeExecutor: honestExecutor(new Map([[peer.peerId, SELLER_A_WALLET]])),
      }),
    )
    assert.ok(result !== null, 'audit must proceed on a recycled pool')
    assert.equal(registry.commits.length, 1)
    assert.equal(result.outcomes.length, 1)
  })
})

test('rotation log records probes only AFTER they are sent (aborted commit burns nothing)', async () => {
  await withTempDirs(async (dirs) => {
    const registry = fakeRegistry({ commitError: new Error('rpc down') })
    const peer = sellerPeer(SELLER_A_WALLET, 7)
    await assert.rejects(
      runCohortAudit(
        node, identity, registry.client, SERVICE, [peer], undefined,
        baseOptions(dirs, {
          probeRotationHistory: 2000,
          probeExecutor: honestExecutor(new Map([[peer.peerId, SELLER_A_WALLET]])),
        }),
      ),
      /rpc down/,
    )
    const used = await loadUsedProbeIds(dirs.probeLogDir, SERVICE)
    assert.equal(used.size, 0, 'never-revealed probes must not be excluded from future rounds')
  })
})

test('rotation log records revealed probes after a completed audit', async () => {
  await withTempDirs(async (dirs) => {
    const registry = fakeRegistry()
    const peer = sellerPeer(SELLER_A_WALLET, 7)
    const result = await runCohortAudit(
      node, identity, registry.client, SERVICE, [peer], undefined,
      baseOptions(dirs, {
        probeRotationHistory: 2000,
        probeExecutor: honestExecutor(new Map([[peer.peerId, SELLER_A_WALLET]])),
      }),
    )
    assert.ok(result !== null)
    const used = await loadUsedProbeIds(dirs.probeLogDir, SERVICE)
    assert.equal(used.size, 4)
  })
})

test('one seller failing to probe does not discard the cohort audit', async () => {
  await withTempDirs(async (dirs) => {
    const registry = fakeRegistry()
    const peerA = sellerPeer(SELLER_A_WALLET, 7)
    const peerB = sellerPeer(SELLER_B_WALLET, 8)
    const honest = honestExecutor(new Map([[peerB.peerId, SELLER_B_WALLET]]))
    const executor: ProbeExecutor = async (peer, service, probeSet, maxPerRequest) => {
      if (peer.peerId === peerA.peerId) throw new Error('no delegates available')
      return honest(peer, service, probeSet, maxPerRequest)
    }
    const result = await runCohortAudit(
      node, identity, registry.client, SERVICE, [peerA, peerB], undefined,
      baseOptions(dirs, { probeExecutor: executor }),
    )
    assert.ok(result !== null)
    assert.equal(result.outcomes.length, 2)
    const outcomeA = result.outcomes.find((o) => o.peerId === peerA.peerId)!
    const outcomeB = result.outcomes.find((o) => o.peerId === peerB.peerId)!
    assert.equal(outcomeA.attested, false)
    assert.equal(outcomeA.credited, false)
    assert.equal(outcomeA.fullyAuthenticated, false)
    // The completed seller still gets evidence + attestation.
    assert.equal(outcomeB.attested, true)
    assert.ok(registry.attestations.some((a) => Number(a.agentId) === 8))
    assert.ok(!registry.attestations.some((a) => Number(a.agentId) === 7))
  })
})

test('attested but uncredited submissions are marked credited=false', async () => {
  await withTempDirs(async (dirs) => {
    // agent 7 credits, agent 8 is refused credit (cooldown / epoch cap).
    const registry = fakeRegistry({ creditOnSubmit: (agentId) => agentId === 7 })
    const peerA = sellerPeer(SELLER_A_WALLET, 7)
    const peerB = sellerPeer(SELLER_B_WALLET, 8)
    const executor = honestExecutor(new Map([
      [peerA.peerId, SELLER_A_WALLET],
      [peerB.peerId, SELLER_B_WALLET],
    ]))
    const result = await runCohortAudit(
      node, identity, registry.client, SERVICE, [peerA, peerB], undefined,
      baseOptions(dirs, { probeExecutor: executor }),
    )
    assert.ok(result !== null)
    const outcomeA = result.outcomes.find((o) => o.peerId === peerA.peerId)!
    const outcomeB = result.outcomes.find((o) => o.peerId === peerB.peerId)!
    assert.equal(outcomeA.attested, true)
    assert.equal(outcomeA.credited, true)
    assert.equal(outcomeB.attested, true)
    assert.equal(outcomeB.credited, false, 'tx success without credit must not count against the budget')
  })
})

test('probes go out with the advertised spelling; normalized name stays the bundle key', async () => {
  await withTempDirs(async (dirs) => {
    const registry = fakeRegistry()
    const peerA = sellerPeer(SELLER_A_WALLET, 7)
    const peerB = sellerPeer(SELLER_B_WALLET, 8)
    const calls: Array<{ peerId: string; service: string }> = []
    const executor = honestExecutor(new Map([
      [peerA.peerId, SELLER_A_WALLET],
      [peerB.peerId, SELLER_B_WALLET],
    ]), calls)
    const result = await runCohortAudit(
      node, identity, registry.client, SERVICE, [peerA, peerB], undefined,
      baseOptions(dirs, {
        probeExecutor: executor,
        advertisedService: 'Kimi-K2',
        advertisedByPeer: new Map([[peerB.peerId, 'KIMI-k2']]),
      }),
    )
    assert.ok(result !== null)
    assert.equal(calls.find((c) => c.peerId === peerA.peerId)?.service, 'Kimi-K2')
    assert.equal(calls.find((c) => c.peerId === peerB.peerId)?.service, 'KIMI-k2')
    assert.equal(result.service, SERVICE)
    const bundle = JSON.parse(await readFile(result.packPath, 'utf8')) as { service: string }
    assert.equal(bundle.service, SERVICE)
  })
})

test('a persisted evidence bundle is re-verifiable with no daemon state', async () => {
  await withTempDirs(async (dirs) => {
    const registry = fakeRegistry()
    const peer = sellerPeer(SELLER_A_WALLET, 7)
    const result = await runCohortAudit(
      node, identity, registry.client, SERVICE, [peer], undefined,
      baseOptions(dirs, {
        probeExecutor: honestExecutor(new Map([[peer.peerId, SELLER_A_WALLET]])),
        advertisedService: 'Kimi-K2',
      }),
    )
    assert.ok(result !== null)

    // Load the bundle fresh from disk — nothing but the file.
    const bundle = JSON.parse(await readFile(result.packPath, 'utf8')) as {
      sellers: Array<{ sellerPeerId: string; exchanges: ProbeExchangeEvidence[] }>
    }
    const seller = bundle.sellers[0]!
    assert.ok(seller.exchanges.length > 0, 'bundle must persist the full exchanges')

    for (const exchange of seller.exchanges) {
      const auth = exchange.responseAuth as ResponseAuthPayload
      assert.ok(auth, 'bundle must persist the complete signed ResponseAuth payload')
      assert.ok(exchange.response, 'bundle must persist the exact response material')
      // Recompute both hashes from the persisted request/response bytes and
      // verify the seller signature end-to-end.
      const request: SerializedHttpRequest = {
        requestId: exchange.requestId,
        method: exchange.request.method,
        path: exchange.request.path,
        headers: exchange.request.headers,
        body: new Uint8Array(Buffer.from(exchange.request.bodyBase64, 'base64')),
      }
      const response: SerializedHttpResponse = {
        requestId: exchange.requestId,
        statusCode: exchange.response.statusCode,
        headers: exchange.response.headers,
        body: new Uint8Array(Buffer.from(exchange.response.bodyBase64, 'base64')),
      }
      const verification = verifyResponseAuth(auth, {
        request,
        response,
        buyerPeerId: auth.buyerPeerId,
        sellerPeerId: seller.sellerPeerId,
        advertisedService: auth.advertisedService,
      })
      assert.equal(verification.valid, true, `bundle exchange must re-verify: ${verification.reason ?? ''}`)

      // Tampered response bytes must fail verification.
      const tampered = verifyResponseAuth(auth, {
        request,
        response: { ...response, body: new TextEncoder().encode('{"choices":[]}') },
        buyerPeerId: auth.buyerPeerId,
        sellerPeerId: seller.sellerPeerId,
        advertisedService: auth.advertisedService,
      })
      assert.equal(tampered.valid, false)
    }
  })
})

test('rejects dot-only service names before committing or probing', async () => {
  await withTempDirs(async (dirs) => {
    const registry = fakeRegistry()
    const peer = sellerPeer(SELLER_A_WALLET, 7)
    await assert.rejects(
      runCohortAudit(
        node, identity, registry.client, '..', [peer], undefined,
        baseOptions(dirs, { probeExecutor: honestExecutor(new Map([[peer.peerId, SELLER_A_WALLET]])) }),
      ),
      /unsafe service name/,
    )
    assert.equal(registry.commits.length, 0)
  })
})

// ---------------------------------------------------------------------------
// Transparent audits: commit → anchor → attest → reveal sequencing
// ---------------------------------------------------------------------------

function sha256Bytes32(text: string): string {
  return '0x' + createHash('sha256').update(text, 'utf8').digest('hex')
}

test('sequencing: anchor strictly before attestations, reveal strictly after; batchRoot threaded into every attestation', async () => {
  await withTempDirs(async (dirs) => {
    const registry = fakeRegistry()
    const peerA = sellerPeer(SELLER_A_WALLET, 7)
    const peerB = sellerPeer(SELLER_B_WALLET, 8)
    const executor = honestExecutor(new Map([
      [peerA.peerId, SELLER_A_WALLET],
      [peerB.peerId, SELLER_B_WALLET],
    ]))
    const result = await runCohortAudit(
      node, identity, registry.client, SERVICE, [peerA, peerB], undefined,
      baseOptions(dirs, { probeExecutor: executor }),
    )
    assert.ok(result !== null)

    // Exact on-chain call order for the round.
    assert.deepEqual(registry.sequence, ['commit', 'anchor', 'attest', 'attest', 'reveal'])

    // One batch per round, bound to the round's probe commitment, carrying
    // every verified exchange of every seller.
    assert.equal(registry.anchors.length, 1)
    const anchor = registry.anchors[0]!
    assert.equal(anchor.probeCommitment, result.probeCommitment)
    assert.equal(anchor.records.length, 2)
    assert.deepEqual(
      [...anchor.records.map((r) => Number(r.agentId))].sort(),
      [7, 8],
    )
    assert.equal(result.batchRoot, anchor.batchRoot)

    // Declared probe evidence is the BATCH-WIDE sum over anchored records:
    // each seller's single request bundled all 4 probes, so 2 sellers = 8 —
    // larger than any per-seller probe count, and >= records.length.
    assert.equal(anchor.probeCount, 8)

    // Per-record signing preimages and probe counts are aligned with the
    // records: the contract verifies each seller signature over its payload
    // and reverts on any bad one, so every anchored record carries both.
    assert.equal(anchor.signingPayloads.length, anchor.records.length)
    assert.equal(anchor.recordProbeCounts.length, anchor.records.length)
    for (const payload of anchor.signingPayloads) {
      assert.ok(payload instanceof Uint8Array && payload.length > 0)
    }
    assert.deepEqual(anchor.recordProbeCounts, [4, 4])

    // The SAME anchored root reaches every attestation of the round.
    assert.equal(registry.attestations.length, 2)
    for (const attestation of registry.attestations) {
      assert.equal(attestation.batchRoot, anchor.batchRoot)
      assert.equal(attestation.evidenceHash, result.evidenceHash)
    }
  })
})

test('anchor probeCount: sums per-request bundle sizes over ANCHORED records only (partially-authenticated seller)', async () => {
  await withTempDirs(async (dirs) => {
    const registry = fakeRegistry()
    const peerA = sellerPeer(SELLER_A_WALLET, 7)
    const peerB = sellerPeer(SELLER_B_WALLET, 8)

    // Signed exchange factory: one verifiable request/response pair per call,
    // returning both the full ResponseAuth payload and its evidence record.
    const makeExchange = (
      wallet: Wallet,
      sellerPeerId: string,
      requestId: string,
    ): { auth: ResponseAuthPayload; exchange: ProbeExchangeEvidence } => {
      const bodyBytes = new TextEncoder().encode(JSON.stringify({ model: SERVICE, messages: [] }))
      const request: SerializedHttpRequest = {
        requestId,
        method: 'POST',
        path: '/v1/chat/completions',
        headers: { 'content-type': 'application/json' },
        body: bodyBytes,
      }
      const responseBody = new TextEncoder().encode('{"choices":[{"message":{"content":"42"}}]}')
      const response: SerializedHttpResponse = {
        requestId,
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: responseBody,
      }
      const auth = createResponseAuthPayload({
        request,
        response,
        buyerPeerId: VERIFIER_WALLET.address,
        sellerPeerId,
        advertisedService: SERVICE,
        provider: 'openai',
        responseStartedAt: 1,
        responseCompletedAt: 2,
      }, wallet)
      const exchange: ProbeExchangeEvidence = {
        requestId,
        request: {
          method: request.method,
          path: request.path,
          headers: { ...request.headers },
          bodyBase64: Buffer.from(bodyBytes).toString('base64'),
        },
        response: {
          statusCode: 200,
          headers: { ...response.headers },
          bodyBase64: Buffer.from(responseBody).toString('base64'),
        },
        responseAuth: auth,
      }
      return { auth, exchange }
    }

    // Seller A: two requests bundling 2+2 probes, BOTH authenticated → 4.
    // Seller B: two requests bundling 3+1 probes, only the 3-probe request
    // authenticated → contributes 3, NOT its full per-seller probe count of 4.
    const unauthedExchange = (requestId: string): ProbeExchangeEvidence => ({
      requestId,
      request: { method: 'POST', path: '/v1/chat/completions', headers: {}, bodyBase64: '' },
      response: null,
      responseAuth: null,
    })
    const executor: ProbeExecutor = async (target, _svc, probeSet) => {
      const isA = target.peerId === peerA.peerId
      const wallet = isA ? SELLER_A_WALLET : SELLER_B_WALLET
      const reqId1 = `req-${target.peerId.slice(0, 6)}-1`
      const reqId2 = `req-${target.peerId.slice(0, 6)}-2`
      const first = makeExchange(wallet, target.peerId, reqId1)
      const second = isA ? makeExchange(wallet, target.peerId, reqId2) : null
      return {
        run: {
          peerId: target.peerId,
          agentId: target.onChainAgentId,
          answers: new Array<number | null>(probeSet.probes.length).fill(42),
          requestIds: [reqId1, reqId2],
          probesPerRequest: isA ? [2, 2] : [3, 1],
          responseAuths: [
            { requestHash: first.auth.requestHash, responseHash: first.auth.responseHash, signature: first.auth.signature },
            second ? { requestHash: second.auth.requestHash, responseHash: second.auth.responseHash, signature: second.auth.signature } : null,
          ],
          exchanges: [first.exchange, second ? second.exchange : unauthedExchange(reqId2)],
          fullyAuthenticated: isA,
          errors: isA ? [] : ['request req-2: seller never produced a ResponseAuth'],
        },
      }
    }

    const result = await runCohortAudit(
      node, identity, registry.client, SERVICE, [peerA, peerB], undefined,
      baseOptions(dirs, { probeExecutor: executor }),
    )
    assert.ok(result !== null)
    assert.equal(registry.anchors.length, 1)
    const anchor = registry.anchors[0]!
    // 3 anchored records (A×2 + B×1) evidencing 2+2+3 = 7 probes.
    assert.equal(anchor.records.length, 3)
    assert.equal(anchor.probeCount, 7)
  })
})

test('reveal: the revealed bytes hash to the committed probe commitment (on-chain opening holds)', async () => {
  await withTempDirs(async (dirs) => {
    const registry = fakeRegistry()
    const peer = sellerPeer(SELLER_A_WALLET, 7)
    const result = await runCohortAudit(
      node, identity, registry.client, SERVICE, [peer], undefined,
      baseOptions(dirs, {
        probeExecutor: honestExecutor(new Map([[peer.peerId, SELLER_A_WALLET]])),
        revealDelayMs: 0,
      }),
    )
    assert.ok(result !== null)
    assert.equal(registry.reveals.length, 1)
    const reveal = registry.reveals[0]!
    assert.equal(reveal.probeCommitment, result.probeCommitment)
    // sha256(revealed canonical bytes) == commitment — exactly what the
    // contract checks in revealProbeSet.
    assert.equal(sha256Bytes32(reveal.probeSetJson), registry.commits[0])
    // The revealed JSON is a well-formed {service, probes, nonce} opening.
    const parsed = JSON.parse(reveal.probeSetJson) as { service: string; probes: unknown[]; nonce: string }
    assert.equal(parsed.service, SERVICE)
    assert.equal(parsed.probes.length, 4)
    assert.equal(typeof parsed.nonce, 'string')
    assert.ok(result.revealTx)
  })
})

test('pack: written to <publishDir>/<commitment>.json as canonical bytes whose sha256 IS the evidenceHash', async () => {
  await withTempDirs(async (dirs) => {
    const registry = fakeRegistry()
    const peer = sellerPeer(SELLER_A_WALLET, 7)
    const result = await runCohortAudit(
      node, identity, registry.client, SERVICE, [peer], undefined,
      baseOptions(dirs, { probeExecutor: honestExecutor(new Map([[peer.peerId, SELLER_A_WALLET]])) }),
    )
    assert.ok(result !== null)
    assert.equal(result.packPath, join(dirs.publishDir, `${result.probeCommitment.toLowerCase()}.json`))
    const bytes = await readFile(result.packPath, 'utf8')
    assert.equal(sha256Bytes32(bytes), result.evidenceHash)
  })
})

test('anchor failure: no attestations, no reveal — the pack is still published', async () => {
  await withTempDirs(async (dirs) => {
    const registry = fakeRegistry({ anchorError: new Error('anchor rpc down') })
    const peer = sellerPeer(SELLER_A_WALLET, 7)
    const result = await runCohortAudit(
      node, identity, registry.client, SERVICE, [peer], undefined,
      baseOptions(dirs, { probeExecutor: honestExecutor(new Map([[peer.peerId, SELLER_A_WALLET]])) }),
    )
    assert.ok(result !== null)
    assert.equal(registry.attestations.length, 0, 'an unanchored batch must never be attested')
    assert.equal(registry.reveals.length, 0, 'probes must never be revealed without an attested batch')
    assert.equal(result.batchRoot, undefined)
    assert.ok(result.outcomes.every((o) => !o.attested))
    // Evidence still persists locally for a later retry / manual inspection.
    const bytes = await readFile(result.packPath, 'utf8')
    assert.equal(sha256Bytes32(bytes), result.evidenceHash)
  })
})

test('nothing verified means nothing anchored, attested, or revealed', async () => {
  await withTempDirs(async (dirs) => {
    const registry = fakeRegistry()
    const peer = sellerPeer(SELLER_A_WALLET, 7)
    const unverifiedExecutor: ProbeExecutor = async (target, _svc, probeSet) => ({
      run: {
        peerId: target.peerId,
        agentId: target.onChainAgentId,
        answers: new Array<number | null>(probeSet.probes.length).fill(null),
        requestIds: ['req-1'],
        probesPerRequest: [probeSet.probes.length],
        responseAuths: [null],
        exchanges: [],
        fullyAuthenticated: false,
        errors: ['seller never produced a ResponseAuth'],
      },
    })
    const result = await runCohortAudit(
      node, identity, registry.client, SERVICE, [peer], undefined,
      baseOptions(dirs, { probeExecutor: unverifiedExecutor }),
    )
    assert.ok(result !== null)
    assert.deepEqual(registry.sequence, ['commit'])
    assert.equal(result.batchRoot, undefined)
  })
})

test('reveal failure is tolerated: the audit result stands, attestations included', async () => {
  await withTempDirs(async (dirs) => {
    const registry = fakeRegistry({ revealError: new Error('reveal rpc down') })
    const peer = sellerPeer(SELLER_A_WALLET, 7)
    const result = await runCohortAudit(
      node, identity, registry.client, SERVICE, [peer], undefined,
      baseOptions(dirs, { probeExecutor: honestExecutor(new Map([[peer.peerId, SELLER_A_WALLET]])) }),
    )
    assert.ok(result !== null)
    assert.equal(registry.attestations.length, 1)
    assert.equal(result.revealTx, undefined)
    assert.ok(result.outcomes[0]!.attested)
  })
})

// ---------------------------------------------------------------------------
// Durable pending-reveal queue: failed reveals retry across rounds/restarts,
// revealDelayMs is a due time (never an inline sleep in the audit loop)
// ---------------------------------------------------------------------------

test('a failed reveal is persisted and retried by the next round drain (queue survives re-instantiation)', async () => {
  await withTempDirs(async (dirs) => {
    // Mutable registry options: the same fake registry recovers mid-test.
    const registryOptions: { revealError?: Error } = { revealError: new Error('reveal rpc down') }
    const registry = fakeRegistry(registryOptions)
    const peer = sellerPeer(SELLER_A_WALLET, 7)
    const result = await runCohortAudit(
      node, identity, registry.client, SERVICE, [peer], undefined,
      baseOptions(dirs, { probeExecutor: honestExecutor(new Map([[peer.peerId, SELLER_A_WALLET]])) }),
    )
    assert.ok(result !== null)
    assert.equal(registry.reveals.length, 0)
    assert.equal(result.revealTx, undefined)

    // The reveal is queued on disk, not forgotten.
    const queued = await loadPendingReveals(dirs.revealQueueDir)
    assert.equal(queued.length, 1)
    assert.equal(queued[0]!.probeCommitment, result.probeCommitment)
    assert.equal(sha256Bytes32(queued[0]!.probeSetJson), result.probeCommitment)

    // "Restart": the RPC recovers, and a fresh drain (round start / daemon
    // startup) re-reads the queue from disk alone and lands the reveal.
    delete registryOptions.revealError
    const revealed = await drainPendingReveals(identity, registry.client, queueOptions(dirs))
    assert.equal(revealed.get(result.probeCommitment), '0x' + 'd'.repeat(64))
    assert.equal(registry.reveals.length, 1)
    assert.equal(sha256Bytes32(registry.reveals[0]!.probeSetJson), result.probeCommitment)
    assert.equal((await loadPendingReveals(dirs.revealQueueDir)).length, 0, 'a landed reveal leaves the queue')

    // A landed reveal is never re-attempted.
    const again = await drainPendingReveals(identity, registry.client, queueOptions(dirs))
    assert.equal(again.size, 0)
    assert.equal(registry.reveals.length, 1)
  })
})

test('revealDelayMs queues the reveal with a due time: never sent before dueAt, sent by the first drain past it', async () => {
  await withTempDirs(async (dirs) => {
    const registry = fakeRegistry()
    const peer = sellerPeer(SELLER_A_WALLET, 7)
    const before = Date.now()
    const result = await runCohortAudit(
      node, identity, registry.client, SERVICE, [peer], undefined,
      baseOptions(dirs, {
        probeExecutor: honestExecutor(new Map([[peer.peerId, SELLER_A_WALLET]])),
        revealDelayMs: 60_000,
      }),
    )
    assert.ok(result !== null)
    // No inline sleep: the round returns immediately with the reveal queued.
    assert.ok(Date.now() - before < 60_000, 'the audit loop must not block on revealDelayMs')
    assert.equal(registry.reveals.length, 0, 'a delayed reveal must not be sent in-round')
    assert.equal(result.revealTx, undefined)
    const queued = await loadPendingReveals(dirs.revealQueueDir)
    assert.equal(queued.length, 1)

    // A drain before the due time leaves the entry queued and unsent.
    const early = await drainPendingReveals(identity, registry.client, queueOptions(dirs))
    assert.equal(early.size, 0)
    assert.equal(registry.reveals.length, 0)
    assert.equal((await loadPendingReveals(dirs.revealQueueDir)).length, 1)

    // The first drain past dueAt sends it.
    const late = await drainPendingReveals(identity, registry.client, queueOptions(dirs), Date.now() + 61_000)
    assert.equal(late.get(result.probeCommitment), '0x' + 'd'.repeat(64))
    assert.equal(registry.reveals.length, 1)
    assert.equal(sha256Bytes32(registry.reveals[0]!.probeSetJson), result.probeCommitment)
    assert.equal((await loadPendingReveals(dirs.revealQueueDir)).length, 0)
  })
})

// ---------------------------------------------------------------------------
// LLM probe source (transparent-audit generation) — author, fallback, rotation dedupe
// ---------------------------------------------------------------------------

function authoredProbe(i: number) {
  return {
    id: `llm:test:${i}`,
    name: `authored-${i}`,
    domain: 'test',
    template: `The certified test value number ${i} is ___.`,
    consensus: i * 10,
    range: [0, 1_000] as [number, number],
    tolerance: { mode: 'absolute' as const, value: 1 },
  }
}

test('llm probe source: authored probes drive the audit and their ids land in the rotation log', async () => {
  await withTempDirs(async (dirs) => {
    const registry = fakeRegistry()
    const peer = sellerPeer(SELLER_A_WALLET, 7)
    const authorCalls: Array<{ service: string; count: number; exclude: ReadonlySet<string> }> = []
    // Seed the rotation log so the author observes prior reveals.
    await recordUsedProbeIds(dirs.probeLogDir, SERVICE, ['llm:test:99'], 2000, new Date().toISOString())

    const result = await runCohortAudit(
      node, identity, registry.client, SERVICE, [peer], undefined,
      baseOptions(dirs, {
        probeSource: 'llm',
        probeRotationHistory: 2000,
        probeAuthor: async (params) => {
          authorCalls.push(params)
          return [authoredProbe(1), authoredProbe(2), authoredProbe(3), authoredProbe(4)]
        },
        probeExecutor: honestExecutor(new Map([[peer.peerId, SELLER_A_WALLET]])),
      }),
    )
    assert.ok(result !== null)
    assert.equal(authorCalls.length, 1)
    assert.equal(authorCalls[0]!.service, SERVICE)
    assert.equal(authorCalls[0]!.count, 4)
    assert.ok(authorCalls[0]!.exclude.has('llm:test:99'), 'author must receive the rotation exclusions')

    // The committed probe set IS the authored one.
    const reveal = registry.reveals[0]!
    const parsed = JSON.parse(reveal.probeSetJson) as { probes: Array<{ id: string }> }
    assert.deepEqual(parsed.probes.map((p) => p.id).sort(), ['llm:test:1', 'llm:test:2', 'llm:test:3', 'llm:test:4'])

    // Revealed llm probes rotate like any non-certified source.
    const used = await loadUsedProbeIds(dirs.probeLogDir, SERVICE)
    for (const id of ['llm:test:1', 'llm:test:2', 'llm:test:3', 'llm:test:4']) {
      assert.ok(used.has(id), `${id} must be in the rotation log`)
    }
  })
})

test('llm probe source falls back to compositional when the author throws', async () => {
  await withTempDirs(async (dirs) => {
    const registry = fakeRegistry()
    const peer = sellerPeer(SELLER_A_WALLET, 7)
    const warned: string[] = []
    const result = await runCohortAudit(
      node, identity, registry.client, SERVICE, [peer], undefined,
      baseOptions(dirs, {
        probeSource: 'llm',
        probeAuthor: async () => { throw new Error('upstream exploded') },
        probeExecutor: honestExecutor(new Map([[peer.peerId, SELLER_A_WALLET]])),
        warn: (m) => { warned.push(m) },
      }),
    )
    assert.ok(result !== null, 'the audit must proceed on the fallback source')
    assert.equal(registry.commits.length, 1)
    assert.ok(warned.some((m) => m.includes('falling back to compositional')))
    const reveal = registry.reveals[0]!
    const parsed = JSON.parse(reveal.probeSetJson) as { probes: Array<{ id: string }> }
    assert.equal(parsed.probes.length, 4)
    assert.ok(parsed.probes.every((p) => !p.id.startsWith('llm:')), 'fallback probes are not llm-authored')
  })
})

test('llm probe source without a configured author warns and falls back', async () => {
  await withTempDirs(async (dirs) => {
    const registry = fakeRegistry()
    const peer = sellerPeer(SELLER_A_WALLET, 7)
    const warned: string[] = []
    const result = await runCohortAudit(
      node, identity, registry.client, SERVICE, [peer], undefined,
      baseOptions(dirs, {
        probeSource: 'llm',
        probeExecutor: honestExecutor(new Map([[peer.peerId, SELLER_A_WALLET]])),
        warn: (m) => { warned.push(m) },
      }),
    )
    assert.ok(result !== null)
    assert.ok(warned.some((m) => m.includes('no probe author configured')))
  })
})

// ---------------------------------------------------------------------------
// combineVerdicts (HIGH-3): a trusted reference overrides the cohort BOTH ways
// ---------------------------------------------------------------------------

test('combineVerdicts: reference DIFF and reference SAME both override the cohort', () => {
  // Reference DIFF is adverse evidence a colluding cohort cannot bury.
  assert.equal(combineVerdicts('SAME', 'DIFF'), 'DIFF')
  assert.equal(combineVerdicts('UNDETERMINED', 'DIFF'), 'DIFF')
  // Reference SAME EXONERATES — even over a (possibly poisoned) cohort DIFF.
  assert.equal(combineVerdicts('DIFF', 'SAME'), 'SAME')
  assert.equal(combineVerdicts('UNDETERMINED', 'SAME'), 'SAME')
  // No/insufficient reference signal → the cohort stands.
  assert.equal(combineVerdicts('DIFF', undefined), 'DIFF')
  assert.equal(combineVerdicts('SAME', 'UNDETERMINED'), 'SAME')
  assert.equal(combineVerdicts('DIFF', 'UNKNOWN'), 'DIFF')
})

// ---------------------------------------------------------------------------
// selectCohort (H2): dedupe by agentId so the graded cohort, the anchored
// batch, and the pack stay in lockstep
// ---------------------------------------------------------------------------

test('selectCohort dedupes peers that share an agentId (keeps one), never crashing the round', async () => {
  const registry = fakeRegistry()
  // Two DISTINCT peerIds announcing the SAME on-chain agentId.
  const peerX = { ...sellerPeer(SELLER_A_WALLET, 7), peerId: 'aaaa' } as PeerInfo
  const peerY = { ...sellerPeer(SELLER_B_WALLET, 7), peerId: 'bbbb' } as PeerInfo
  const peerZ = sellerPeer(SELLER_B_WALLET, 8)
  const cohort = await selectCohort([peerX, peerY, peerZ], SERVICE, registry.client, {
    cohortMaxSize: 10,
    stalenessWindowSecs: 0,
    warn: noop,
  })
  const agentIds = cohort.map((p) => p.onChainAgentId).sort()
  assert.deepEqual(agentIds, [7, 8], 'agentId 7 must appear exactly once')
  assert.equal(cohort.length, 2)
})

// ---------------------------------------------------------------------------
// Reference burn-and-refresh: a reveal publishes certified probes WITH their
// expected answers, so a revealed reference must never grade again
// ---------------------------------------------------------------------------

function testReference(): FingerprintReference {
  // The honest executor answers 42 to everything, so a certified consensus of
  // 42 yields a reference SAME — exactly the exonerating verdict a replayed
  // reference would forge, which is why the burn matters.
  const probes = [1, 2, 3, 4].map((i) => ({ ...authoredProbe(i), id: `ref:test:${i}`, consensus: 42 }))
  return {
    version: 1,
    kind: 'kbf',
    referenceId: 'kbf:test-reference:v1',
    referenceModel: SERVICE,
    serviceAliases: [SERVICE],
    createdAt: new Date().toISOString(),
    source: 'generated',
    generator: { name: 'test', version: '1', verifierKind: 'kbf', params: {} },
    selfTest: { hamming: 0, total: 24, coverage: 1, errorRate: 0 },
    probes,
  }
}

test('a revealed reference is burned: ids join the rotation log and later rounds never reuse its probes', async () => {
  await withTempDirs(async (dirs) => {
    const registry = fakeRegistry()
    const peer = sellerPeer(SELLER_A_WALLET, 7)
    const reference = testReference()
    const executor = honestExecutor(new Map([[peer.peerId, SELLER_A_WALLET]]))

    // Round 1: fresh reference — reference-mode grading; the reveal burns it.
    const round1 = await runCohortAudit(
      node, identity, registry.client, SERVICE, [peer], reference,
      baseOptions(dirs, { probeRotationHistory: 2000, probeExecutor: executor }),
    )
    assert.ok(round1 !== null)
    assert.ok(round1.revealTx, 'round 1 must reveal')
    assert.equal(round1.outcomes[0]!.referenceVerdict, 'SAME', 'round 1 grades against the reference')
    const revealed1 = JSON.parse(registry.reveals[0]!.probeSetJson) as { probes: Array<{ id: string }> }
    assert.ok(revealed1.probes.every((p) => p.id.startsWith('ref:test:')), 'round 1 reveals the reference probes')

    // The reveal burned the reference and rotation-logged its probe ids, so
    // future LLM-authored selections exclude them too.
    assert.ok((await loadBurnedReferenceIds(dirs.probeLogDir, SERVICE)).has(reference.referenceId))
    const used = await loadUsedProbeIds(dirs.probeLogDir, SERVICE)
    for (const probe of reference.probes) {
      assert.ok(used.has(probe.id), `revealed reference probe ${probe.id} must be in the rotation log`)
    }

    // Round 2 hands over the SAME (now burned) reference: it must not be
    // reused — none of its probes go back on the wire, and it can no longer
    // produce the reference SAME that would override a cohort DIFF.
    const warned: string[] = []
    const round2 = await runCohortAudit(
      node, identity, registry.client, SERVICE, [peer], reference,
      baseOptions(dirs, {
        probeRotationHistory: 2000,
        probeExecutor: executor,
        warn: (m) => { warned.push(m) },
      }),
    )
    assert.ok(round2 !== null)
    assert.equal(round2.outcomes[0]!.referenceVerdict, undefined, 'a burned reference must not produce a reference verdict')
    assert.ok(warned.some((m) => m.includes('burned')), 'the fallback must be surfaced to the operator')
    assert.equal(registry.reveals.length, 2, 'round 2 still audits (cohort-only) and reveals')
    const revealed2 = JSON.parse(registry.reveals[1]!.probeSetJson) as { probes: Array<{ id: string }> }
    assert.ok(revealed2.probes.every((p) => !p.id.startsWith('ref:test:')), 'burned reference probes must never be reused')
  })
})

test('burned reference with no fresh replacement falls back to cohort-only grading (pack carries no reference inputs)', async () => {
  await withTempDirs(async (dirs) => {
    const registry = fakeRegistry()
    const peer = sellerPeer(SELLER_A_WALLET, 7)
    const reference = testReference()
    const executor = honestExecutor(new Map([[peer.peerId, SELLER_A_WALLET]]))

    const round1 = await runCohortAudit(
      node, identity, registry.client, SERVICE, [peer], reference,
      baseOptions(dirs, { probeExecutor: executor }),
    )
    assert.ok(round1 !== null && round1.revealTx)
    const bundle1 = JSON.parse(await readFile(round1.packPath, 'utf8')) as { reference?: unknown }
    assert.ok(bundle1.reference, 'reference-mode pack persists the self-test inputs')

    const round2 = await runCohortAudit(
      node, identity, registry.client, SERVICE, [peer], reference,
      baseOptions(dirs, { probeExecutor: executor }),
    )
    assert.ok(round2 !== null)
    // Cohort-only: combined verdict IS the cohort verdict, no reference component.
    const outcome = round2.outcomes[0]!
    assert.equal(outcome.referenceVerdict, undefined)
    assert.equal(outcome.verdict, outcome.cohortVerdict)
    const bundle2 = JSON.parse(await readFile(round2.packPath, 'utf8')) as { reference?: unknown }
    assert.equal(bundle2.reference, undefined, 'a cohort-only pack must not claim reference-mode inputs')
  })
})

test('a reference is NOT burned while its reveal is still pending (burn happens when the reveal lands)', async () => {
  await withTempDirs(async (dirs) => {
    const registryOptions: { revealError?: Error } = { revealError: new Error('reveal rpc down') }
    const registry = fakeRegistry(registryOptions)
    const peer = sellerPeer(SELLER_A_WALLET, 7)
    const reference = testReference()
    const executor = honestExecutor(new Map([[peer.peerId, SELLER_A_WALLET]]))

    // Round 1's reveal fails: the probes are still private, so the reference
    // stays usable — but the queued reveal carries the burn instruction.
    const round1 = await runCohortAudit(
      node, identity, registry.client, SERVICE, [peer], reference,
      baseOptions(dirs, { probeRotationHistory: 2000, probeExecutor: executor }),
    )
    assert.ok(round1 !== null)
    assert.equal(round1.revealTx, undefined)
    assert.equal((await loadBurnedReferenceIds(dirs.probeLogDir, SERVICE)).size, 0, 'an unrevealed reference is not burned')
    const queued = await loadPendingReveals(dirs.revealQueueDir)
    assert.equal(queued[0]!.burnReference?.referenceId, reference.referenceId)

    // The retried reveal lands at the next drain — and burns the reference.
    delete registryOptions.revealError
    const revealed = await drainPendingReveals(
      identity, registry.client, queueOptions(dirs, { probeRotationHistory: 2000 }),
    )
    assert.equal(revealed.size, 1)
    assert.ok((await loadBurnedReferenceIds(dirs.probeLogDir, SERVICE)).has(reference.referenceId))
    const used = await loadUsedProbeIds(dirs.probeLogDir, SERVICE)
    for (const probe of reference.probes) assert.ok(used.has(probe.id))
  })
})

test('a full round over a cohort deduped to one agentId anchors, attests, and reveals without crashing', async () => {
  await withTempDirs(async (dirs) => {
    const registry = fakeRegistry()
    const peer = sellerPeer(SELLER_A_WALLET, 7)
    // Pre-dedupe upstream (selectCohort) means runCohortAudit sees one peer per
    // agentId; confirm the happy path is intact end-to-end.
    const cohort = await selectCohort([peer, { ...peer, peerId: 'dup' } as PeerInfo], SERVICE, registry.client, {
      cohortMaxSize: 10,
      stalenessWindowSecs: 0,
      warn: noop,
    })
    assert.equal(cohort.length, 1)
    const result = await runCohortAudit(
      node, identity, registry.client, SERVICE, cohort, undefined,
      baseOptions(dirs, { probeExecutor: honestExecutor(new Map([[peer.peerId, SELLER_A_WALLET]])) }),
    )
    assert.ok(result !== null)
    assert.equal(registry.anchors.length, 1)
    assert.equal(result.outcomes.length, 1)
    assert.equal(registry.reveals.length, 1)
  })
})
