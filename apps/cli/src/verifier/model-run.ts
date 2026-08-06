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
  type AuditCostSummaryV1,
  type ProxyAuditEvidenceExchangeV1,
  type ProxyAuditEvidenceV1,
} from './proxy-evidence.js'
import type { ResponseAuthReader } from './response-auth-reader.js'
import { advertisedServices } from './service-discovery.js'

const PROBE_REQUEST_CONCURRENCY = 2
const PROBE_REQUEST_ATTEMPTS = 5
const PROBE_RETRY_BASE_DELAY_MS = 500

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
  responseAuthReader: ResponseAuthReader
  fetchFn?: typeof fetch
  sleepFn?: (delayMs: number) => Promise<void>
}

export interface ModelVerificationTargetResult {
  peerId: string
  agentId: string | null
  service: string
  status: 'SAME' | 'DIFF' | 'UNDETERMINED'
  auditId: string
  parsedProbeCount: number
  probeCount: number
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
): { eligible: true; service: string } | { eligible: false; reason: string } {
  const service = advertisedServices(peer).get(normalizedModel)
  if (!service) return { eligible: false, reason: 'model no longer advertised' }
  if (!peer.capabilities?.includes(CONNECTION_CAPABILITY_RESPONSE_AUTH_V1)) {
    return { eligible: false, reason: `missing ${CONNECTION_CAPABILITY_RESPONSE_AUTH_V1}` }
  }
  return { eligible: true, service }
}

export async function verifyModelTarget(input: {
  context: ProxyVerificationContext
  target: PeerInfo
  service: string
  reference: KbfReferenceV1
  auditId?: string
}): Promise<ModelVerificationTargetResult> {
  const batches = chunk(input.reference.probes, KBF_PROBES_PER_REQUEST)
  const exchanges = await runConcurrently(batches, PROBE_REQUEST_CONCURRENCY, (probes, batchIndex) => {
    return executeProxyProbeBatch(input.context, input.target, input.service, input.reference, probes, batchIndex)
  })
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
      parsedProbeCount: matchVector.filter((entry) => entry !== null).length,
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
    agentId: input.target.onChainAgentId ? String(input.target.onChainAgentId) : null,
    service: input.service,
    status: verdict,
    auditId,
    parsedProbeCount: evidence.result.parsedProbeCount,
    probeCount: input.reference.probes.length,
    requestCount: exchanges.length,
    cost,
    evidencePath: written.path,
    evidenceHash: written.evidenceHash,
  }
}

async function executeProxyProbeBatch(
  context: ProxyVerificationContext,
  target: PeerInfo,
  service: string,
  reference: KbfReferenceV1,
  probes: KbfProbe[],
  batchIndex: number,
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
  const fetchFn = context.fetchFn ?? fetch
  const sleepFn = context.sleepFn ?? sleep

  while (attemptCount < PROBE_REQUEST_ATTEMPTS) {
    attemptCount += 1
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), context.requestTimeoutMs)
    try {
      const response = await fetchFn(url, {
        method: 'POST',
        headers,
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
        if (!isRetryableStatus(response.status)) break
        throw new Error(lastFailure)
      }
      const completion = extractCompletionText(responseBody)
      const answers = completion === null
        ? new Array<number | null>(probes.length).fill(null)
        : parseKbfAnswers(completion, probes.length)
      const matches = computeMatchVector(answers, probes)
      const completedAt = Date.now()
      const requestId = response.headers.get('x-antseed-request-id')
      const responseAuth = requestId
        ? await context.responseAuthReader.waitForVerified({
          requestId,
          sellerPeerId: target.peerId,
          advertisedService: service,
        })
        : {
          requestId: null,
          status: 'missing' as const,
          responseAuth: null,
          failureReason: 'successful buyer proxy response omitted x-antseed-request-id',
        }
      return {
        batchIndex,
        attemptCount,
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
      lastFailure = controller.signal.aborted
        ? `buyer proxy request timed out after ${context.requestTimeoutMs}ms`
        : asError(error).message
      if (attemptCount < PROBE_REQUEST_ATTEMPTS) {
        await sleepFn(PROBE_RETRY_BASE_DELAY_MS * 2 ** (attemptCount - 1))
      }
    } finally {
      clearTimeout(timer)
    }
  }
  const completedAt = Date.now()
  return {
    batchIndex,
    attemptCount,
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
      requestId: null,
      status: 'missing',
      record: null,
      failureReason: 'proxy batch did not complete successfully',
    },
  }
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

async function runConcurrently<T, R>(
  items: readonly T[],
  concurrency: number,
  execute: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let nextIndex = 0
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const index = nextIndex
      nextIndex += 1
      if (index >= items.length) return
      results[index] = await execute(items[index]!, index)
    }
  }))
  return results
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs))
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
