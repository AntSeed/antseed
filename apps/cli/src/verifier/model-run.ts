import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import type { AbstractSigner } from 'ethers'
import {
  KBF_PROBES_PER_REQUEST,
  verifyKbf,
  buildKbfChatRequestBody,
  canonicalHashBytes32,
  canonicalJsonStringify,
  computeMatchVector,
  parseKbfAnswers,
  queryProfileHash,
  type KbfProbe,
  type KbfReferenceV1,
  type MatchVector,
} from '@antseed/fingerprints'
import {
  CONNECTION_CAPABILITY_RESPONSE_AUTH_V1,
  VERIFIER_VERDICT_DIFF,
  VERIFIER_VERDICT_SAME,
  VERIFIER_VERDICT_UNDETERMINED,
  hashRequest,
  hashResponse,
  peerIdToAddress,
  serviceHash,
  toResponseAuthPayload,
  type AntseedNode,
  type BuyerResponsePaymentEvidence,
  type PeerInfo,
  type StoredResponseAuth,
  type VerifierRegistryClient,
  type VerifierVerdict,
} from '@antseed/node'
import {
  deriveDirectAuditId,
  writeDirectAuditEvidence,
  type DirectAuditEvidenceExchange,
  type DirectAuditEvidenceV1,
} from './direct-evidence.js'
import { advertisedServices } from './service-discovery.js'

export const VERIFICATION_PROBE_COUNT = 100
const PROBE_REQUEST_CONCURRENCY = 2

export interface VerificationSpendLimit {
  maximumUsdc: bigint
  spentUsdc: bigint
  maximumPerRequestUsdc: bigint
}

export interface ModelVerificationContext {
  node: Pick<AntseedNode, 'sendRequest' | 'waitForResponseAuth' | 'finalizeResponsePayment'>
  verifierAddress: string
  verifierPeerId: string
  evidenceDir: string
  requestTimeoutMs: number
  spend: VerificationSpendLimit
}

export interface ModelVerificationTargetResult {
  peerId: string
  agentId: string
  service: string
  status: 'SAME' | 'DIFF' | 'UNDETERMINED'
  auditId: string
  authenticatedProbeCount: number
  probeCount: number
  sellerChargeUsdc: string
  evidencePath: string
  evidenceHash: string
  attestationTxHash: string | null
}

export interface ModelVerificationFailure {
  peerId: string
  agentId: string | null
  service: string
  status: 'FAILED' | 'INELIGIBLE'
  reason: string
}

export interface ModelVerificationRunSummary {
  version: 1
  kind: 'antseed-model-verification-run'
  runId: string
  model: string
  mode: 'benchmark' | 'attest'
  referenceId: string
  probeCount: 100
  startedAt: string
  completedAt: string
  maximumSpendUsdc: string
  spentUsdc: string
  results: ModelVerificationTargetResult[]
  failures: ModelVerificationFailure[]
}

export function classifyVerificationTarget(
  peer: PeerInfo,
  verifierAddress: string,
  normalizedModel: string,
): { eligible: true; service: string } | { eligible: false; reason: string } {
  if (!peer.onChainAgentId) return { eligible: false, reason: 'missing on-chain agent id' }
  if (!peer.onChainSellerAddress) return { eligible: false, reason: 'missing verified on-chain seller address' }
  if (peerIdToAddress(peer.peerId).toLowerCase() === verifierAddress.toLowerCase()) {
    return { eligible: false, reason: 'self peer' }
  }
  if (!peer.capabilities?.includes(CONNECTION_CAPABILITY_RESPONSE_AUTH_V1)) {
    return { eligible: false, reason: 'missing verification.response-auth.v1' }
  }
  const service = advertisedServices(peer).get(normalizedModel)
  return service ? { eligible: true, service } : { eligible: false, reason: 'model no longer advertised' }
}

export async function verifyModelTarget(input: {
  context: ModelVerificationContext
  target: PeerInfo
  service: string
  reference: KbfReferenceV1
  registryClient?: VerifierRegistryClient
  signer?: AbstractSigner
  epoch?: bigint
}): Promise<ModelVerificationTargetResult> {
  if (!input.target.onChainAgentId || !input.target.onChainSellerAddress) {
    throw new Error('target lacks on-chain seller identity')
  }
  if (input.reference.probes.length !== VERIFICATION_PROBE_COUNT) {
    throw new Error(`reference must contain exactly ${VERIFICATION_PROBE_COUNT} probes`)
  }

  const startedAt = Date.now()
  const batches = chunk(input.reference.probes, KBF_PROBES_PER_REQUEST)
  const maximumTargetSpend = BigInt(batches.length) * input.context.spend.maximumPerRequestUsdc
  if (input.context.spend.spentUsdc + maximumTargetSpend > input.context.spend.maximumUsdc) {
    throw new Error('configured verifier.maxTotalSpendUSDC cannot cover this target')
  }

  const exchanges = await runConcurrently(batches, PROBE_REQUEST_CONCURRENCY, (probes) => {
    return executeProbeBatch(input.context, input.target, input.service, input.reference, probes)
  })

  const answers = exchanges.flatMap((exchange) => exchange.answers)
  const matchVector = computeMatchVector(answers, input.reference.probes)
  const authenticatedProbeCount = exchanges
    .filter((exchange) => exchange.status === 'succeeded')
    .reduce((total, exchange) => total + exchange.probeIds.length, 0)
  if (authenticatedProbeCount !== VERIFICATION_PROBE_COUNT) {
    throw new Error(`only ${authenticatedProbeCount}/${VERIFICATION_PROBE_COUNT} probes were authenticated`)
  }

  const fragment = verifyKbf(input.reference, {
    answers,
    matchVector,
  })
  if (fragment.verdict === 'UNKNOWN') throw new Error(fragment.verdictReason ?? 'verification returned UNKNOWN')
  const completedAt = Date.now()
  const evidence: DirectAuditEvidenceV1 = {
    version: 1,
    kind: 'antseed-direct-kbf-audit',
    createdAt: new Date(completedAt).toISOString(),
    verifier: { peerId: input.context.verifierPeerId, address: input.context.verifierAddress },
    target: {
      peerId: input.target.peerId,
      agentId: String(input.target.onChainAgentId),
      sellerAddress: input.target.onChainSellerAddress,
      service: input.service,
      serviceHash: serviceHash(input.service),
    },
    reference: {
      referenceId: input.reference.referenceId,
      referenceModel: input.reference.referenceModel,
      queryProfileHash: queryProfileHash(input.reference.queryProfile),
      queryProfile: input.reference.queryProfile,
      statisticalPower: input.reference.statisticalPower,
      statisticalPowerEvidence: input.reference.statisticalPowerEvidence as unknown as Record<string, unknown>,
      selfTest: input.reference.selfTest,
      probes: input.reference.probes,
    },
    exchanges,
    result: {
      selectedProbeCount: input.reference.probes.length,
      authenticatedProbeCount,
      parsedProbeCount: matchVector.filter((entry) => entry !== null).length,
      matchVector,
      matchVectorHash: fragment.matchVectorHash,
      stats: fragment.stats,
      verdict: fragment.verdict,
      verdictReason: fragment.verdictReason,
    },
  }
  const evidenceHash = canonicalHashBytes32(evidence)
  const auditId = deriveDirectAuditId({
    verifierAddress: input.context.verifierAddress,
    targetPeerId: input.target.peerId,
    agentId: String(input.target.onChainAgentId),
    serviceHash: evidence.target.serviceHash,
    completedAt,
    evidenceHash,
  })
  const written = await writeDirectAuditEvidence(input.context.evidenceDir, auditId, evidence)

  let attestationTxHash: string | null = null
  if (input.registryClient && input.signer) {
    const expectedEpoch = input.epoch ?? await input.registryClient.currentEpoch()
    attestationTxHash = await input.registryClient.submitVerificationResult(input.signer, {
      auditId,
      agentId: input.target.onChainAgentId,
      serviceHash: evidence.target.serviceHash,
      verdict: verdictCode(fragment.verdict),
      expectedEpoch,
      modelShareBps: 0,
      probeCount: authenticatedProbeCount,
      metrics: emptyMetrics(startedAt, completedAt),
      evidenceHash: written.evidenceHash,
    })
  }

  return {
    peerId: input.target.peerId,
    agentId: String(input.target.onChainAgentId),
    service: input.service,
    status: fragment.verdict,
    auditId,
    authenticatedProbeCount,
    probeCount: input.reference.probes.length,
    sellerChargeUsdc: exchanges.reduce((total, exchange) => total + BigInt(exchange.payment?.sellerChargeUsdc ?? '0'), 0n).toString(),
    evidencePath: written.path,
    evidenceHash: written.evidenceHash,
    attestationTxHash,
  }
}

async function executeProbeBatch(
  context: ModelVerificationContext,
  target: PeerInfo,
  service: string,
  reference: KbfReferenceV1,
  probes: KbfProbe[],
): Promise<DirectAuditEvidenceExchange> {
  if (context.spend.spentUsdc + context.spend.maximumPerRequestUsdc > context.spend.maximumUsdc) {
    throw new Error('configured verifier.maxTotalSpendUSDC exhausted')
  }
  const requestId = randomUUID()
  const request = {
    requestId,
    method: 'POST',
    path: '/v1/chat/completions',
    headers: { 'content-type': 'application/json' },
    body: new TextEncoder().encode(JSON.stringify({
      ...buildKbfChatRequestBody(service, probes, { maxTokens: reference.queryProfile.maxTokensPerRequest }),
      top_p: reference.queryProfile.generationSettings.topP,
      stream: false,
      n: 1,
      ...(reference.queryProfile.requestOverrides ?? {}),
    })),
  }
  const requestHash = hashRequest(request)
  const startedAt = Date.now()
  let response: Awaited<ReturnType<ModelVerificationContext['node']['sendRequest']>> | null = null
  let responseAuth: StoredResponseAuth | null = null
  let payment: BuyerResponsePaymentEvidence | null = null
  let failureReason: string | null = null
  let answers: Array<number | null> = new Array(probes.length).fill(null)
  let matches: MatchVector = new Array(probes.length).fill(null)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), context.requestTimeoutMs)
  try {
    response = await context.node.sendRequest(target, request, { signal: controller.signal })
    const remaining = Math.max(1, startedAt + context.requestTimeoutMs - Date.now())
    responseAuth = await context.node.waitForResponseAuth(requestId, remaining)
    if (!responseAuth.verified) throw new Error(`ResponseAuth verification failed: ${responseAuth.verificationError ?? 'unknown'}`)
    if (responseAuth.requestHash.toLowerCase() !== requestHash.toLowerCase()) throw new Error('ResponseAuth request hash mismatch')
    if (responseAuth.responseHash.toLowerCase() !== hashResponse(response).toLowerCase()) {
      throw new Error('ResponseAuth response hash mismatch')
    }
    payment = await context.node.finalizeResponsePayment(target, requestId)
    context.spend.spentUsdc += payment.sellerChargeUsdc
    if (response.statusCode !== 200) throw new Error(`HTTP ${response.statusCode}`)
    const completion = extractCompletionText(response.body)
    if (completion === null) throw new Error('malformed completion response')
    answers = parseKbfAnswers(completion, probes.length)
    matches = computeMatchVector(answers, probes)
    if (answers.every((answer) => answer === null)) throw new Error('completion contained no parseable answers')
  } catch (error) {
    failureReason = controller.signal.aborted
      ? `request timed out after ${context.requestTimeoutMs}ms`
      : asError(error).message
  } finally {
    clearTimeout(timer)
  }
  const completedAt = Date.now()
  const authenticated = Boolean(response && responseAuth?.verified && payment && response.statusCode === 200 && !failureReason)
  return {
    requestId,
    probeIds: probes.map((probe) => probe.id),
    request: {
      method: request.method,
      path: request.path,
      headers: request.headers,
      bodyBase64: Buffer.from(request.body).toString('base64'),
      hash: requestHash,
    },
    response: response ? {
      statusCode: response.statusCode,
      headers: response.headers,
      bodyBase64: Buffer.from(response.body).toString('base64'),
      hash: hashResponse(response),
    } : null,
    responseAuth: responseAuth ? toResponseAuthPayload(responseAuth) : null,
    payment: payment ? {
      sellerChargeUsdc: payment.sellerChargeUsdc.toString(),
      spendingAuth: payment.spendingAuth as unknown as Record<string, unknown>,
    } : null,
    timing: { startedAt, completedAt, responseLatencyMs: Math.max(0, completedAt - startedAt) },
    answers,
    matches,
    status: authenticated ? 'succeeded' : 'failed',
    failureReason,
  }
}

export async function writeRunSummary(evidenceDir: string, summary: ModelVerificationRunSummary): Promise<string> {
  const directory = join(evidenceDir, 'runs')
  await mkdir(directory, { recursive: true })
  const path = join(directory, `${summary.runId}.json`)
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`
  const handle = await open(temporary, 'wx')
  try {
    await handle.writeFile(canonicalJsonStringify(summary))
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temporary, path)
  return path
}

export async function readRunSummary(path: string): Promise<ModelVerificationRunSummary> {
  return JSON.parse(await readFile(path, 'utf8')) as ModelVerificationRunSummary
}

function emptyMetrics(startedAt: number, completedAt: number) {
  return {
    windowStartedAt: Math.floor(startedAt / 1_000),
    windowEndedAt: Math.floor(completedAt / 1_000),
    eligibleAttempts: 0,
    successfulAttempts: 0,
    p50TtftMs: 0,
    p95TtftMs: 0,
    p50OutputTokensPerSecondMilli: 0,
    schemaVersion: 0,
    observationsRoot: `0x${'0'.repeat(64)}`,
  }
}

function verdictCode(verdict: 'SAME' | 'DIFF' | 'UNDETERMINED'): Exclude<VerifierVerdict, 0> {
  if (verdict === 'SAME') return VERIFIER_VERDICT_SAME
  if (verdict === 'DIFF') return VERIFIER_VERDICT_DIFF
  return VERIFIER_VERDICT_UNDETERMINED
}

function extractCompletionText(body: Uint8Array): string | null {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(body)) as {
      choices?: Array<{ message?: { content?: unknown }; text?: unknown }>
      content?: Array<{ type?: string; text?: unknown }>
      output_text?: unknown
    }
    const chatContent = parsed.choices?.[0]?.message?.content
    if (typeof chatContent === 'string') return chatContent
    const text = parsed.choices?.[0]?.text
    if (typeof text === 'string') return text
    const anthropicText = parsed.content?.find((block) => block?.type === 'text')?.text
    if (typeof anthropicText === 'string') return anthropicText
    return typeof parsed.output_text === 'string' ? parsed.output_text : null
  } catch {
    return null
  }
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size))
  return chunks
}

async function runConcurrently<T, R>(
  items: readonly T[],
  concurrency: number,
  execute: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let nextIndex = 0
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const index = nextIndex
      nextIndex += 1
      if (index >= items.length) return
      results[index] = await execute(items[index]!)
    }
  }))
  return results
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
