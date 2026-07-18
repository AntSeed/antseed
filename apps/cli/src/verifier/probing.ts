import { randomUUID } from 'node:crypto'
import type { AntseedNode, PeerInfo, ResponseAuthPayload, StoredResponseAuth } from '@antseed/node'
import { toResponseAuthPayload } from '@antseed/node'
import type { ProbeSet, StealthRequestPlan } from '@antseed/fingerprints'
import { buildStealthChatRequests, extractAnswersFreeText } from '@antseed/fingerprints'

// Lives next to the ResponseAuth types in @antseed/node so a new payload
// field cannot be silently dropped by an app-layer copy; re-exported for
// this module's existing consumers.
export { toResponseAuthPayload }

export const RESPONSE_AUTH_POLL_INTERVAL_MS = 500
export const RESPONSE_AUTH_POLL_TIMEOUT_MS = 35_000

/**
 * One complete probe exchange as persisted in evidence bundles: the exact
 * request/response material needed to recompute the ResponseAuth hashes plus
 * the full signed payload, so any third party can re-verify the seller
 * signature from the bundle alone — no daemon state required.
 */
export interface ProbeExchangeEvidence {
  requestId: string
  request: {
    method: string
    path: string
    headers: Record<string, string>
    bodyBase64: string
  }
  response: {
    statusCode: number
    headers: Record<string, string>
    bodyBase64: string
  } | null
  /** Complete signed ResponseAuth payload (null = seller never produced one). */
  responseAuth: ResponseAuthPayload | null
}

export interface SellerProbeRun {
  peerId: string
  agentId: number | undefined
  /** Parsed numeric answers, position-aligned with probeSet.probes. */
  answers: Array<number | null>
  requestIds: string[]
  /**
   * Probes bundled into each stealth request, aligned with requestIds. Summed
   * over the requests whose exchanges are actually anchored, this is the
   * probe evidence an on-chain batch anchor declares (`probeCount`).
   */
  probesPerRequest: number[]
  /** Verified ResponseAuth hashes per request, aligned with requestIds (null = missing/unverified). */
  responseAuths: Array<{ requestHash: string; responseHash: string; signature: string } | null>
  /** Full re-verifiable exchange evidence, aligned with requestIds. */
  exchanges: ProbeExchangeEvidence[]
  /** True when every probe request produced a verified ResponseAuth. */
  fullyAuthenticated: boolean
  /**
   * Distinct delegate carriers that produced ≥1 verified exchange for this
   * seller (delegated probing only; undefined for direct probing). Surfaced so
   * a SAME verdict corroborated by only a single carrier can be flagged.
   */
  carrierCount?: number
  errors: string[]
}

export function extractCompletionText(body: Uint8Array): string | null {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(body)) as {
      choices?: Array<{ message?: { content?: unknown }; text?: unknown }>
      content?: Array<{ type?: string; text?: unknown }>
    }
    const chatContent = parsed.choices?.[0]?.message?.content
    if (typeof chatContent === 'string') return chatContent
    const text = parsed.choices?.[0]?.text
    if (typeof text === 'string') return text
    const anthropicText = parsed.content?.find((block) => block?.type === 'text')?.text
    if (typeof anthropicText === 'string') return anthropicText
    return null
  } catch {
    return null
  }
}

/**
 * Extract one stealth plan's answers from a completion body and scatter them
 * into the full-probe-set `answers` array by the plan's probe indices (plans
 * cover disjoint probe subsets). Returns false — scattering nothing — when the
 * body is not a parseable completion. Shared by direct probing, delegated
 * probing, and audit recomputation so the extraction semantics cannot drift.
 */
export function scatterPlanAnswers(
  responseBody: Uint8Array,
  plan: Pick<StealthRequestPlan, 'probes' | 'probeIndices'>,
  answers: Array<number | null>,
): boolean {
  const text = extractCompletionText(responseBody)
  if (text === null) return false
  const planAnswers = extractAnswersFreeText(text, plan.probes)
  plan.probeIndices.forEach((probeIndex, i) => {
    answers[probeIndex] = planAnswers[i] ?? null
  })
  return true
}

/**
 * Poll the node for the seller-signed ResponseAuth of `requestId` until it
 * lands, the timeout elapses, or `signal` aborts.
 *
 * `requireVerified` (default true) treats a record whose local signature
 * verification failed as absent. The delegate worker passes false: it relays
 * the full payload verbatim and the verifier re-verifies the seller signature
 * itself, trusting nothing the carrier claims.
 */
export async function waitForResponseAuth(
  node: AntseedNode,
  requestId: string,
  options: { timeoutMs?: number; signal?: AbortSignal; requireVerified?: boolean } = {},
): Promise<StoredResponseAuth | null> {
  const { timeoutMs = RESPONSE_AUTH_POLL_TIMEOUT_MS, signal, requireVerified = true } = options
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const record = node.getResponseAuth(requestId)
    if (record) {
      if (requireVerified && !record.verified) return null
      return record
    }
    if (signal?.aborted || Date.now() >= deadline) return null
    await new Promise((resolve) => setTimeout(resolve, RESPONSE_AUTH_POLL_INTERVAL_MS))
  }
}

/**
 * Probe one seller with the full probe set. Requests are generated by the
 * stealth engine so they read like organic user chat rather than a
 * recognizable test battery — a cheating seller cannot cheaply classify probe
 * traffic and route only it to the real model. Payment negotiation
 * (402 → ReserveAuth/SpendingAuth) is handled by the node's buyer path.
 *
 * `maxProbesPerRequest` trades stealth (fewer probes per message = more
 * organic) against cost (more requests = more per-request minimum fees).
 */
export async function probeSeller(
  node: AntseedNode,
  peer: PeerInfo,
  service: string,
  probeSet: ProbeSet,
  maxProbesPerRequest = 3,
): Promise<SellerProbeRun> {
  // Answers aligned to the full probe set; stealth plans cover disjoint
  // subsets, so we scatter each plan's extracted answers back by index.
  const answers: Array<number | null> = new Array(probeSet.probes.length).fill(null)
  const requestIds: string[] = []
  const probesPerRequest: number[] = []
  const exchanges: ProbeExchangeEvidence[] = []
  const errors: string[] = []

  const plans = buildStealthChatRequests(service, probeSet, { maxProbesPerRequest })
  // Filled by plan index — the sends below stay strictly sequential (stealth),
  // but the ResponseAuth polls overlap, so completion order is not plan order.
  const responseAuths: SellerProbeRun['responseAuths'] = new Array(plans.length).fill(null)
  const authWaits: Array<Promise<void>> = []

  for (let planIdx = 0; planIdx < plans.length; planIdx += 1) {
    const plan = plans[planIdx]!
    const requestId = randomUUID()
    const bodyBytes = new TextEncoder().encode(JSON.stringify(plan.body))
    const req = {
      requestId,
      method: 'POST',
      path: '/v1/chat/completions',
      headers: { 'content-type': 'application/json' },
      body: bodyBytes,
    }
    const exchange: ProbeExchangeEvidence = {
      requestId,
      request: {
        method: req.method,
        path: req.path,
        headers: { ...req.headers },
        bodyBase64: Buffer.from(bodyBytes).toString('base64'),
      },
      response: null,
      responseAuth: null,
    }

    requestIds.push(requestId)
    probesPerRequest.push(plan.probes.length)
    exchanges.push(exchange)
    try {
      const response = await node.sendRequest(peer, req)
      exchange.response = {
        statusCode: response.statusCode,
        headers: { ...response.headers },
        bodyBase64: Buffer.from(response.body).toString('base64'),
      }
      if (response.statusCode !== 200) {
        errors.push(`request ${requestId.slice(0, 8)}: HTTP ${response.statusCode}`)
        continue
      }
      if (!scatterPlanAnswers(response.body, plan, answers)) {
        errors.push(`request ${requestId.slice(0, 8)}: unparseable completion body`)
      }
      // START the ResponseAuth poll and move on to the next plan — the auth
      // record lands asynchronously in the node's store, so waiting for it
      // before the next SEND only adds latency without any stealth benefit.
      // A plan whose auth never lands keeps its null slot (same per-plan
      // outcome as the previous strictly-sequential wait).
      authWaits.push(waitForResponseAuth(node, requestId).then((stored) => {
        if (!stored) return
        exchange.responseAuth = toResponseAuthPayload(stored)
        responseAuths[planIdx] = {
          requestHash: stored.requestHash,
          responseHash: stored.responseHash,
          signature: stored.signature,
        }
      }).catch((err: unknown) => {
        errors.push(`request ${requestId.slice(0, 8)}: ${(err as Error).message}`)
      }))
    } catch (err) {
      errors.push(`request ${requestId.slice(0, 8)}: ${(err as Error).message}`)
    }
  }
  await Promise.all(authWaits)

  return {
    peerId: peer.peerId,
    agentId: peer.onChainAgentId,
    answers,
    requestIds,
    probesPerRequest,
    responseAuths,
    exchanges,
    fullyAuthenticated: responseAuths.length > 0 && responseAuths.every((auth) => auth !== null),
    errors,
  }
}
