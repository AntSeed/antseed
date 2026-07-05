import { randomUUID } from 'node:crypto'
import type {
  AntseedNode,
  ConnectedDelegate,
  PeerInfo,
  ProbeJobResultPayload,
  SerializedHttpRequest,
  SerializedHttpResponse,
} from '@antseed/node'
import { verifyResponseAuth } from '@antseed/node'
import type { ProbeSet } from '@antseed/fingerprints'
import { buildStealthChatRequests, extractAnswersFreeText } from '@antseed/fingerprints'
import type { SellerProbeRun } from './probing.js'
import { extractCompletionText } from './probing.js'

export interface DelegatedProbeOptions {
  /** Per-job execution budget granted to the delegate. */
  jobTimeoutMs: number
  log: (message: string) => void
  warn: (message: string) => void
}

export interface DelegatedProbeOutcome {
  run: SellerProbeRun
  /** VERIFIED jobs carried per delegate payout address, for on-chain crediting. */
  jobsByPayout: Map<string, number>
}

interface VerifiedJob {
  responseBody: Uint8Array
  auth: { requestHash: string; responseHash: string; signature: string }
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
  const responseAuths: SellerProbeRun['responseAuths'] = []
  const errors: string[] = []
  const jobsByPayout = new Map<string, number>()

  const plans = buildStealthChatRequests(service, probeSet, { maxProbesPerRequest })

  let delegateCursor = 0
  for (const plan of plans) {
    const bodyBytes = new TextEncoder().encode(JSON.stringify(plan.body))
    // One retry on a different delegate: probe secrecy for this plan is
    // already spent after the first dispatch, so a second carrier costs
    // nothing extra in leak exposure.
    const attempts = Math.min(2, delegates.length)
    let verified: VerifiedJob | null = null
    let requestId = ''
    let lastError = 'no attempt made'

    for (let attempt = 0; attempt < attempts && !verified; attempt += 1) {
      const delegate = delegates[delegateCursor % delegates.length]!
      delegateCursor += 1
      // Fresh requestId per attempt — the request hash covers it, so a retry
      // is a distinct signed exchange rather than a replay.
      requestId = randomUUID()
      const request: SerializedHttpRequest = {
        requestId,
        method: 'POST',
        path: '/v1/chat/completions',
        headers: { 'content-type': 'application/json' },
        body: bodyBytes,
      }
      const outcome = await runVerifiedJob(node, delegate, peer, service, request, options.jobTimeoutMs)
      if ('error' in outcome) {
        lastError = `via ${delegate.peerId.slice(0, 10)}…: ${outcome.error}`
        continue
      }
      verified = outcome
      jobsByPayout.set(delegate.payoutAddress, (jobsByPayout.get(delegate.payoutAddress) ?? 0) + 1)
    }

    requestIds.push(requestId)
    if (!verified) {
      errors.push(`request ${requestId.slice(0, 8)}: ${lastError}`)
      responseAuths.push(null)
      continue
    }

    const text = extractCompletionText(verified.responseBody)
    if (text === null) {
      errors.push(`request ${requestId.slice(0, 8)}: unparseable completion body`)
    } else {
      const planAnswers = extractAnswersFreeText(text, plan.probes)
      plan.probeIndices.forEach((probeIndex, i) => {
        answers[probeIndex] = planAnswers[i] ?? null
      })
    }
    responseAuths.push(verified.auth)
  }

  return {
    run: {
      peerId: peer.peerId,
      agentId: peer.onChainAgentId,
      answers,
      requestIds,
      responseAuths,
      fullyAuthenticated: responseAuths.length > 0 && responseAuths.every((auth) => auth !== null),
      errors,
    },
    jobsByPayout,
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
    advertisedService: extractModelFromBody(request.body) ?? service,
  })
  if (!verification.valid) {
    return { error: `invalid ResponseAuth from delegate (${verification.reason ?? 'unknown'})` }
  }

  return {
    responseBody: response.body,
    auth: {
      requestHash: result.responseAuth.requestHash,
      responseHash: result.responseAuth.responseHash,
      signature: result.responseAuth.signature,
    },
  }
}

/** Mirror of the seller/buyer service extraction: the request body's model field. */
function extractModelFromBody(body: Uint8Array): string | undefined {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(body)) as { model?: unknown; service?: unknown }
    const service = parsed.service ?? parsed.model
    return typeof service === 'string' && service.length > 0 ? service : undefined
  } catch {
    return undefined
  }
}
