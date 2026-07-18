import { randomUUID } from 'node:crypto'
import type {
  AntseedNode,
  ConnectedDelegate,
  PeerInfo,
  ProbeJobResultPayload,
  ResponseAuthPayload,
  SerializedHttpRequest,
  SerializedHttpResponse,
} from '@antseed/node'
import { toPeerId, verifyResponseAuth } from '@antseed/node'
import type { ProbeSet } from '@antseed/fingerprints'
import { buildStealthChatRequests } from '@antseed/fingerprints'
import type { ProbeExchangeEvidence, SellerProbeRun } from './probing.js'
import { scatterPlanAnswers } from './probing.js'
import { extractRequestedService } from '../proxy/request-utils.js'

/**
 * Per-probe completion budget for delegated stealth probes. Answers are short
 * factual numbers, so ~192 tokens per bundled probe leaves ample headroom for
 * conversational framing without truncating the answer the fingerprint reads.
 * The floor keeps single-probe requests usable; the ceiling stays comfortably
 * under the delegate worker's own MAX_JOB_MAX_TOKENS (4096) cap so the relay is
 * never rejected as out-of-bounds.
 */
const PROBE_MAX_TOKENS_PER_PROBE = 192
const PROBE_MAX_TOKENS_FLOOR = 384
const PROBE_MAX_TOKENS_CEILING = 1024

function boundedProbeMaxTokens(probeCount: number): number {
  const wanted = Math.max(1, probeCount) * PROBE_MAX_TOKENS_PER_PROBE
  return Math.min(PROBE_MAX_TOKENS_CEILING, Math.max(PROBE_MAX_TOKENS_FLOOR, wanted))
}

export interface DelegatedProbeOptions {
  /** Per-job execution budget granted to the delegate. */
  jobTimeoutMs: number
  /**
   * Delegates that reported ORGANIC history with this seller (TargetQuery
   * solicitation). They are tried first: a probe carried by a buyer that
   * already uses the seller is indistinguishable from its normal traffic,
   * which is the whole stealth argument. Unknown/absent entries fall back to
   * the ordinary rotation.
   */
  preferredDelegatePeerIds?: readonly string[]
  log: (message: string) => void
  warn: (message: string) => void
}

/** How long the verifier waits for each delegate's TargetSuggestion. */
const TARGET_QUERY_TIMEOUT_MS = 10_000

export interface SuggestedSeller {
  peerId: string
  agentId: number
}

/**
 * Sends one TargetQuery to one delegate and resolves with its suggested
 * sellers for the service (empty array is a valid answer). Production wiring
 * adapts the node's delegation channel (`makeNodeTargetQuerier`); tests
 * inject fakes.
 */
export type TargetQuerier = (
  delegatePeerId: string,
  service: string,
  timeoutMs: number,
) => Promise<SuggestedSeller[]>

/**
 * Ask every connected delegate which sellers of `service` it ALREADY uses,
 * before probe jobs are assigned. Failures and timeouts are per-delegate
 * (Promise.allSettled) — a slow or silent delegate costs nothing but its own
 * suggestions.
 *
 * Returns sellerPeerId (lowercased) → delegate peerIds that suggested it.
 */
export async function solicitDelegateTargets(
  delegates: readonly ConnectedDelegate[],
  service: string,
  queryDelegate: TargetQuerier,
  options: { timeoutMs?: number; log: (m: string) => void; warn: (m: string) => void },
): Promise<Map<string, string[]>> {
  const timeoutMs = options.timeoutMs ?? TARGET_QUERY_TIMEOUT_MS
  const bySeller = new Map<string, string[]>()
  if (delegates.length === 0) return bySeller

  // Per-delegate isolation only: the querier itself enforces the timeout
  // (DelegationMux.runTargetQuery rejects after `timeoutMs`), so allSettled
  // just keeps one failure from costing anything but its own suggestions.
  const settled = await Promise.allSettled(delegates.map(async (delegate) => ({
    delegatePeerId: delegate.peerId,
    sellers: await queryDelegate(delegate.peerId, service, timeoutMs),
  })))

  let suggestions = 0
  settled.forEach((outcome, i) => {
    const delegatePeerId = delegates[i]!.peerId
    if (outcome.status === 'rejected') {
      options.warn(`target query to ${delegatePeerId.slice(0, 10)}… failed: ${(outcome.reason as Error).message}`)
      return
    }
    for (const seller of outcome.value.sellers) {
      if (typeof seller?.peerId !== 'string' || seller.peerId.length === 0) continue
      const key = seller.peerId.toLowerCase()
      const list = bySeller.get(key) ?? []
      if (!list.includes(delegatePeerId)) list.push(delegatePeerId)
      bySeller.set(key, list)
      suggestions += 1
    }
  })
  options.log(`target solicitation for ${service}: ${suggestions} suggestion(s) across ${delegates.length} delegate(s)`)
  return bySeller
}

/** Adapt the node's delegation channel (TargetQuery 0x95/0x96) into a TargetQuerier. */
export function makeNodeTargetQuerier(node: AntseedNode): TargetQuerier {
  return async (delegatePeerId, service, timeoutMs) => {
    const suggestion = await node.queryDelegateTargets(
      toPeerId(delegatePeerId),
      { queryId: randomUUID(), service },
      timeoutMs,
    )
    return (suggestion.sellers ?? []).filter(
      (s): s is SuggestedSeller => typeof s?.peerId === 'string' && s.peerId.length > 0,
    )
  }
}

export interface DelegatedProbeOutcome {
  run: SellerProbeRun
  /**
   * VERIFIED jobs carried per delegate peerId. Surfaced for corroboration
   * (a single-carrier SAME is weak); delegate crediting itself is on-chain at
   * anchor time (the buyer named in each seller-signed ResponseAuth), not
   * driven by this count.
   */
  jobsByDelegate: Map<string, number>
}

/**
 * Minimum share of a seller's probe plans routed through a NON-suggesting
 * delegate when both suggesting and non-suggesting delegates are connected.
 * Suggestions may PREFER an organic carrier, but must never let it become the
 * sole carrier: a colluding delegate that "suggests" a seller it controls
 * would otherwise carry every probe, reviving "serve the real model only to my
 * accomplice." ~1/3 keeps the stealth benefit (the suggested pool still
 * carries the majority) while guaranteeing independent coverage.
 */
const MIN_NON_SUGGESTING_SHARE = 1 / 3

/**
 * Choose the primary carrier for each plan index. When both a suggesting pool
 * and a non-suggesting pool are connected, an evenly-spread minimum fraction
 * of plans is forced onto the non-suggesting pool (the rest prefer the
 * suggesting pool); otherwise plans round-robin over the only available pool.
 * Deterministic given the pools and plan count.
 */
export function assignPrimaryCarriers(
  planCount: number,
  preferredPool: readonly ConnectedDelegate[],
  otherPool: readonly ConnectedDelegate[],
  allDelegates: readonly ConnectedDelegate[],
): ConnectedDelegate[] {
  if (planCount <= 0) return []
  // No suggestions, or every delegate suggested this seller: plain rotation
  // over the relevant pool — there is no accomplice-monopoly risk to mitigate.
  if (preferredPool.length === 0) {
    return Array.from({ length: planCount }, (_, i) => allDelegates[i % allDelegates.length]!)
  }
  if (otherPool.length === 0) {
    return Array.from({ length: planCount }, (_, i) => preferredPool[i % preferredPool.length]!)
  }

  // Both pools present: reserve evenly-spread slots for the non-suggesting
  // pool (at least one), assign the rest to the suggesting pool.
  const otherCount = Math.min(planCount, Math.max(1, Math.round(planCount * MIN_NON_SUGGESTING_SHARE)))
  const otherSlots = new Set<number>()
  for (let k = 0; k < otherCount; k += 1) {
    otherSlots.add(Math.min(planCount - 1, Math.floor(((k + 0.5) * planCount) / otherCount)))
  }
  const carriers: ConnectedDelegate[] = []
  let preferredCursor = 0
  let otherCursor = 0
  for (let i = 0; i < planCount; i += 1) {
    if (otherSlots.has(i)) {
      carriers.push(otherPool[otherCursor++ % otherPool.length]!)
    } else {
      carriers.push(preferredPool[preferredCursor++ % preferredPool.length]!)
    }
  }
  return carriers
}

interface VerifiedJob {
  responseBody: Uint8Array
  response: { statusCode: number; headers: Record<string, string>; bodyBase64: string }
  auth: ResponseAuthPayload
}

/**
 * Probe one seller through delegate buyers instead of the verifier's own
 * buyer identity. The verifier whitelist is public on-chain, so probes sent
 * from a verifier-linked wallet are classifiable: a cheating seller could
 * serve the real model only to verifiers. Delegates are organic buyers with
 * real history — their probe requests are indistinguishable from their
 * normal traffic.
 *
 * Delegates are untrusted transport. Every observation is re-verified here:
 * the seller's ResponseAuth signature must bind the exact request the
 * verifier crafted to the exact response body the delegate returned. A
 * delegate can drop or delay a job, never alter or fabricate one.
 */
export async function probeSellerViaDelegates(
  node: AntseedNode,
  delegates: ConnectedDelegate[],
  peer: PeerInfo,
  service: string,
  probeSet: ProbeSet,
  maxProbesPerRequest: number,
  options: DelegatedProbeOptions,
): Promise<DelegatedProbeOutcome> {
  if (delegates.length === 0) {
    throw new Error('no delegates available')
  }

  const answers: Array<number | null> = new Array(probeSet.probes.length).fill(null)
  const requestIds: string[] = []
  const probesPerRequest: number[] = []
  const responseAuths: SellerProbeRun['responseAuths'] = []
  const exchanges: ProbeExchangeEvidence[] = []
  const errors: string[] = []
  const jobsByDelegate = new Map<string, number>()

  const plans = buildStealthChatRequests(service, probeSet, { maxProbesPerRequest })

  // Delegates that suggested this seller (organic history with it) are PREFERRED
  // carriers — their probe traffic is indistinguishable from their normal use
  // of the seller — but never the SOLE carrier: a guaranteed fraction of plans
  // rides a non-suggesting delegate so a lone accomplice can't monopolize the
  // seller's audit. Retries always draw from the full roster.
  const preferred = new Set((options.preferredDelegatePeerIds ?? []).map((id) => id.toLowerCase()))
  const preferredPool = delegates.filter((d) => preferred.has(d.peerId.toLowerCase()))
  const otherPool = delegates.filter((d) => !preferred.has(d.peerId.toLowerCase()))
  const primaryCarriers = assignPrimaryCarriers(plans.length, preferredPool, otherPool, delegates)

  // A delegate carries each probe on ITS deposit and refuses any relay
  // without a bounded completion budget (see delegate/worker.ts
  // validateProbeJob). The stealth builder deliberately omits `max_tokens` to
  // stay organic, so the verifier stamps a budget here: generous enough not
  // to truncate the short factual answers the fingerprint reads, small enough
  // to cap the delegate's spend. Sizing it to the probe count (rather than a
  // fixed round number) keeps it from being a single constant tell.
  const states = plans.map((plan) => {
    if (plan.body.max_tokens === undefined) {
      plan.body.max_tokens = boundedProbeMaxTokens(plan.probes.length)
    }
    const bodyBytes = new TextEncoder().encode(JSON.stringify(plan.body))
    return {
      bodyBytes,
      bodyBase64: Buffer.from(bodyBytes).toString('base64'),
      requestId: '',
      verified: null as VerifiedJob | null,
      lastError: 'no attempt made',
    }
  })

  const attemptPlan = async (planIdx: number, delegate: ConnectedDelegate): Promise<void> => {
    const state = states[planIdx]!
    // Fresh requestId per attempt — the request hash covers it, so a retry
    // is a distinct signed exchange rather than a replay.
    state.requestId = randomUUID()
    const request: SerializedHttpRequest = {
      requestId: state.requestId,
      method: 'POST',
      path: '/v1/chat/completions',
      headers: { 'content-type': 'application/json' },
      body: state.bodyBytes,
    }
    const outcome = await runVerifiedJob(node, delegate, peer, service, request, options.jobTimeoutMs)
    if ('error' in outcome) {
      state.lastError = `via ${delegate.peerId.slice(0, 10)}…: ${outcome.error}`
      return
    }
    state.verified = outcome
    jobsByDelegate.set(delegate.peerId, (jobsByDelegate.get(delegate.peerId) ?? 0) + 1)
  }

  // Primary phase: each plan's primary carrier is fixed up front and delegates
  // accept concurrent jobs, so DIFFERENT carriers run in parallel. One
  // carrier's own plans stay strictly sequential — a burst of simultaneous
  // probe-shaped requests from a single buyer would itself be a tell.
  const byCarrier = new Map<string, number[]>()
  for (let planIdx = 0; planIdx < plans.length; planIdx += 1) {
    const peerId = primaryCarriers[planIdx]!.peerId
    const group = byCarrier.get(peerId) ?? []
    group.push(planIdx)
    byCarrier.set(peerId, group)
  }
  await Promise.all([...byCarrier.values()].map(async (planIdxs) => {
    for (const planIdx of planIdxs) {
      await attemptPlan(planIdx, primaryCarriers[planIdx]!)
    }
  }))

  // Retry phase, sequential in plan order: one retry on a different delegate.
  // Probe secrecy for a failed plan is already spent after the first dispatch,
  // so a second carrier costs nothing extra in leak exposure. The primary
  // carrier is the anti-collusion assignment above; the retry may be any other
  // connected delegate. The cursor advances for EVERY plan (not just failed
  // ones), matching the historical strictly-sequential dispatch's rotation.
  let fallbackCursor = 0
  for (let planIdx = 0; planIdx < plans.length; planIdx += 1) {
    const primary = primaryCarriers[planIdx]!
    let fallback: ConnectedDelegate | null = null
    for (let k = 0; k < delegates.length && fallback === null; k += 1) {
      const candidate = delegates[fallbackCursor % delegates.length]!
      fallbackCursor += 1
      if (candidate.peerId !== primary.peerId) fallback = candidate
    }
    if (fallback && states[planIdx]!.verified === null) {
      await attemptPlan(planIdx, fallback)
    }
  }

  // Assemble results ordered by plan index.
  for (let planIdx = 0; planIdx < plans.length; planIdx += 1) {
    const plan = plans[planIdx]!
    const { requestId, verified, lastError, bodyBase64 } = states[planIdx]!
    requestIds.push(requestId)
    probesPerRequest.push(plan.probes.length)
    exchanges.push({
      requestId,
      request: {
        method: 'POST',
        path: '/v1/chat/completions',
        headers: { 'content-type': 'application/json' },
        bodyBase64,
      },
      response: verified?.response ?? null,
      responseAuth: verified?.auth ?? null,
    })
    if (!verified) {
      errors.push(`request ${requestId.slice(0, 8)}: ${lastError}`)
      responseAuths.push(null)
      continue
    }

    if (!scatterPlanAnswers(verified.responseBody, plan, answers)) {
      errors.push(`request ${requestId.slice(0, 8)}: unparseable completion body`)
    }
    responseAuths.push({
      requestHash: verified.auth.requestHash,
      responseHash: verified.auth.responseHash,
      signature: verified.auth.signature,
    })
  }

  return {
    run: {
      peerId: peer.peerId,
      agentId: peer.onChainAgentId,
      answers,
      requestIds,
      probesPerRequest,
      responseAuths,
      exchanges,
      fullyAuthenticated: responseAuths.length > 0 && responseAuths.every((auth) => auth !== null),
      // Distinct delegates that produced a verified exchange for this seller.
      carrierCount: jobsByDelegate.size,
      errors,
    },
    jobsByDelegate,
  }
}

async function runVerifiedJob(
  node: AntseedNode,
  delegate: ConnectedDelegate,
  peer: PeerInfo,
  service: string,
  request: SerializedHttpRequest,
  jobTimeoutMs: number,
): Promise<VerifiedJob | { error: string }> {
  let result: ProbeJobResultPayload
  try {
    result = await node.runProbeJob(delegate.peerId, {
      jobId: randomUUID(),
      targetPeerId: peer.peerId,
      service,
      request: {
        requestId: request.requestId,
        method: request.method,
        path: request.path,
        headers: request.headers,
        bodyBase64: Buffer.from(request.body).toString('base64'),
      },
      timeoutMs: jobTimeoutMs,
    })
  } catch (err) {
    return { error: (err as Error).message }
  }

  if (result.status !== 'ok') {
    return { error: result.error ?? 'delegate reported failure' }
  }
  if (!result.response || !result.responseAuth) {
    return { error: 'delegate result missing response or ResponseAuth' }
  }
  if (result.response.statusCode !== 200) {
    return { error: `HTTP ${result.response.statusCode}` }
  }

  // The seller echoes the requestId, so the signed response is reconstructed
  // from the job's own id plus what the delegate returned. Header insertion
  // order survives the JSON round-trip, which the response hash depends on.
  const response: SerializedHttpResponse = {
    requestId: request.requestId,
    statusCode: result.response.statusCode,
    headers: result.response.headers,
    body: new Uint8Array(Buffer.from(result.response.bodyBase64, 'base64')),
  }

  const verification = verifyResponseAuth(result.responseAuth, {
    request,
    response,
    buyerPeerId: delegate.peerId,
    sellerPeerId: peer.peerId,
    // Same extraction as the buyer proxy — the two paths must derive the same
    // service key or ResponseAuth verification diverges on delegates.
    advertisedService: extractRequestedService(request) ?? service,
  })
  if (!verification.valid) {
    return { error: `invalid ResponseAuth from delegate (${verification.reason ?? 'unknown'})` }
  }

  return {
    responseBody: response.body,
    response: {
      statusCode: result.response.statusCode,
      headers: { ...result.response.headers },
      bodyBase64: result.response.bodyBase64,
    },
    auth: result.responseAuth,
  }
}
