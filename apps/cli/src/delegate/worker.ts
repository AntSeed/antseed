import type {
  AntseedNode,
  DelegateVoucherPayload,
  PeerId,
  PeerInfo,
  ProbeJobRequestPayload,
  ProbeJobResultPayload,
  SerializedHttpRequest,
  StoredResponseAuth,
} from '@antseed/node'
import {
  CONNECTION_CAPABILITY_PROBE_DELEGATION_V1,
  ConnectionState,
  makeVerifierRegistryDomain,
  peerIdToAddress,
  recoverDelegateVoucherSigner,
} from '@antseed/node'
import type { VoucherStore } from './voucher-store.js'

const DEFAULT_MAX_CONCURRENT_JOBS = 2
const DEFAULT_MAX_JOBS_PER_HOUR = 60
const DEFAULT_DISCOVERY_INTERVAL_MS = 300_000
const MAX_JOB_BODY_BYTES = 256 * 1024
const MAX_JOB_TIMEOUT_MS = 120_000
const RESPONSE_AUTH_POLL_INTERVAL_MS = 500
const RESPONSE_AUTH_POLL_TIMEOUT_MS = 35_000
/**
 * Headers a probe request may carry. The request is relayed verbatim on this
 * buyer's identity and dime — anything beyond plain JSON chat metadata (e.g.
 * payment-control headers) is refused.
 */
const ALLOWED_JOB_HEADERS = new Set(['content-type', 'accept', 'user-agent'])

export interface DelegateWorkerOptions {
  node: AntseedNode
  /**
   * On-chain whitelist check. Serving an unapproved "verifier" would let
   * anyone use this buyer as a free request proxy — mandatory.
   */
  isApprovedVerifier: (address: string) => Promise<boolean>
  /**
   * Chain + registry the received vouchers must be claimable on. A voucher
   * naming any other domain is worthless to this buyer's operator and is
   * dropped with a warning.
   */
  expectedChainId: number
  verifierRegistryAddress: string
  /** Durable store for verified vouchers — the only proof of credits. */
  voucherStore: Pick<VoucherStore, 'add'>
  maxConcurrentJobs?: number
  maxJobsPerHour?: number
  discoveryIntervalMs?: number
  log: (message: string) => void
  warn: (message: string) => void
}

/**
 * Opt-in probe carrier: discovers whitelisted verifiers on the DHT, registers
 * as a delegate, and relays their probe requests verbatim over this node's
 * ordinary paid buyer path. Probe traffic thus originates from an organic
 * buyer identity, which is the whole point — the verifier whitelist is
 * public, so verifier-originated probes are classifiable by cheating sellers.
 *
 * Carried jobs earn verifier-signed DelegateVouchers naming this buyer. The
 * worker verifies each voucher's signature and domain and persists it; the
 * buyer's deposits operator claims them on-chain
 * (AntseedVerifierRegistry.claimDelegateCredits) and later collects the
 * delegate share of the verification emissions bucket.
 */
export class DelegateWorker {
  private readonly _options: Required<Pick<DelegateWorkerOptions, 'maxConcurrentJobs' | 'maxJobsPerHour' | 'discoveryIntervalMs'>> & DelegateWorkerOptions
  private _timer: ReturnType<typeof setInterval> | null = null
  private _stopped = false
  private _scanning = false
  private _activeJobs = 0
  private _jobStartTimes: number[] = []
  /** Verifier peerIds we are currently registered with. */
  private readonly _serving = new Set<PeerId>()
  /** Verifier peerIds rejected on-chain, so we don't re-check every scan. */
  private readonly _rejected = new Set<PeerId>()

  constructor(options: DelegateWorkerOptions) {
    this._options = {
      maxConcurrentJobs: options.maxConcurrentJobs ?? DEFAULT_MAX_CONCURRENT_JOBS,
      maxJobsPerHour: options.maxJobsPerHour ?? DEFAULT_MAX_JOBS_PER_HOUR,
      discoveryIntervalMs: options.discoveryIntervalMs ?? DEFAULT_DISCOVERY_INTERVAL_MS,
      ...options,
    }
  }

  start(): void {
    this._stopped = false
    void this._scan()
    this._timer = setInterval(() => {
      void this._scan()
    }, this._options.discoveryIntervalMs)
  }

  stop(): void {
    this._stopped = true
    if (this._timer) {
      clearInterval(this._timer)
      this._timer = null
    }
  }

  /** Verifier peerIds currently served (registered and connected). */
  get servingVerifiers(): string[] {
    return [...this._serving]
  }

  private async _scan(): Promise<void> {
    if (this._stopped || this._scanning) return
    this._scanning = true
    try {
      // Drop registrations whose connection died so the next pass reconnects.
      for (const peerId of this._serving) {
        const state = this._options.node.getPeerConnectionState(peerId)
        if (state === null || state === ConnectionState.Closed || state === ConnectionState.Failed) {
          this._serving.delete(peerId)
          this._options.log(`delegate: lost connection to verifier ${peerId.slice(0, 12)}…`)
        }
      }

      const peers = await this._options.node.discoverPeers()
      const verifiers = peers.filter((peer) =>
        (peer.capabilities ?? []).includes(CONNECTION_CAPABILITY_PROBE_DELEGATION_V1),
      )
      for (const verifier of verifiers) {
        if (this._stopped) return
        if (this._serving.has(verifier.peerId) || this._rejected.has(verifier.peerId)) continue
        await this._register(verifier)
      }
    } catch (err) {
      this._options.warn(`delegate: verifier scan failed: ${(err as Error).message}`)
    } finally {
      this._scanning = false
    }
  }

  private async _register(verifier: PeerInfo): Promise<void> {
    const address = peerIdToAddress(verifier.peerId)
    let approved = false
    try {
      approved = await this._options.isApprovedVerifier(address)
    } catch (err) {
      this._options.warn(`delegate: whitelist check failed for ${address.slice(0, 10)}…: ${(err as Error).message}`)
      return // transient — retry next scan
    }
    if (!approved) {
      // Announcing the capability without on-chain approval is either stale
      // config or someone hunting for free request proxies. Never serve it.
      this._options.warn(`delegate: ${verifier.peerId.slice(0, 12)}… announces delegation but is not an approved verifier; ignoring`)
      this._rejected.add(verifier.peerId)
      return
    }

    try {
      const welcome = await this._options.node.serveProbeJobs(
        verifier,
        { maxConcurrentJobs: this._options.maxConcurrentJobs },
        (job) => this._handleJob(job),
        (voucher) => this._handleVoucher(verifier, voucher),
      )
      if (!welcome.accepted) {
        this._options.warn(`delegate: verifier ${verifier.peerId.slice(0, 12)}… rejected registration: ${welcome.reason ?? 'unknown'}`)
        this._rejected.add(verifier.peerId)
        return
      }
      this._serving.add(verifier.peerId)
      this._options.log(`delegate: serving probe jobs for verifier ${verifier.peerId.slice(0, 12)}…`)
    } catch (err) {
      this._options.warn(`delegate: failed to register with ${verifier.peerId.slice(0, 12)}…: ${(err as Error).message}`)
    }
  }

  /**
   * Verify and persist a DelegateVoucher. Everything checkable locally is
   * checked before the voucher is stored: the claim domain must be the chain
   * + registry this buyer runs on, the named buyer must be this node, and
   * the EIP-712 signer must be the exact verifier peer being served — the
   * same identity the on-chain whitelist admitted at registration.
   */
  private async _handleVoucher(verifier: PeerInfo, voucher: DelegateVoucherPayload): Promise<void> {
    const short = verifier.peerId.slice(0, 12)
    if (voucher.chainId !== this._options.expectedChainId
      || voucher.registry.toLowerCase() !== this._options.verifierRegistryAddress.toLowerCase()) {
      this._options.warn(`delegate: dropping voucher from ${short}… for foreign domain (chain ${voucher.chainId}, registry ${voucher.registry.slice(0, 10)}…)`)
      return
    }
    const selfAddress = this._options.node.peerId ? peerIdToAddress(this._options.node.peerId) : null
    if (!selfAddress || voucher.buyer.toLowerCase() !== selfAddress.toLowerCase()) {
      this._options.warn(`delegate: dropping voucher from ${short}… naming a different buyer ${voucher.buyer.slice(0, 10)}…`)
      return
    }
    let signer: string
    try {
      signer = recoverDelegateVoucherSigner(
        makeVerifierRegistryDomain(voucher.chainId, voucher.registry),
        {
          buyer: voucher.buyer,
          probeCommitment: voucher.probeCommitment,
          credits: voucher.credits,
          nonce: BigInt(voucher.nonce),
          deadline: voucher.deadline,
        },
        voucher.signature,
      )
    } catch (err) {
      this._options.warn(`delegate: dropping voucher from ${short}… with unrecoverable signature: ${(err as Error).message}`)
      return
    }
    if (signer.toLowerCase() !== peerIdToAddress(verifier.peerId).toLowerCase()) {
      this._options.warn(`delegate: dropping voucher from ${short}… signed by ${signer.slice(0, 10)}… (not the serving verifier)`)
      return
    }
    try {
      const added = await this._options.voucherStore.add(voucher, verifier.peerId)
      if (added) {
        this._options.log(`delegate: voucher received from ${short}… — ${voucher.credits} credit(s), claimable by the operator until ${new Date(voucher.deadline * 1000).toISOString()}`)
      }
    } catch (err) {
      this._options.warn(`delegate: failed to persist voucher from ${short}…: ${(err as Error).message}`)
    }
  }

  private async _handleJob(job: ProbeJobRequestPayload): Promise<Omit<ProbeJobResultPayload, 'version' | 'jobId'>> {
    const validationError = validateProbeJob(job, this._options.node.peerId ?? '')
    if (validationError) return { status: 'error', error: validationError }

    const now = Date.now()
    this._jobStartTimes = this._jobStartTimes.filter((t) => now - t < 3_600_000)
    if (this._jobStartTimes.length >= this._options.maxJobsPerHour) {
      return { status: 'error', error: 'rate_limited' }
    }
    if (this._activeJobs >= this._options.maxConcurrentJobs) {
      return { status: 'error', error: 'busy' }
    }

    this._jobStartTimes.push(now)
    this._activeJobs += 1
    try {
      return await this._executeJob(job)
    } finally {
      this._activeJobs -= 1
    }
  }

  private async _executeJob(job: ProbeJobRequestPayload): Promise<Omit<ProbeJobResultPayload, 'version' | 'jobId'>> {
    const node = this._options.node
    const target = await node.findPeer(job.targetPeerId)
    if (!target) {
      return { status: 'error', error: 'target_not_found' }
    }

    // Relay byte-for-byte: the request hash is what the seller signs, so any
    // mutation here would just invalidate the observation at the verifier.
    const request: SerializedHttpRequest = {
      requestId: job.request.requestId,
      method: job.request.method,
      path: job.request.path,
      headers: job.request.headers,
      body: new Uint8Array(Buffer.from(job.request.bodyBase64, 'base64')),
    }

    let response
    try {
      response = await node.sendRequest(target, request)
    } catch (err) {
      return { status: 'error', error: `request_failed: ${(err as Error).message}` }
    }

    const auth = await this._waitForResponseAuth(
      job.request.requestId,
      Math.min(Math.max(1, job.timeoutMs), MAX_JOB_TIMEOUT_MS, RESPONSE_AUTH_POLL_TIMEOUT_MS),
    )

    return {
      status: 'ok',
      response: {
        statusCode: response.statusCode,
        headers: response.headers,
        bodyBase64: Buffer.from(response.body).toString('base64'),
      },
      // Full payload, not just the verified flag: the verifier re-verifies
      // the seller signature itself and trusts nothing this node claims.
      ...(auth ? { responseAuth: toResponseAuthPayload(auth) } : {}),
    }
  }

  private async _waitForResponseAuth(requestId: string, timeoutMs: number): Promise<StoredResponseAuth | null> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const record = this._options.node.getResponseAuth(requestId)
      if (record) return record
      if (Date.now() >= deadline) return null
      await new Promise((resolve) => setTimeout(resolve, RESPONSE_AUTH_POLL_INTERVAL_MS))
    }
  }
}

/**
 * Refuse anything but a plain JSON chat-completion relay: the job runs on
 * this buyer's identity and deposit, so the surface is kept as narrow as the
 * probes it exists to carry.
 */
export function validateProbeJob(job: ProbeJobRequestPayload, selfPeerId: string): string | null {
  if (job.request.method !== 'POST') return 'unsupported_method'
  if (job.request.path !== '/v1/chat/completions') return 'unsupported_path'
  if (job.targetPeerId.toLowerCase() === selfPeerId.toLowerCase()) {
    return 'self_target'
  }
  for (const header of Object.keys(job.request.headers)) {
    if (!ALLOWED_JOB_HEADERS.has(header.toLowerCase())) {
      return `disallowed_header:${header}`
    }
  }
  let body: Buffer
  try {
    body = Buffer.from(job.request.bodyBase64, 'base64')
  } catch {
    return 'invalid_body_encoding'
  }
  if (body.length === 0 || body.length > MAX_JOB_BODY_BYTES) return 'body_size_out_of_bounds'
  try {
    const parsed: unknown = JSON.parse(body.toString('utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return 'body_not_json_object'
  } catch {
    return 'body_not_json_object'
  }
  return null
}

function toResponseAuthPayload(stored: StoredResponseAuth): ProbeJobResultPayload['responseAuth'] {
  return {
    version: stored.version,
    requestId: stored.requestId,
    ...(stored.channelId ? { channelId: stored.channelId } : {}),
    buyerPeerId: stored.buyerPeerId,
    sellerPeerId: stored.sellerPeerId,
    advertisedService: stored.advertisedService,
    provider: stored.provider,
    statusCode: stored.statusCode,
    requestHash: stored.requestHash,
    responseHash: stored.responseHash,
    responseStartedAt: stored.responseStartedAt,
    responseCompletedAt: stored.responseCompletedAt,
    signature: stored.signature,
  }
}
