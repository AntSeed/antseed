import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  KBF_PROBES_PER_REQUEST,
  buildKbfChatRequestBody,
  canonicalHashBytes32,
  canonicalJsonStringify,
  computeMatchVector,
  parseKbfAnswers,
  queryProfileHash,
  verifyKbf,
  type KbfProbe,
  type KbfReferenceV1,
} from '@antseed/fingerprints'
import { CONNECTION_CAPABILITY_RESPONSE_AUTH_V1, type PeerInfo } from '@antseed/node'
import { parsePersistedPeers } from '../proxy/buyer-proxy.js'
import {
  deriveProxyAuditId,
  parseProxyAuditExchangeCost,
  summarizeAuditExchangeCosts,
  writeProxyAuditEvidence,
  writeProxyAuditSkipEvidence,
  type AuditCostSummaryV1,
  type ProxyAuditEvidenceExchangeV1,
  type ProxyAuditEvidenceV1,
  type ProxyAuditSkipEvidenceV1,
  type VerificationSkipCode,
} from './proxy-evidence.js'
import type { ResponseAuthReader } from './response-auth-reader.js'
import { advertisedServices } from './service-discovery.js'
import { mapWithAdaptiveConcurrency, type AuditTaskLimiter } from './audit-concurrency.js'

const PROBE_REQUEST_ATTEMPTS = 5
const PROBE_RETRY_BASE_DELAY_MS = 500

class VerificationSkipSignal extends Error {
  constructor(
    readonly code: VerificationSkipCode,
    readonly reason: string,
    readonly exchange: ProxyAuditEvidenceExchangeV1,
  ) {
    super(reason)
  }
}

export interface BuyerProxySnapshot {
  baseUrl: string
  statePath: string
  pid: number
  peers: PeerInfo[]
}

export interface ProxyVerificationContext {
  proxy: BuyerProxySnapshot
  evidenceDir: string
  requestTimeoutMs: number
  auditTimeoutMs: number
  responseAuthReader: ResponseAuthReader
  batchConcurrency: number
  batchConcurrencyPromotionLatencyMs: number
  batchLimiter: AuditTaskLimiter
  fetchFn?: typeof fetch
  sleepFn?: (delayMs: number) => Promise<void>
}

export interface ModelVerificationTargetResult {
  peerId: string
  displayName: string | null
  agentId: string | null
  service: string
  status: 'SAME' | 'DIFF' | 'UNDETERMINED'
  auditId: string
  parsedProbeCount: number
  probeCount: number
  correctProbeCount: number
  incorrectProbeCount: number
  correctRate: number | null
  requestCount: number
  cost: AuditCostSummaryV1
  evidencePath: string
  evidenceHash: string
}

export interface ModelVerificationFailure {
  peerId: string
  agentId: string | null
  service: string
  status: 'FAILED'
  reason: string
}

export interface ModelVerificationSkip {
  peerId: string
  displayName: string | null
  agentId: string | null
  service: string
  status: 'SKIPPED'
  code: VerificationSkipCode
  reason: string
  source: 'preflight' | 'runtime'
  auditId: string | null
  evidencePath: string | null
  evidenceHash: string | null
}

export interface ModelVerificationRunSummary {
  version: 1
  kind: 'antseed-model-verification-run'
  runId: string
  model: string
  mode: 'buyer-proxy'
  proxyBaseUrl: string
  referenceId: string
  probeCount: number
  startedAt: string
  completedAt: string
  results: ModelVerificationTargetResult[]
  failures: ModelVerificationFailure[]
  skipped: ModelVerificationSkip[]
}

export async function loadBuyerProxySnapshot(dataDir: string): Promise<BuyerProxySnapshot> {
  const statePath = join(dataDir, 'buyer.state.json')
  let parsed: {
    state?: unknown
    pid?: unknown
    port?: unknown
    discoveredPeers?: unknown
  }
  try {
    parsed = JSON.parse(await readFile(statePath, 'utf8')) as typeof parsed
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`buyer proxy state not found at ${statePath}; start antseed buyer first`)
    }
    throw new Error(`invalid buyer proxy state at ${statePath}: ${asError(error).message}`)
  }
  if (parsed.state !== 'connected') throw new Error('buyer proxy is not connected; start antseed buyer first')
  if (!Number.isInteger(parsed.pid) || Number(parsed.pid) <= 0 || !isProcessAlive(Number(parsed.pid))) {
    throw new Error('buyer proxy state is stale; start antseed buyer first')
  }
  if (!Number.isInteger(parsed.port) || Number(parsed.port) < 1 || Number(parsed.port) > 65_535) {
    throw new Error('buyer proxy state has an invalid port')
  }
  const peers = parsePersistedPeers(parsed)
  if (peers.length === 0) throw new Error('buyer proxy has no live discovered peers')
  return {
    baseUrl: `http://127.0.0.1:${String(parsed.port)}`,
    statePath,
    pid: Number(parsed.pid),
    peers,
  }
}

export function classifyVerificationTarget(
  peer: PeerInfo,
  normalizedModel: string,
): { eligible: true; service: string }
  | { eligible: false; code: 'model_not_advertised'; service: null; reason: string }
  | { eligible: false; code: 'missing_response_auth'; service: string; reason: string } {
  const service = advertisedServices(peer).get(normalizedModel)
  if (!service) {
    return { eligible: false, code: 'model_not_advertised', service: null, reason: 'model not advertised' }
  }
  if (!peer.capabilities?.includes(CONNECTION_CAPABILITY_RESPONSE_AUTH_V1)) {
    return {
      eligible: false,
      code: 'missing_response_auth',
      service,
      reason: `missing ${CONNECTION_CAPABILITY_RESPONSE_AUTH_V1}`,
    }
  }
  return { eligible: true, service }
}

export async function verifyModelTarget(input: {
  context: ProxyVerificationContext
  target: PeerInfo
  service: string
  reference: KbfReferenceV1
  auditId?: string
}): Promise<ModelVerificationTargetResult | ModelVerificationSkip> {
  const batches = chunk(input.reference.probes, KBF_PROBES_PER_REQUEST)
  const auditController = new AbortController()
  const auditTimer = setTimeout(() => auditController.abort(), input.context.auditTimeoutMs)
  let exchanges: ProxyAuditEvidenceExchangeV1[]
  try {
    exchanges = await mapWithAdaptiveConcurrency(
      batches,
      input.context.batchConcurrency,
      (probes, batchIndex, control) => input.context.batchLimiter.run(() => executeProxyProbeBatch(
        { ...input.context, signal: auditController.signal },
        input.target,
        input.service,
        input.reference,
        probes,
        batchIndex,
        control.reduceToOne,
      )),
      (exchange) => exchange.status === 'succeeded'
        && exchange.responseAuth.status === 'verified'
        && exchange.timing.responseLatencyMs <= input.context.batchConcurrencyPromotionLatencyMs,
    )
  } catch (error) {
    if (!(error instanceof VerificationSkipSignal)) throw error
    const completedAt = Date.now()
    const evidence: ProxyAuditSkipEvidenceV1 = {
      version: 1,
      kind: 'antseed-buyer-proxy-target-skip',
      evidenceLevel: 'proxy-observation-no-payment-evidence',
      createdAt: new Date(completedAt).toISOString(),
      buyerProxy: {
        baseUrl: input.context.proxy.baseUrl,
        statePath: input.context.proxy.statePath,
        pid: input.context.proxy.pid,
      },
      target: {
        peerId: input.target.peerId,
        displayName: input.target.displayName ?? null,
        agentId: input.target.onChainAgentId ? String(input.target.onChainAgentId) : null,
        service: input.service,
      },
      reference: {
        referenceId: input.reference.referenceId,
        referenceModel: input.reference.referenceModel,
      },
      exchange: error.exchange,
      result: { status: 'SKIPPED', code: error.code, reason: error.reason },
    }
    const evidenceHash = canonicalHashBytes32(evidence)
    const auditId = input.auditId ?? deriveProxyAuditId({
      targetPeerId: input.target.peerId,
      referenceId: input.reference.referenceId,
      completedAt,
      evidenceHash,
    })
    const written = await writeProxyAuditSkipEvidence(input.context.evidenceDir, auditId, evidence)
    return {
      peerId: input.target.peerId,
      displayName: input.target.displayName ?? null,
      agentId: input.target.onChainAgentId ? String(input.target.onChainAgentId) : null,
      service: input.service,
      status: 'SKIPPED',
      code: error.code,
      reason: error.reason,
      source: 'runtime',
      auditId,
      evidencePath: written.path,
      evidenceHash: written.evidenceHash,
    }
  } finally {
    clearTimeout(auditTimer)
  }
  const answers = exchanges.flatMap((exchange) => exchange.answers)
  const matchVector = exchanges.flatMap((exchange) => exchange.matches)
  const fragment = verifyKbf(input.reference, { answers, matchVector }, { minCoverage: 1 })
  if (fragment.verdict === 'UNKNOWN') throw new Error(fragment.verdictReason ?? 'verification returned UNKNOWN')

  const completedAt = Date.now()
  const authenticated = exchanges.every((exchange) => exchange.status !== 'succeeded'
    || exchange.responseAuth.status === 'verified')
  const verdict = authenticated ? fragment.verdict : 'UNDETERMINED'
  const verdictReason = authenticated
    ? fragment.verdictReason
    : 'one or more successful proxy batches lacked valid verified ResponseAuth'
  const cost = summarizeAuditExchangeCosts(exchanges)
  const correctProbeCount = matchVector.filter((entry) => entry === 1).length
  const incorrectProbeCount = matchVector.filter((entry) => entry === 0).length
  const parsedProbeCount = correctProbeCount + incorrectProbeCount
  const evidence: ProxyAuditEvidenceV1 = {
    version: 1,
    kind: 'antseed-buyer-proxy-kbf-audit',
    evidenceLevel: 'proxy-observation-with-verified-response-auth-no-payment-evidence',
    createdAt: new Date(completedAt).toISOString(),
    buyerProxy: {
      baseUrl: input.context.proxy.baseUrl,
      statePath: input.context.proxy.statePath,
      pid: input.context.proxy.pid,
    },
    target: {
      peerId: input.target.peerId,
      displayName: input.target.displayName ?? null,
      agentId: input.target.onChainAgentId ? String(input.target.onChainAgentId) : null,
      service: input.service,
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
      parsedProbeCount,
      matchVector,
      matchVectorHash: fragment.matchVectorHash,
      stats: fragment.stats,
      verdict,
      verdictReason,
      cost,
    },
  }
  const evidenceHash = canonicalHashBytes32(evidence)
  const auditId = input.auditId ?? deriveProxyAuditId({
    targetPeerId: input.target.peerId,
    referenceId: input.reference.referenceId,
    completedAt,
    evidenceHash,
  })
  const written = await writeProxyAuditEvidence(input.context.evidenceDir, auditId, evidence)
  return {
    peerId: input.target.peerId,
    displayName: input.target.displayName ?? null,
    agentId: input.target.onChainAgentId ? String(input.target.onChainAgentId) : null,
    service: input.service,
    status: verdict,
    auditId,
    parsedProbeCount,
    probeCount: input.reference.probes.length,
    correctProbeCount,
    incorrectProbeCount,
    correctRate: parsedProbeCount === 0 ? null : correctProbeCount / parsedProbeCount,
    requestCount: exchanges.length,
    cost,
    evidencePath: written.path,
    evidenceHash: written.evidenceHash,
  }
}

async function executeProxyProbeBatch(
  context: ProxyVerificationContext & { signal: AbortSignal },
  target: PeerInfo,
  service: string,
  reference: KbfReferenceV1,
  probes: KbfProbe[],
  batchIndex: number,
  onRateLimited?: () => void,
): Promise<ProxyAuditEvidenceExchangeV1> {
  const url = `${context.proxy.baseUrl}/v1/chat/completions`
  const headers = {
    'content-type': 'application/json',
    'x-antseed-pin-peer': target.peerId,
  }
  const body = new TextEncoder().encode(JSON.stringify({
    ...buildKbfChatRequestBody(service, probes, { maxTokens: reference.queryProfile.maxTokensPerRequest }),
    top_p: reference.queryProfile.generationSettings.topP,
    stream: false,
    n: 1,
    ...(reference.queryProfile.requestOverrides ?? {}),
  }))
  const request = {
    method: 'POST' as const,
    url,
    headers,
    bodyBase64: Buffer.from(body).toString('base64'),
    hash: canonicalHashBytes32({ method: 'POST', url, headers, bodyBase64: Buffer.from(body).toString('base64') }),
  }
  const startedAt = Date.now()
  let attemptCount = 0
  let lastFailure = 'proxy request failed'
  let lastResponse: ProxyAuditEvidenceExchangeV1['response'] = null
  const requestIds: string[] = []
  let lastRequestId: string | null = null
  const fetchFn = context.fetchFn ?? fetch
  const sleepFn = context.sleepFn ?? sleep

  while (attemptCount < PROBE_REQUEST_ATTEMPTS && !context.signal.aborted) {
    attemptCount += 1
    const requestId = randomUUID()
    requestIds.push(requestId)
    lastRequestId = requestId
    const controller = new AbortController()
    const abortRequest = () => controller.abort()
    context.signal.addEventListener('abort', abortRequest, { once: true })
    const timer = setTimeout(() => controller.abort(), context.requestTimeoutMs)
    try {
      const response = await fetchFn(url, {
        method: 'POST',
        headers: { ...headers, 'x-antseed-request-id': requestId },
        body,
        signal: controller.signal,
      })
      const responseBody = new Uint8Array(await response.arrayBuffer())
      const responseHeaders = Object.fromEntries(response.headers.entries())
      lastResponse = {
        statusCode: response.status,
        headers: responseHeaders,
        bodyBase64: Buffer.from(responseBody).toString('base64'),
        hash: canonicalHashBytes32({
          statusCode: response.status,
          headers: responseHeaders,
          bodyBase64: Buffer.from(responseBody).toString('base64'),
        }),
      }
      if (!response.ok) {
        lastFailure = `buyer proxy HTTP ${response.status}: ${responseText(responseBody).slice(0, 500)}`
        const skip = batchIndex === 0 ? classifyVerificationSkip(response.status, responseBody) : null
        if (skip) {
          const completedAt = Date.now()
          throw new VerificationSkipSignal(skip.code, skip.reason, {
            batchIndex,
            attemptCount,
            requestIds,
            probeIds: probes.map((probe) => probe.id),
            request,
            response: lastResponse,
            timing: { startedAt, completedAt, responseLatencyMs: Math.max(0, completedAt - startedAt) },
            answers: new Array<number | null>(probes.length).fill(null),
            matches: new Array<null>(probes.length).fill(null),
            status: 'failed',
            failureReason: lastFailure,
            cost: null,
            responseAuth: {
              requestId,
              status: 'missing',
              record: null,
              failureReason: 'proxy batch was rejected before a successful authenticated response',
            },
          })
        }
        if (response.status === 429) onRateLimited?.()
        if (!isRetryableStatus(response.status)) break
        throw new Error(lastFailure)
      }
      const completion = extractCompletionText(responseBody)
      const answers = completion === null
        ? new Array<number | null>(probes.length).fill(null)
        : parseKbfAnswers(completion, probes.length)
      const matches = computeMatchVector(answers, probes)
      const completedAt = Date.now()
      const returnedRequestId = response.headers.get('x-antseed-request-id')
      const responseAuth = returnedRequestId === requestId
        ? await context.responseAuthReader.waitForVerified({
          requestId,
          sellerPeerId: target.peerId,
          advertisedService: service,
          signal: context.signal,
        })
        : {
          requestId,
          status: returnedRequestId ? 'invalid' as const : 'missing' as const,
          responseAuth: null,
          failureReason: returnedRequestId
            ? `buyer proxy request ID mismatch (${returnedRequestId} != ${requestId})`
            : 'successful buyer proxy response omitted x-antseed-request-id',
        }
      return {
        batchIndex,
        attemptCount,
        requestIds,
        probeIds: probes.map((probe) => probe.id),
        request,
        response: lastResponse,
        timing: { startedAt, completedAt, responseLatencyMs: Math.max(0, completedAt - startedAt) },
        answers,
        matches,
        status: 'succeeded',
        failureReason: null,
        cost: parseProxyAuditExchangeCost(responseHeaders),
        responseAuth: {
          requestId: responseAuth.requestId,
          status: responseAuth.status,
          record: responseAuth.responseAuth,
          failureReason: responseAuth.failureReason,
        },
      }
    } catch (error) {
      if (error instanceof VerificationSkipSignal) throw error
      lastFailure = context.signal.aborted
        ? `seller audit deadline exceeded after ${context.auditTimeoutMs}ms`
        : controller.signal.aborted
          ? `buyer proxy request timed out after ${context.requestTimeoutMs}ms`
        : asError(error).message
      if (!context.signal.aborted && attemptCount < PROBE_REQUEST_ATTEMPTS) {
        await sleepWithSignal(PROBE_RETRY_BASE_DELAY_MS * 2 ** (attemptCount - 1), context.signal, sleepFn)
      }
    } finally {
      clearTimeout(timer)
      context.signal.removeEventListener('abort', abortRequest)
    }
  }
  if (context.signal.aborted) lastFailure = `seller audit deadline exceeded after ${context.auditTimeoutMs}ms`
  const completedAt = Date.now()
  return {
    batchIndex,
    attemptCount,
    requestIds,
    probeIds: probes.map((probe) => probe.id),
    request,
    response: lastResponse,
    timing: { startedAt, completedAt, responseLatencyMs: Math.max(0, completedAt - startedAt) },
    answers: new Array<number | null>(probes.length).fill(null),
    matches: new Array<null>(probes.length).fill(null),
    status: 'failed',
    failureReason: lastFailure,
    cost: null,
    responseAuth: {
      requestId: lastRequestId,
      status: 'missing',
      record: null,
      failureReason: 'proxy batch did not complete successfully',
    },
  }
}

function classifyVerificationSkip(
  statusCode: number,
  body: Uint8Array,
): { code: VerificationSkipCode; reason: string } | null {
  const text = responseText(body)
  let code = ''
  let message = text
  try {
    const parsed = JSON.parse(text) as { error?: unknown }
    const error = parsed.error
    if (error && typeof error === 'object') {
      const record = error as Record<string, unknown>
      code = typeof record.code === 'string' ? record.code : ''
      message = typeof record.message === 'string' ? record.message : text
    } else if (typeof error === 'string') {
      message = error
    }
  } catch {
    // Plain-text proxy errors are supported for compatibility with older buyers.
  }

  if (code === 'reputation_below_minimum' || code === 'price_above_maximum' || code === 'policy_rejected') {
    return { code, reason: message }
  }
  if (message.includes('outside your buyer routing policy')) {
    return { code: 'policy_rejected', reason: message }
  }
  if ((statusCode === 400 || statusCode === 404)
    && (code === 'model_not_found' || message.includes('is not served by this peer'))) {
    return {
      code: 'stale_model_advertisement',
      reason: `peer advertised ${extractQuotedService(message) ?? 'the requested model'} but rejected it as unavailable`,
    }
  }
  return null
}

function extractQuotedService(message: string): string | null {
  return message.match(/Service\s+"([^"]+)"\s+is not served by this peer/i)?.[1] ?? null
}

export async function writeRunSummary(evidenceDir: string, summary: ModelVerificationRunSummary): Promise<string> {
  const { mkdir, open, rename } = await import('node:fs/promises')
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

function extractCompletionText(body: Uint8Array): string | null {
  const text = responseText(body)
  try {
    return extractCompletionFromJson(JSON.parse(text) as Record<string, unknown>)
  } catch {
    return extractCompletionFromSse(text)
  }
}

function extractCompletionFromJson(parsed: Record<string, unknown>): string | null {
  const response = parsed as {
    choices?: Array<{ message?: { content?: unknown }; text?: unknown }>
    content?: Array<{ type?: string; text?: unknown }>
    output?: Array<{ content?: Array<{ type?: string; text?: unknown }> }>
    output_text?: unknown
  }
  const chatContent = response.choices?.[0]?.message?.content
  if (typeof chatContent === 'string') return chatContent
  const completionText = response.choices?.[0]?.text
  if (typeof completionText === 'string') return completionText
  const anthropicText = response.content?.find((block) => block?.type === 'text')?.text
  if (typeof anthropicText === 'string') return anthropicText
  if (typeof response.output_text === 'string') return response.output_text
  const outputText = response.output
    ?.flatMap((item) => item.content ?? [])
    .filter((part) => part.type === 'output_text' && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('')
  return outputText || null
}

function extractCompletionFromSse(text: string): string | null {
  const deltas: string[] = []
  let completed: string | null = null
  let done: string | null = null
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue
    const data = line.slice('data:'.length).trim()
    if (!data || data === '[DONE]') continue
    try {
      const event = JSON.parse(data) as Record<string, unknown>
      if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
        deltas.push(event.delta)
      } else if (event.type === 'response.output_text.done' && typeof event.text === 'string') {
        done = event.text
      } else if (event.type === 'response.completed' && event.response && typeof event.response === 'object') {
        completed = extractCompletionFromJson(event.response as Record<string, unknown>)
      }
    } catch {
      continue
    }
  }
  if (deltas.length > 0) return deltas.join('')
  return completed ?? done
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500
}

function responseText(body: Uint8Array): string {
  return new TextDecoder().decode(body)
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size))
  return chunks
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs))
}

async function sleepWithSignal(
  delayMs: number,
  signal: AbortSignal,
  sleepFn: (delayMs: number) => Promise<void>,
): Promise<void> {
  if (signal.aborted) return
  let abort!: () => void
  const aborted = new Promise<void>((resolve) => { abort = resolve })
  signal.addEventListener('abort', abort, { once: true })
  try {
    await Promise.race([sleepFn(delayMs), aborted])
  } finally {
    signal.removeEventListener('abort', abort)
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
