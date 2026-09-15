import { randomUUID } from 'node:crypto'
import { TEE_BADGE_MAX_AGE_MS, TEE_MAX_AGE_MS, TEE_VERIFIER_ID, type TeeEvidence, type TeeSnapshot } from '@antseed/node/tee-status'
import { parseVerifierCapabilities } from '@antseed/node/verifier-capabilities'
import { selectVerifier, verifierSupportFingerprint, type VerifierPolicy, type VerifyOutcome } from '../plugins/verifier.js'

type Peer = { peerId: string; capabilities?: string[] }
type Entry = { fingerprint: string; outcome?: VerifyOutcome; checkedAt: number; expiresAt: number; pending?: Promise<VerifyOutcome> }

export class TeeVerification {
  readonly sessionId = randomUUID()
  private entries = new Map<string, Entry>()
  private closed = false
  private activeChecks = 0

  constructor(readonly policy: VerifierPolicy | undefined, private readonly now = Date.now) {}

  async verify(peer: Peer, policy: VerifierPolicy, run: () => Promise<VerifyOutcome>, force = false): Promise<VerifyOutcome> {
    return this.verifyCached(peer, policy, run, TEE_MAX_AGE_MS, force)
  }

  async verifyForDisplay(peer: Peer, run: () => Promise<VerifyOutcome>): Promise<VerifyOutcome> {
    return this.verifyCached(peer,
      { require: true, requireSellerNode: true, prefer: [TEE_VERIFIER_ID] }, run, TEE_BADGE_MAX_AGE_MS)
  }

  private cacheExpiry(entry: Entry, maxAgeMs: number): number {
    return entry.outcome?.sellerNodeVerified && !entry.outcome.transient
      ? entry.checkedAt + maxAgeMs : entry.expiresAt
  }

  private async verifyCached(peer: Peer, policy: VerifierPolicy, run: () => Promise<VerifyOutcome>, maxAgeMs: number, force = false): Promise<VerifyOutcome> {
    if (this.closed) return { ok: false, verified: false, reason: 'Buyer stopped', transient: true }
    const chosen = selectVerifier(policy, parseVerifierCapabilities(peer.capabilities))
    const fingerprint = verifierSupportFingerprint(peer.capabilities)
    const key = `${peer.peerId}|${chosen ?? ''}`
    const previous = this.entries.get(key)
    const allow = (outcome: VerifyOutcome): VerifyOutcome => ({
      ...outcome, ok: !policy.require || (policy.requireSellerNode ? outcome.sellerNodeVerified === true : outcome.verified),
    })
    if (previous?.fingerprint === fingerprint) {
      if (previous.pending) {
        const outcome = await previous.pending
        if (this.closed || this.entries.get(key) !== previous) {
          return { ok: !policy.require && !this.closed, verified: false, transient: true, reason: 'Verification session or seller capabilities changed' }
        }
        return allow(outcome)
      }
      if (!force && previous.outcome && !previous.outcome.transient && this.cacheExpiry(previous, maxAgeMs) > this.now()) return allow(previous.outcome)
    }
    if (this.activeChecks >= 8) {
      return { ok: !policy.require, verified: false, transient: true, reason: 'Verification busy; retry shortly' }
    }
    if (this.entries.size >= 512 && !this.entries.has(key)) {
      const oldest = [...this.entries].find(([, entry]) => !entry.pending)
      if (oldest) this.entries.delete(oldest[0])
    }
    const entry: Entry = { fingerprint, checkedAt: this.now(), expiresAt: 0 }
    this.entries.set(key, entry)
    this.activeChecks += 1
    entry.pending = Promise.resolve().then(run).catch((error: unknown): VerifyOutcome => ({
      ok: false, verified: false, transient: true, reason: error instanceof Error ? error.message : 'Verification unavailable',
    }))
    const outcome = await entry.pending
    this.activeChecks -= 1
    if (this.closed || this.entries.get(key) !== entry) {
      return { ok: !policy.require && !this.closed, verified: false, transient: true, reason: 'Verification session or seller capabilities changed' }
    }
    entry.pending = undefined
    entry.outcome = outcome
    entry.expiresAt = entry.checkedAt + TEE_MAX_AGE_MS
    return allow(outcome)
  }

  observePeers(peers: readonly Peer[]): void {
    const fingerprints = new Map(peers.map((peer) => [peer.peerId, verifierSupportFingerprint(peer.capabilities)]))
    for (const [key, entry] of this.entries) {
      if (fingerprints.get(key.split('|')[0]!) !== entry.fingerprint) this.entries.delete(key)
    }
  }

  snapshot(peers: readonly Peer[]): TeeSnapshot {
    const evidence: TeeEvidence[] = []
    this.observePeers(peers)
    for (const peer of peers) {
      if (!parseVerifierCapabilities(peer.capabilities).supported.includes(TEE_VERIFIER_ID)) continue
      const entry = this.entries.get(`${peer.peerId}|${TEE_VERIFIER_ID}`)
      if (!entry || entry.fingerprint !== verifierSupportFingerprint(peer.capabilities)) continue
      if (!entry.outcome && !entry.pending) continue
      evidence.push({
        peerId: peer.peerId, verifierId: TEE_VERIFIER_ID, verifierVersion: entry.outcome?.version,
        fingerprint: entry.fingerprint, checkedAt: entry.checkedAt, expiresAt: this.cacheExpiry(entry, TEE_BADGE_MAX_AGE_MS),
        sellerNodeVerified: entry.outcome?.sellerNodeVerified === true,
        claims: entry.outcome?.claims ?? [], reason: entry.outcome?.reason,
        checking: Boolean(entry.pending),
        unavailable: entry.outcome?.transient === true,
      })
    }
    return {
      sessionId: this.sessionId, mode: this.policy?.requireSellerNode ? 'required' : 'optional',
      verificationEnabled: Boolean(this.policy), requireVerifier: this.policy?.require ?? false,
      preferredVerifierIds: this.policy?.prefer ?? [], evidence,
    }
  }

  close(): void {
    this.closed = true
    this.entries.clear()
  }
}
