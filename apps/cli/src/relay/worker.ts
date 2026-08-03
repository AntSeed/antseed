import type {
  AntseedNode,
  AuditRelayJobPayload,
  AuditRelayResultPayload,
  PeerId,
  PeerInfo,
  RelayJobValidator,
  StoredRelayEntitlement,
  VerificationRelayStore,
} from '@antseed/node'
import {
  CONNECTION_CAPABILITY_AUDIT_RELAY_V1,
  ConnectionState,
  decodeHttpRequest,
  encodeContractResponseAuthPayload,
  encodeHttpResponse,
  hashRequest,
  hashResponse,
  peerIdToAddress,
  toResponseAuthPayload,
  verifyResponseAuth,
} from '@antseed/node'
import { getAddress } from 'ethers'
import { advertisedServices } from '../verifier/service-discovery.js'

const DEFAULT_MAX_CONCURRENT_JOBS = 2
const DEFAULT_MAX_JOBS_PER_HOUR = 60
const DEFAULT_DISCOVERY_INTERVAL_MS = 300_000
const DEFAULT_APPROVAL_TTL_MS = 5 * 60_000
const DEFAULT_REJECTED_TTL_MS = 15 * 60_000
const MAX_JOB_TIMEOUT_MS = 120_000
const MAX_JOB_BODY_BYTES = 256 * 1024
const MAX_JOB_RESPONSE_BYTES = 2 * 1024 * 1024
const MAX_JOB_MAX_TOKENS = 4_096
const ALLOWED_JOB_HEADERS = new Set(['content-type', 'accept', 'user-agent'])
const ALLOWED_JOB_BODY_FIELDS = new Set([
  'model',
  'messages',
  'temperature',
  'top_p',
  'seed',
  'stop',
  'stream',
  'max_tokens',
  'max_completion_tokens',
  'reasoning_effort',
  'n',
])

const ALLOWED_REASONING_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high'])

export interface RelayWorkerOptions {
  node: AntseedNode
  validator: RelayJobValidator
  storage: VerificationRelayStore
  chainId: string
  registryAddress: string
  treasuryAddress: string
  relayBuyerAddress: string
  minimumPayoutPerJobUsdc: bigint
  isApprovedVerifier: (address: string) => Promise<boolean>
  maxConcurrentJobs?: number
  maxJobsPerHour?: number
  discoveryIntervalMs?: number
  approvalTtlMs?: number
  rejectedTtlMs?: number
  log: (message: string) => void
  warn: (message: string) => void
}

export class RelayWorker {
  private readonly _options: Required<Pick<RelayWorkerOptions,
    'maxConcurrentJobs' | 'maxJobsPerHour' | 'discoveryIntervalMs' | 'approvalTtlMs' | 'rejectedTtlMs'>> & RelayWorkerOptions
  private readonly _serving = new Set<PeerId>()
  private readonly _rejectedUntil = new Map<PeerId, number>()
  private readonly _approvalCache = new Map<string, { approved: boolean; checkedAt: number }>()
  private readonly _activeJobAborts = new Set<AbortController>()
  private readonly _inFlightJobs = new Map<string, {
    assignmentIdentity: string
    promise: Promise<Omit<AuditRelayResultPayload, 'version' | 'jobId'>>
  }>()
  private _timer: ReturnType<typeof setInterval> | null = null
  private _stopped = false
  private _scanning = false
  private _activeJobs = 0
  private _jobStartTimes: number[] = []

  constructor(options: RelayWorkerOptions) {
    this._options = {
      maxConcurrentJobs: options.maxConcurrentJobs ?? DEFAULT_MAX_CONCURRENT_JOBS,
      maxJobsPerHour: options.maxJobsPerHour ?? DEFAULT_MAX_JOBS_PER_HOUR,
      discoveryIntervalMs: options.discoveryIntervalMs ?? DEFAULT_DISCOVERY_INTERVAL_MS,
      approvalTtlMs: options.approvalTtlMs ?? DEFAULT_APPROVAL_TTL_MS,
      rejectedTtlMs: options.rejectedTtlMs ?? DEFAULT_REJECTED_TTL_MS,
      ...options,
    }
  }

  start(): void {
    this._stopped = false
    void this._scan()
    this._timer = setInterval(() => void this._scan(), this._options.discoveryIntervalMs)
  }

  stop(): void {
    this._stopped = true
    if (this._timer) clearInterval(this._timer)
    this._timer = null
    for (const controller of this._activeJobAborts) controller.abort()
    this._activeJobAborts.clear()
    this._serving.clear()
    this._approvalCache.clear()
    this._rejectedUntil.clear()
    this._inFlightJobs.clear()
  }

  get servingVerifiers(): string[] {
    return [...this._serving]
  }

  async executeOffer(
    verifier: PeerInfo,
    offer: AuditRelayJobPayload,
  ): Promise<Omit<AuditRelayResultPayload, 'version' | 'jobId'>> {
    if (this._stopped) return { status: 'error', error: 'stopped' }
    if (!sameAddress(offer.auditSnapshot.committer, peerIdToAddress(verifier.peerId))) {
      return { status: 'error', error: 'verifier_committer_mismatch' }
    }
    const approved = await this._checkApproval(offer.auditSnapshot.committer)
    if (approved !== true) return { status: 'error', error: 'verifier_not_approved' }
    const validationError = validateRelayRequest(offer, this._options.node.peerId ?? '')
    if (validationError) return { status: 'error', error: validationError }
    const cached = this._options.storage.getRelayEntitlement(offer.job.auditId, offer.job.jobIndex)
    if (cached) {
      const sameAssignment = JSON.stringify(cached.assignment) === JSON.stringify(offer.assignment)
        && cached.verifierSignature.toLowerCase() === offer.verifierSignature.toLowerCase()
      if (!sameAssignment) return { status: 'error', error: 'conflicting_relay_assignment' }
      return {
        status: 'ok',
        responseBytesBase64: Buffer.from(cached.responseBytes).toString('base64'),
        responseAuthPayloadBase64: Buffer.from(cached.responseAuthPayload).toString('base64'),
        sellerChargeUsdc: cached.sellerChargeUsdc.toString(),
        paymentMetadata: cached.paymentMetadata,
      }
    }

    const jobKey = `${offer.job.auditId}:${offer.job.jobIndex}`
    const assignmentIdentity = `${JSON.stringify(offer.assignment)}:${offer.verifierSignature.toLowerCase()}`
    const inFlight = this._inFlightJobs.get(jobKey)
    if (inFlight) {
      if (inFlight.assignmentIdentity !== assignmentIdentity) {
        return { status: 'error', error: 'conflicting_relay_assignment' }
      }
      return inFlight.promise
    }

    const promise = this._executeNewOffer(verifier, offer)
    this._inFlightJobs.set(jobKey, { assignmentIdentity, promise })
    try {
      return await promise
    } finally {
      if (this._inFlightJobs.get(jobKey)?.promise === promise) this._inFlightJobs.delete(jobKey)
    }
  }

  private async _executeNewOffer(
    verifier: PeerInfo,
    offer: AuditRelayJobPayload,
  ): Promise<Omit<AuditRelayResultPayload, 'version' | 'jobId'>> {
    const now = Date.now()
    this._jobStartTimes = this._jobStartTimes.filter((startedAt) => now - startedAt < 3_600_000)
    if (this._jobStartTimes.length >= this._options.maxJobsPerHour) return { status: 'error', error: 'rate_limited' }
    if (this._activeJobs >= this._options.maxConcurrentJobs) return { status: 'error', error: 'busy' }

    this._jobStartTimes.push(now)
    this._activeJobs += 1
    const controller = new AbortController()
    this._activeJobAborts.add(controller)
    const timeoutMs = Math.min(Math.max(1, offer.timeoutMs), MAX_JOB_TIMEOUT_MS)
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    try {
      return await this._executeValidatedOffer(verifier, offer, controller.signal)
    } catch (error) {
      return { status: 'error', error: normalizeRelayError(error, controller.signal.aborted) }
    } finally {
      clearTimeout(timeout)
      this._activeJobAborts.delete(controller)
      this._activeJobs -= 1
    }
  }

  private async _scan(): Promise<void> {
    if (this._stopped || this._scanning) return
    this._scanning = true
    try {
      for (const peerId of this._serving) {
        const state = this._options.node.getPeerConnectionState(peerId)
        if (state === null || state === ConnectionState.Closed || state === ConnectionState.Failed) {
          this._serving.delete(peerId)
        }
      }
      const peers = await this._options.node.discoverPeers()
      for (const verifier of peers) {
        if (this._stopped) return
        if (!(verifier.capabilities ?? []).includes(CONNECTION_CAPABILITY_AUDIT_RELAY_V1)) continue
        if (this._serving.has(verifier.peerId) || this._isRejected(verifier.peerId)) continue
        await this._register(verifier)
      }
    } catch (error) {
      this._options.warn(`relay: verifier scan failed: ${(error as Error).message}`)
    } finally {
      this._scanning = false
    }
  }

  private async _register(verifier: PeerInfo): Promise<void> {
    const approved = await this._checkApproval(peerIdToAddress(verifier.peerId))
    if (approved !== true) {
      if (approved === false) this._reject(verifier.peerId)
      return
    }
    try {
      const welcome = await this._options.node.serveRelayJobs(
        verifier,
        {
          chainId: this._options.chainId,
          registryAddress: this._options.registryAddress,
          treasuryAddress: this._options.treasuryAddress,
          minPayoutPerJobUsdc: this._options.minimumPayoutPerJobUsdc.toString(),
          maxConcurrentJobs: this._options.maxConcurrentJobs,
        },
        (offer) => this.executeOffer(verifier, offer),
      )
      if (!welcome.accepted) {
        this._reject(verifier.peerId)
        this._options.warn(`relay: verifier ${verifier.peerId.slice(0, 12)}… rejected registration: ${welcome.reason ?? 'unknown'}`)
        return
      }
      this._serving.add(verifier.peerId)
      this._options.log(`relay: serving verifier ${verifier.peerId.slice(0, 12)}…`)
    } catch (error) {
      this._options.warn(`relay: registration failed for ${verifier.peerId.slice(0, 12)}…: ${(error as Error).message}`)
    }
  }

  private async _executeValidatedOffer(
    verifier: PeerInfo,
    offer: AuditRelayJobPayload,
    signal: AbortSignal,
  ): Promise<Omit<AuditRelayResultPayload, 'version' | 'jobId'>> {
    const { request, job } = await this._options.validator.validate(offer)
    if (signal.aborted) throw new Error('timeout')
    const target = await this._options.node.findPeer(offer.targetPeerId)
    if (!target) throw new Error('target_not_found')
    if (!advertisedServices(target).has(offer.service.trim().toLowerCase())) {
      throw new Error('target_does_not_serve_service')
    }

    const response = await this._options.node.sendRequest(target, request, { signal })
    if (response.body.byteLength > MAX_JOB_RESPONSE_BYTES) throw new Error('response_too_large')
    const authRecord = await this._options.node.waitForResponseAuth(request.requestId, remainingTimeout(offer, signal))
    const auth = toResponseAuthPayload(authRecord)
    const verification = verifyResponseAuth(auth, {
      request,
      response,
      buyerPeerId: this._options.node.peerId ?? '',
      sellerPeerId: target.peerId,
      advertisedService: offer.service,
      ...(auth.channelId ? { channelId: auth.channelId } : {}),
    })
    if (!authRecord.verified || !verification.valid) {
      throw new Error(`invalid_response_auth:${verification.reason ?? authRecord.verificationError ?? 'unverified'}`)
    }
    const windowStartMs = offer.assignment.executeAfter * 1_000
    const windowEndMs = offer.assignment.executeBefore * 1_000
    if (auth.responseStartedAt < windowStartMs
      || auth.responseCompletedAt < auth.responseStartedAt
      || auth.responseCompletedAt > windowEndMs) {
      throw new Error('response_auth_outside_execution_window')
    }
    if (hashRequest(request).toLowerCase() !== auth.requestHash.toLowerCase()
      || hashResponse(response).toLowerCase() !== auth.responseHash.toLowerCase()) {
      throw new Error('response_auth_hash_mismatch')
    }

    const payment = await this._options.node.finalizeResponsePayment(target)
    const payout = BigInt(offer.payoutPerJobUsdc)
    if (payment.sellerChargeUsdc > payout) throw new Error('seller_charge_exceeds_relay_payout')
    const responseBytes = encodeHttpResponse(response)
    const responseAuthPayload = encodeContractResponseAuthPayload(auth)
    const timestamp = Date.now()
    const paymentMetadata = {
      spendingAuth: payment.spendingAuth as unknown as Record<string, unknown>,
      requestId: request.requestId,
      requestHash: auth.requestHash,
      responseHash: auth.responseHash,
      verifierPeerId: verifier.peerId,
    }
    const entitlement: StoredRelayEntitlement = {
      auditId: job.auditId,
      jobIndex: job.jobIndex,
      relayPeerId: this._options.node.peerId ?? '',
      relayBuyerAddress: getAddress(this._options.relayBuyerAddress),
      registryAddress: getAddress(this._options.registryAddress),
      treasuryAddress: getAddress(this._options.treasuryAddress),
      job: { ...job },
      positionalProof: offer.jobProof,
      assignment: { ...offer.assignment },
      verifierSignature: offer.verifierSignature,
      responseBytes,
      responseAuthPayload,
      payoutUsdc: payout,
      sellerChargeUsdc: payment.sellerChargeUsdc,
      paymentMetadata,
      forceClaimAvailableAt: offer.auditSnapshot.forceClaimAvailableAt,
      forceClaimDeadline: offer.auditSnapshot.forceClaimDeadline,
      state: 'awaiting-attestation',
      claimTxHash: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    this._options.storage.persistRelayEntitlement(entitlement)

    return {
      status: 'ok',
      responseBytesBase64: Buffer.from(responseBytes).toString('base64'),
      responseAuthPayloadBase64: Buffer.from(responseAuthPayload).toString('base64'),
      sellerChargeUsdc: payment.sellerChargeUsdc.toString(),
      paymentMetadata,
    }
  }

  private async _checkApproval(address: string): Promise<boolean | null> {
    const normalized = getAddress(address)
    const cached = this._approvalCache.get(normalized)
    if (cached && Date.now() - cached.checkedAt < this._options.approvalTtlMs) return cached.approved
    try {
      const approved = await this._options.isApprovedVerifier(normalized)
      this._approvalCache.set(normalized, { approved, checkedAt: Date.now() })
      return approved
    } catch {
      return null
    }
  }

  private _isRejected(peerId: PeerId): boolean {
    const until = this._rejectedUntil.get(peerId)
    if (until === undefined) return false
    if (Date.now() >= until) {
      this._rejectedUntil.delete(peerId)
      return false
    }
    return true
  }

  private _reject(peerId: PeerId): void {
    this._rejectedUntil.set(peerId, Date.now() + this._options.rejectedTtlMs)
  }
}

export function validateRelayRequest(offer: AuditRelayJobPayload, selfPeerId: string): string | null {
  let requestBytes: Uint8Array
  try {
    const bytes = Buffer.from(offer.requestBytesBase64, 'base64')
    if (bytes.length === 0 || bytes.length > MAX_JOB_BODY_BYTES + 64 * 1024) return 'request_size_out_of_bounds'
    requestBytes = bytes
  } catch {
    return 'invalid_request_encoding'
  }
  const decoded = (() => {
    try {
      return decodeHttpRequest(requestBytes)
    } catch {
      return null
    }
  })()
  if (!decoded) return 'invalid_request_encoding'
  if (decoded.method !== 'POST') return 'unsupported_method'
  if (decoded.path !== '/v1/chat/completions') return 'unsupported_path'
  if (normalizePeerId(offer.targetPeerId) === normalizePeerId(selfPeerId)) return 'self_target'
  for (const header of Object.keys(decoded.headers)) {
    if (!ALLOWED_JOB_HEADERS.has(header.toLowerCase())) return `disallowed_header:${header}`
  }
  if (decoded.body.length === 0 || decoded.body.length > MAX_JOB_BODY_BYTES) return 'body_size_out_of_bounds'
  let body: Record<string, unknown>
  try {
    const parsed = JSON.parse(Buffer.from(decoded.body).toString('utf8')) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return 'body_not_json_object'
    body = parsed as Record<string, unknown>
  } catch {
    return 'body_not_json_object'
  }
  for (const field of Object.keys(body)) {
    if (!ALLOWED_JOB_BODY_FIELDS.has(field)) return `disallowed_body_field:${field}`
  }
  if (typeof body.model !== 'string' || body.model.trim() !== offer.service.trim()) return 'model_service_mismatch'
  if (body.stream === true) return 'streaming_not_allowed'
  if (!validCompletionBudget(body.max_tokens) && !validCompletionBudget(body.max_completion_tokens)) {
    return 'missing_or_invalid_completion_budget'
  }
  if (body.max_tokens !== undefined && !validCompletionBudget(body.max_tokens)) return 'max_tokens_out_of_bounds'
  if (body.max_completion_tokens !== undefined && !validCompletionBudget(body.max_completion_tokens)) {
    return 'max_completion_tokens_out_of_bounds'
  }
  if (body.reasoning_effort !== undefined
    && (typeof body.reasoning_effort !== 'string' || !ALLOWED_REASONING_EFFORTS.has(body.reasoning_effort))) {
    return 'invalid_reasoning_effort'
  }
  if (body.n !== undefined && body.n !== 1) return 'n_out_of_bounds'
  return null
}

function validCompletionBudget(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_JOB_MAX_TOKENS
}

function sameAddress(left: string, right: string): boolean {
  return getAddress(left.startsWith('0x') ? left : `0x${left}`) === getAddress(right.startsWith('0x') ? right : `0x${right}`)
}

function normalizePeerId(value: string): string {
  return value.startsWith('0x') ? value.slice(2).toLowerCase() : value.toLowerCase()
}

function remainingTimeout(offer: AuditRelayJobPayload, signal: AbortSignal): number {
  if (signal.aborted) return 1
  const windowRemainingMs = offer.assignment.executeBefore * 1_000 - Date.now()
  return Math.max(1, Math.min(offer.timeoutMs, windowRemainingMs))
}

function normalizeRelayError(error: unknown, aborted: boolean): string {
  if (aborted) return 'timeout'
  const message = error instanceof Error ? error.message : String(error)
  if (message === 'target_not_found' || message === 'target_does_not_serve_service') return message
  if (message.startsWith('invalid_response_auth:')) return message
  if (message.includes('aborted') || message.includes('AbortError')) return 'timeout'
  if (message.includes('HTTP') || message.includes('request')) return `seller_request_failed:${message}`
  return message
}
