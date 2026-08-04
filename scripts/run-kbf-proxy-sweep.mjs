#!/usr/bin/env node

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  KbfVerifier,
  buildKbfChatRequestBody,
  parseKbfAnswers,
  validateKbfReferenceV1,
} from '../packages/fingerprints/dist/index.js'

const DEFAULT_PROXY_URL = 'http://127.0.0.1:8377'
const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_BUFFER_BPS = 1_000

export function extractCompletionText(raw) {
  const trimmed = raw.trimStart()
  if (!trimmed.startsWith('event:') && !trimmed.startsWith('data:')) {
    const parsed = JSON.parse(raw)
    const chat = parsed.choices?.[0]?.message?.content
    if (typeof chat === 'string' && chat.trim().length > 0) return chat
    const reasoning = parsed.choices?.[0]?.message?.reasoning_content
    if (typeof reasoning === 'string' && reasoning.trim().length > 0) return reasoning
    if (typeof parsed.output_text === 'string') return parsed.output_text
    return extractOutputParts(parsed.output)
  }

  let streamed = ''
  let completed = null
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith('data: ') || line === 'data: [DONE]') continue
    try {
      const event = JSON.parse(line.slice(6))
      if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
        streamed += event.delta
      }
      if (event.type === 'response.completed') completed = event.response ?? event
    } catch {
      // Ignore non-JSON SSE keepalive lines.
    }
  }
  if (typeof completed?.output_text === 'string') return completed.output_text
  return extractOutputParts(completed?.output) ?? (streamed || null)
}

export function resolveMaximumServicePricing(peer, service) {
  const normalizedService = service.trim().toLowerCase()
  const candidates = []
  for (const [provider, pricing] of Object.entries(peer.providerPricing ?? {})) {
    const serviceKey = Object.keys(pricing.services ?? {}).find(
      (candidate) => candidate.trim().toLowerCase() === normalizedService,
    )
    if (!serviceKey) continue
    const selected = pricing.services[serviceKey] ?? pricing.defaults
    const input = Number(selected?.inputUsdPerMillion)
    const output = Number(selected?.outputUsdPerMillion)
    if (!Number.isFinite(input) || input < 0 || !Number.isFinite(output) || output < 0) continue
    candidates.push({ provider, inputUsdPerMillion: input, outputUsdPerMillion: output })
  }
  if (candidates.length === 0) {
    throw new Error(`${peer.displayName ?? peer.peerId} has no advertised ${service} pricing`)
  }
  return {
    inputUsdPerMillion: Math.max(...candidates.map((candidate) => candidate.inputUsdPerMillion)),
    outputUsdPerMillion: Math.max(...candidates.map((candidate) => candidate.outputUsdPerMillion)),
    providers: candidates.map((candidate) => candidate.provider),
  }
}

export function estimateBatchMaximumUsdcBase(body, pricing, bufferBps = DEFAULT_BUFFER_BPS) {
  const inputTokenUpperBound = Buffer.byteLength(JSON.stringify(body), 'utf8')
  const outputTokenUpperBound = Number(body.max_tokens ?? 0)
  const rawMicroUsdc = (
    inputTokenUpperBound * pricing.inputUsdPerMillion
    + outputTokenUpperBound * pricing.outputUsdPerMillion
  )
  return BigInt(Math.ceil(rawMicroUsdc * (10_000 + bufferBps) / 10_000))
}

export function summarizeKbfResult(result) {
  return {
    verifier: result.verifier,
    referenceId: result.referenceId,
    referenceModel: result.referenceModel,
    probeCount: result.probeCount,
    parsedProbeCount: result.parsedProbeCount,
    stats: result.stats,
    verdict: result.verdict,
    verdictReason: result.verdictReason,
  }
}

export async function runProxySweep(options) {
  const referencePath = options.referencePath === 'auto'
    ? await prepareAutomaticReference(options)
    : options.referencePath
  const reference = validateKbfReferenceV1(
    JSON.parse(await readFile(referencePath, 'utf8')),
    { minimumStatisticalPower: options.minimumStatisticalPower ?? 0.9 },
  )
  const participantReport = JSON.parse(await readFile(options.participantsPath, 'utf8'))
  const participants = participantReport.participants
    .filter((participant) => participant.advertisedService.trim().toLowerCase() === options.service.toLowerCase())
    .filter((participant) => participant.status !== 'INELIGIBLE')
    .filter((participant) => options.includePeerIds.size === 0 || options.includePeerIds.has(participant.peerId))
  if (participants.length === 0) throw new Error(`no ${options.service} participants found`)
  if (reference.probes.length !== reference.selectedProbeCount) throw new Error('reference probe count is inconsistent')

  const proxyPeers = await fetchProxyPeers(options.proxyUrl)
  const proxyPeersById = new Map(proxyPeers.map((peer) => [peer.peerId, peer]))
  const batches = splitBatches(reference.probes, reference.queryProfile.probesPerRequest)
  const plans = participants.map((participant) => {
    const peer = proxyPeersById.get(participant.peerId)
    if (!peer) throw new Error(`${participant.displayName ?? participant.peerId} is not visible through the buyer proxy`)
    const pricing = resolveMaximumServicePricing(peer, options.service)
    const batchMaximums = batches.map((batch) => estimateBatchMaximumUsdcBase(
      buildRequestBody(reference, options.service, batch.probes),
      pricing,
      options.bufferBps,
    ))
    return { participant, peer, pricing, batchMaximums }
  })
  const plannedMaximum = plans.reduce(
    (total, plan) => total + plan.batchMaximums.reduce((subtotal, value) => subtotal + value, 0n),
    0n,
  )
  if (plannedMaximum > options.maxTotalUsdcBase) {
    throw new Error(
      `conservative maximum ${plannedMaximum} exceeds cap ${options.maxTotalUsdcBase} USDC base units`,
    )
  }

  const verifier = new KbfVerifier()
  const startedAt = new Date().toISOString()
  const results = new Array(plans.length)
  let estimatedSpendUsdcBase = 0n

  await runConcurrently(plans, options.targetConcurrency, async (plan, planIndex) => {
      const targetStartedAt = new Date().toISOString()
      const answers = []
      const batchResults = []
      console.log(`[proxy-kbf] START ${plan.participant.displayName ?? plan.participant.peerId}`)
      try {
        for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
          const batch = batches[batchIndex]
          const body = buildRequestBody(reference, options.service, batch.probes)
          const exchange = await requestBatch({
            proxyUrl: options.proxyUrl,
            service: options.service,
            peerId: plan.participant.peerId,
            body,
            expectedAnswers: batch.probes.length,
            timeoutMs: options.timeoutMs,
          })
          batchResults.push({
            batchIndex,
            parsed: exchange.answers.filter((answer) => answer !== null).length,
            probeCount: batch.probes.length,
            responsePeer: exchange.responsePeer,
            latencyMs: exchange.latencyMs,
            estimatedCostUsdcBase: exchange.estimatedCostUsdcBase.toString(),
          })
          estimatedSpendUsdcBase += exchange.estimatedCostUsdcBase
          if (exchange.responsePeer !== plan.participant.peerId) {
            throw new Error(`proxy returned peer ${exchange.responsePeer ?? 'unknown'} for pinned peer ${plan.participant.peerId}`)
          }
          answers.push(...exchange.answers)
          if (estimatedSpendUsdcBase > options.maxTotalUsdcBase) {
            throw new Error(`estimated buyer spend exceeded cap ${options.maxTotalUsdcBase}`)
          }
          console.log(
            `[proxy-kbf] ${plan.participant.displayName ?? plan.participant.peerId} `
            + `batch ${batchIndex + 1}/${batches.length} parsed=${exchange.answers.filter((answer) => answer !== null).length}/${batch.probes.length} `
            + `latency=${exchange.latencyMs}ms evidence=not-collected`,
          )
        }
        const result = verifier.verify(reference, { answers })
        const status = result.verdict === 'SAME' || result.verdict === 'DIFF'
          ? result.verdict
          : 'UNDETERMINED'
        results[planIndex] = {
          participant: plan.participant,
          startedAt: targetStartedAt,
          completedAt: new Date().toISOString(),
          status,
          reason: status === 'DIFF' ? 'GPT Sol model-mismatch signal' : result.verdictReason,
          pricing: plan.pricing,
          batches: batchResults,
          result: summarizeKbfResult(result),
        }
        console.log(
          `[proxy-kbf] DONE ${plan.participant.displayName ?? plan.participant.peerId} `
          + `verdict=${status} parsed=${result.parsedProbeCount}/${result.probeCount} `
          + `hamming=${result.stats.targetHamming ?? '-'} p=${result.stats.pValueBinomial ?? '-'}`,
        )
      } catch (error) {
        const message = asError(error).message
        results[planIndex] = {
          participant: plan.participant,
          startedAt: targetStartedAt,
          completedAt: new Date().toISOString(),
          status: 'FAILED',
          reason: message,
          pricing: plan.pricing,
          batches: batchResults,
          result: null,
        }
        console.warn(`[proxy-kbf] FAIL ${plan.participant.displayName ?? plan.participant.peerId}: ${message}`)
      }
  })

  const report = {
    version: 1,
    kind: 'antseed-kbf-proxy-observation-report',
    evidenceLevel: 'analytics-only',
    transport: 'buyer-proxy',
    createdAt: startedAt,
    completedAt: new Date().toISOString(),
    proxyUrl: options.proxyUrl,
    service: options.service,
    reference: {
      path: referencePath,
      referenceId: reference.referenceId,
      referenceModel: reference.referenceModel,
      probeCount: reference.probes.length,
      selfHamming: reference.selfTest.hamming,
      selfTotal: reference.selfTest.total,
      statisticalPower: reference.statisticalPower,
      requiredStatisticalPower: options.minimumStatisticalPower ?? 0.9,
    },
    budget: {
      maximumUsdcBase: options.maxTotalUsdcBase.toString(),
      conservativePlannedMaximumUsdcBase: plannedMaximum.toString(),
      estimatedSpendUsdcBase: estimatedSpendUsdcBase.toString(),
      observedPaymentUsdcBase: null,
      note: 'Actual payment evidence is intentionally not collected in observe mode.',
    },
    summary: summarizeResults(results),
    participants: results,
  }
  await mkdir(dirname(options.outPath), { recursive: true })
  await writeFile(options.outPath, `${JSON.stringify(report, bigintJson, 2)}\n`)
  return report
}

async function prepareAutomaticReference(options) {
  const participantReport = JSON.parse(await readFile(options.participantsPath, 'utf8'))
  const eligibleCount = participantReport.participants
    .filter((participant) => participant.advertisedService.trim().toLowerCase() === options.service.toLowerCase())
    .filter((participant) => participant.status !== 'INELIGIBLE')
    .filter((participant) => options.includePeerIds.size === 0 || options.includePeerIds.has(participant.peerId))
    .length
  if (eligibleCount === 0) throw new Error(`no ${options.service} participants found for automatic sizing`)

  const [{ loadConfig }, { prepareBenchmarkReference }, { resolveReferencePolicy }, { VerificationStorage }] = await Promise.all([
    import('../apps/cli/dist/config/loader.js'),
    import('../apps/cli/dist/verifier/benchmark-reference.js'),
    import('../apps/cli/dist/verifier/reference-config.js'),
    import('../packages/node/dist/index.js'),
  ])
  const config = await loadConfig(options.configPath)
  const policy = resolveReferencePolicy(config.verifier?.referencePolicy)
  const storage = new VerificationStorage(join(options.dataDir, 'verification.db'))
  try {
    const prepared = await prepareBenchmarkReference({
      storage,
      runId: `proxy-observe-${Date.now()}-${randomUUID()}`,
      service: options.service,
      verifierConfig: config.verifier,
      referencesDir: config.verifier?.referencesDir ?? join(options.dataDir, 'fingerprints', 'references'),
      sizing: {
        mode: 'auto',
        minimumProbeCount: policy.minimumAuditProbeCount,
        maximumProbeCount: policy.maximumAuditProbeCount,
        probeStep: policy.auditProbeStep,
        minimumStatisticalPower: options.minimumStatisticalPower ?? policy.minimumStatisticalPower,
        minimumMismatchDelta: policy.minimumMismatchDelta,
        alpha: policy.familyWideAlpha / eligibleCount,
        cpConfidence: policy.referenceConfidence,
      },
      log: (message) => console.log(`[proxy-kbf] reference ${message}`),
    })
    console.log(
      `[proxy-kbf] AUTO-REFERENCE probes=${prepared.reference.selectedProbeCount} `
      + `power=${prepared.reference.statisticalPower.toFixed(4)} `
      + `alpha=${prepared.reference.statisticalPowerEvidence.alpha} path=${prepared.outPath}`,
    )
    return prepared.outPath
  } finally {
    storage.close()
  }
}

async function requestBatch(input) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs)
  const startedAt = Date.now()
  let response
  let raw
  try {
    response = await fetch(`${input.proxyUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-antseed-pin-peer': input.peerId,
      },
      body: JSON.stringify(input.body),
      signal: controller.signal,
    })
    raw = await response.text()
  } finally {
    clearTimeout(timeout)
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${raw.slice(0, 500)}`)
  const responsePeer = response.headers.get('x-antseed-peer-id')
  const completionText = extractCompletionText(raw)
  if (typeof completionText !== 'string') throw new Error('response contained no completion text')
  const estimatedCost = Number(response.headers.get('x-antseed-estimated-cost-usd') ?? '0')
  return {
    responsePeer,
    answers: parseKbfAnswers(completionText, input.expectedAnswers),
    latencyMs: Date.now() - startedAt,
    estimatedCostUsdcBase: Number.isFinite(estimatedCost) && estimatedCost >= 0
      ? BigInt(Math.ceil(estimatedCost * 1_000_000))
      : 0n,
  }
}

async function fetchProxyPeers(proxyUrl) {
  const response = await fetch(`${proxyUrl}/_antseed/peers`)
  if (!response.ok) throw new Error(`buyer proxy peer request failed: HTTP ${response.status}`)
  const payload = await response.json()
  if (!payload.ok || !Array.isArray(payload.peers)) throw new Error('buyer proxy returned an invalid peer payload')
  return payload.peers
}

export function buildRequestBody(reference, service, probes) {
  return {
    ...buildKbfChatRequestBody(service, probes, {
      maxTokens: reference.queryProfile.maxTokensPerRequest,
    }),
    top_p: reference.queryProfile.generationSettings.topP,
    stream: false,
    n: 1,
    ...(reference.queryProfile.requestOverrides ?? {}),
  }
}

function splitBatches(probes, batchSize) {
  const batches = []
  for (let offset = 0; offset < probes.length; offset += batchSize) {
    batches.push({ offset, probes: probes.slice(offset, offset + batchSize) })
  }
  return batches
}

async function runConcurrently(items, concurrency, operation) {
  let nextIndex = 0
  const worker = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex
      nextIndex += 1
      await operation(items[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()))
}

function extractOutputParts(output) {
  if (!Array.isArray(output)) return null
  const text = []
  for (const item of output) {
    for (const part of item?.content ?? []) {
      if (typeof part?.text === 'string') text.push(part.text)
    }
  }
  return text.length > 0 ? text.join('') : null
}

function summarizeResults(results) {
  return {
    discovered: results.length,
    same: results.filter((result) => result.status === 'SAME').length,
    diff: results.filter((result) => result.status === 'DIFF').length,
    undetermined: results.filter((result) => result.status === 'UNDETERMINED').length,
    failed: results.filter((result) => result.status === 'FAILED').length,
  }
}

function parseArguments(argv) {
  const values = new Map()
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (!flag?.startsWith('--') || value === undefined) throw new Error(`invalid argument near ${flag ?? '<end>'}`)
    values.set(flag.slice(2), value)
  }
  const required = (name) => {
    const value = values.get(name)
    if (!value) throw new Error(`--${name} is required`)
    return value
  }
  const reference = required('reference')
  const targetConcurrency = Number(values.get('target-concurrency') ?? '2')
  if (!Number.isInteger(targetConcurrency) || targetConcurrency < 1) {
    throw new Error('--target-concurrency must be an integer >= 1')
  }
  const minimumStatisticalPower = values.has('minimum-statistical-power')
    ? Number(values.get('minimum-statistical-power'))
    : undefined
  if (minimumStatisticalPower !== undefined
    && (!Number.isFinite(minimumStatisticalPower) || minimumStatisticalPower <= 0 || minimumStatisticalPower > 1)) {
    throw new Error('--minimum-statistical-power must be in (0, 1]')
  }
  return {
    referencePath: reference.trim().toLowerCase() === 'auto' ? 'auto' : resolve(reference),
    participantsPath: resolve(required('participants')),
    outPath: resolve(required('out')),
    configPath: resolve(values.get('config') ?? join(homedir(), '.antseed-benchmark', 'config.json')),
    dataDir: resolve(values.get('data-dir') ?? join(homedir(), '.antseed-benchmark')),
    service: values.get('service') ?? 'gpt-5.6-sol',
    proxyUrl: (values.get('proxy-url') ?? DEFAULT_PROXY_URL).replace(/\/$/, ''),
    maxTotalUsdcBase: BigInt(values.get('max-total-usdc-base') ?? '5000000'),
    timeoutMs: Number(values.get('timeout-ms') ?? DEFAULT_TIMEOUT_MS),
    bufferBps: Number(values.get('budget-buffer-bps') ?? DEFAULT_BUFFER_BPS),
    targetConcurrency,
    minimumStatisticalPower,
    includePeerIds: new Set((values.get('include-peer-ids') ?? '').split(',').map((value) => value.trim()).filter(Boolean)),
  }
}

function bigintJson(_key, value) {
  return typeof value === 'bigint' ? value.toString() : value
}

function asError(error) {
  return error instanceof Error ? error : new Error(String(error))
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  const report = await runProxySweep(options)
  console.log(`[proxy-kbf] REPORT ${options.outPath}`)
  console.log(`[proxy-kbf] SUMMARY ${JSON.stringify(report.summary)}`)
  console.log(`[proxy-kbf] ESTIMATED ${report.budget.estimatedSpendUsdcBase}/${report.budget.maximumUsdcBase} USDC base units`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`[proxy-kbf] FATAL ${asError(error).stack ?? asError(error).message}`)
    process.exitCode = 1
  })
}
