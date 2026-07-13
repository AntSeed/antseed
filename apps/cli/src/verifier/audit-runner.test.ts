import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Wallet } from 'ethers'
import type { AntseedNode, Identity, PeerInfo, ResponseAuthPayload, SerializedHttpRequest, SerializedHttpResponse, VerifierRegistryClient } from '@antseed/node'
import { createResponseAuthPayload, verifyResponseAuth } from '@antseed/node'
import { probeBankSource } from '@antseed/fingerprints'
import { runCohortAudit } from './audit-runner.js'
import type { AuditRunnerOptions, ProbeExecutor } from './audit-runner.js'
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
  attestations: Array<{ agentId: number | bigint; probeCount: number }>
}

/**
 * Fake AntseedVerifierRegistry: records commits/attestations and lets tests
 * choose whether submissions actually CREDIT (advance lastCreditedAt) —
 * mirroring the contract's cooldown / epoch-cap behavior.
 */
function fakeRegistry(options?: {
  creditOnSubmit?: (agentId: number) => boolean
  commitError?: Error
}): FakeRegistry {
  const commits: string[] = []
  const attestations: Array<{ agentId: number | bigint; probeCount: number }> = []
  const creditedAt = new Map<number, number>()
  const client = {
    async lastCreditedAt(agentId: number | bigint): Promise<number> {
      return creditedAt.get(Number(agentId)) ?? 0
    },
    async commitProbeSet(_wallet: unknown, commitment: string): Promise<string> {
      if (options?.commitError) throw options.commitError
      commits.push(commitment)
      return '0x' + 'c'.repeat(64)
    },
    async submitAttestation(_wallet: unknown, input: { agentId: number | bigint; probeCount: number }): Promise<string> {
      attestations.push(input)
      const agentId = Number(input.agentId)
      if (options?.creditOnSubmit?.(agentId) ?? true) {
        creditedAt.set(agentId, Math.floor(Date.now() / 1000))
      }
      return '0x' + 'a'.repeat(64)
    },
  } as unknown as VerifierRegistryClient
  return { client, commits, attestations }
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
      responseAuths: [{ requestHash: auth.requestHash, responseHash: auth.responseHash, signature: auth.signature }],
      exchanges: [exchange],
      fullyAuthenticated: true,
      errors: [],
    }
    return { run }
  }
}

async function withTempDirs(fn: (dirs: { evidenceDir: string; probeLogDir: string }) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'antseed-audit-runner-'))
  try {
    await fn({ evidenceDir: join(root, 'evidence'), probeLogDir: join(root, 'probe-log') })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

function baseOptions(dirs: { evidenceDir: string; probeLogDir: string }, overrides?: Partial<AuditRunnerOptions>): AuditRunnerOptions {
  return {
    probesPerAudit: 4,
    minProbeCount: 1,
    cohortMinSize: 1,
    cohortMaxSize: 10,
    stalenessWindowSecs: 0,
    maxProbesPerRequest: 3,
    evidenceDir: dirs.evidenceDir,
    probeSource: 'bank',
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
    const bundle = JSON.parse(await readFile(result.evidencePath, 'utf8')) as { service: string }
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
    const bundle = JSON.parse(await readFile(result.evidencePath, 'utf8')) as {
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
