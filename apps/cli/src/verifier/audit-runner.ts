import { randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AntseedNode, ExchangeRecord, PeerInfo, ResponseAuthPayload, VerifierRegistryClient } from '@antseed/node'
import { buildResponseAuthSigningBytes, serviceHash, VERIFIER_VERDICT_UNKNOWN } from '@antseed/node'
import type { Identity } from '@antseed/node'
import type {
  CohortVerdictOptions,
  FingerprintReference,
  FingerprintVerdict,
  KbfProbe,
  PersistedCohortOptions,
  ProbeSet,
  ProbeSource,
  SellerObservation,
} from '@antseed/fingerprints'
import {
  generateProbeSet,
  compositionalProbeSource,
  probeBankSource,
  staticProbeSource,
  canonicalJsonStringify,
  computeProbeCommitment,
  computeCohortVerdicts,
  computeMatchVector,
  computeKbfVerdict,
  sha256Hex,
  verdictToCode,
} from '@antseed/fingerprints'
import { probeSeller } from './probing.js'
import type { SellerProbeRun } from './probing.js'
import { createServiceIdSetStore, loadUsedProbeIds, recordUsedProbeIds } from './probe-log.js'
import { canonicalProbeSetJson, writeAuditPack } from './pack-writer.js'
import { LLM_AUTHORED_SOURCE_ID } from './probe-author.js'
import { safeServiceSlug } from './slug.js'
import {
  MAX_AUDIT_BATCH_RECORDS,
  MAX_AUDIT_PROBES_PER_REQUEST,
  maxAuditRecordCount,
} from './limits.js'

export type ProbeSourceKind = 'llm' | 'compositional' | 'bank'

/**
 * Authors + certifies fresh probes for one audit round (probe-author.ts in
 * production; injectable for tests). `exclude` carries the rotation log so
 * re-authored duplicates of already-revealed probes are dropped at the
 * source. Throwing (upstream down, too few certified) makes the runner fall
 * back to the compositional source.
 */
export type ProbeAuthor = (params: {
  service: string
  count: number
  exclude: ReadonlySet<string>
}) => Promise<KbfProbe[]>

/**
 * Executes the probe plan against one seller and returns the observation.
 * The default executor probes directly from this node's buyer identity; the
 * delegated executor routes probes through organic delegate buyers and
 * reports which delegates (by peerId) carried verified jobs.
 */
export type ProbeExecutor = (
  peer: PeerInfo,
  service: string,
  probeSet: ProbeSet,
  maxProbesPerRequest: number,
) => Promise<{ run: SellerProbeRun; jobsByDelegate?: Map<string, number> }>

export interface AuditRunnerOptions {
  probesPerAudit: number
  /**
   * On-chain minimum probe count (AntseedVerifierRegistry.minProbeCount).
   * An audit whose effective probe count would fall below it is skipped
   * BEFORE committing or probing — the contract would reject every
   * attestation with ProbeCountTooLow after all probes were already paid for.
   */
  minProbeCount: number
  cohortMaxSize: number
  stalenessWindowSecs: number
  /** Max probes woven into a single stealth chat request (stealth vs. cost dial). */
  maxProbesPerRequest: number
  /**
   * Directory where the audit pack (`<probeCommitment>.json`, canonical JSON
   * whose SHA-256 is the on-chain evidenceHash) is published.
   */
  publishDir: string
  /**
   * Origin of probes when no reference matches the service. `llm` authors
   * fresh probes per round via `probeAuthor` (falling back to compositional
   * when authoring fails); `compositional` draws from a large rotating space;
   * `bank` uses the built-in fixture. When a reference IS present, its
   * certified probes are used regardless (reference mode).
   */
  probeSource: ProbeSourceKind
  /** Required for probeSource `llm`; ignored otherwise. */
  probeAuthor?: ProbeAuthor
  /**
   * Cohort-grading knobs. The EFFECTIVE (defaults-applied) numeric options are
   * used to grade AND persisted into the pack, so a re-runner re-grades with
   * the exact values the auditor used — not library defaults, which would be
   * faithful only by coincidence.
   */
  cohortVerdictOptions?: CohortVerdictOptions
  /**
   * Base URL under which packs are published (`<publishBaseUrl>/<commitment>.json`).
   * When set, this per-round pack URI is posted on-chain in the reveal so a
   * re-runner can fetch the pack from chain data alone. Empty when unset.
   */
  publishBaseUrl?: string
  /**
   * Pause between the round's attestations and the on-chain probe-set reveal.
   * Default 0 (reveal immediately); end-of-epoch batching is a future knob.
   * Implemented as a due time on the persisted pending-reveal queue — never
   * an inline sleep in the sequential audit loop.
   */
  revealDelayMs?: number
  /**
   * Directory holding the durable pending-reveal queue
   * (`pending-reveals.json`). Reveals are enqueued after attestation and
   * drained at round boundaries, so a failed or delayed reveal survives
   * restarts instead of being warn-and-forgotten.
   */
  revealQueueDir: string
  /** Directory holding the per-service probe rotation log. */
  probeLogDir: string
  /**
   * How many recently-used probe ids to remember per service and exclude from
   * future rounds. 0 disables rotation. Certified reference probes rotate on
   * reveal, not on send: their ids join the log when the reveal that
   * publishes them lands (see PendingReveal.burnReference).
   */
  probeRotationHistory: number
  /**
   * Original advertised spelling sent as the wire model id. Sellers match the
   * body's model field case-sensitively, so probing `Qwen/Qwen3-32B` as
   * `qwen/qwen3-32b` 404s forever. Defaults to `service` (the normalized key,
   * used for grouping/config/hash purposes only).
   */
  advertisedService?: string
  /** Per-peer advertised spelling override (peerId → exact spelling). */
  advertisedByPeer?: ReadonlyMap<string, string>
  /**
   * Burned referenceIds for this service, when the caller already loaded them
   * (start.ts consults the burn state while resolving the reference). Absent:
   * loaded from `probeLogDir` here.
   */
  burnedReferenceIds?: ReadonlySet<string>
  /**
   * Overrides how probes reach the seller. Absent: direct probing from this
   * node's own (verifier-linked, thus classifiable) buyer identity.
   */
  probeExecutor?: ProbeExecutor
  log: (message: string) => void
  warn: (message: string) => void
}

export interface SellerAuditOutcome {
  peerId: string
  agentId: number | undefined
  verdict: FingerprintVerdict
  cohortVerdict: FingerprintVerdict
  referenceVerdict?: FingerprintVerdict
  fullyAuthenticated: boolean
  attested: boolean
  /**
   * True when the on-chain attestation was actually CREDITED (moved
   * lastCreditedAt / epochCredits). The contract records attestations as
   * uncredited under its cooldown or per-epoch cap, so tx success alone must
   * not count against the audit budget.
   */
  credited: boolean
}

export interface CohortAuditResult {
  service: string
  probeCommitment: string
  evidenceHash: string
  /** Published audit pack (canonical JSON; sha256(file) == evidenceHash). */
  packPath: string
  cohortSize: number
  outcomes: SellerAuditOutcome[]
  /** On-chain exchange-batch root (undefined when nothing could be anchored). */
  batchRoot?: string
  anchorTx?: string
  revealTx?: string
}

/**
 * Select audit targets for one service, stalest first. Sellers must advertise
 * an on-chain agent id (attestations are keyed by agentId) and support
 * response-auth so probe evidence is attributable.
 */
export async function selectCohort(
  peers: PeerInfo[],
  service: string,
  registryClient: VerifierRegistryClient,
  options: Pick<AuditRunnerOptions, 'cohortMaxSize' | 'stalenessWindowSecs' | 'warn'>,
): Promise<PeerInfo[]> {
  const eligible = peers.filter((peer) => {
    if (!peer.onChainAgentId) return false
    return (peer.capabilities ?? []).includes('verification.response-auth.v1')
  })

  const withStaleness = await Promise.all(eligible.map(async (peer) => {
    let lastCredited = 0
    try {
      lastCredited = await registryClient.lastCreditedAt(peer.onChainAgentId!, service)
    } catch (err) {
      options.warn(`staleness read failed for agent ${peer.onChainAgentId}: ${(err as Error).message}`)
    }
    return { peer, lastCredited }
  }))

  const nowSecs = Math.floor(Date.now() / 1000)
  // Stale sellers earn credits; fresh ones are still useful as cohort
  // consensus members, so they rank after the stale ones instead of being
  // dropped outright.
  withStaleness.sort((a, b) => a.lastCredited - b.lastCredited)

  // Dedupe by agentId, keeping the stalest peer (the list is already
  // stalest-first). computeCohortVerdicts collapses to one vote per agentId,
  // so two peers sharing an agentId would desync the graded observations from
  // both the anchored exchange batch and the pack build (whose per-peer
  // `.find` on the cohort verdicts throws) — a committed+anchored+attested
  // round could then never reveal or publish. Deduping here keeps the cohort,
  // the batch, and the pack in lockstep. (It also denies a seller that
  // announces one agentId under several peerIds any dilution of its own audit.)
  const seenAgents = new Set<number>()
  const deduped = withStaleness.filter((e) => {
    const agentId = e.peer.onChainAgentId!
    if (seenAgents.has(agentId)) return false
    seenAgents.add(agentId)
    return true
  })

  const stale = deduped.filter((e) => nowSecs - e.lastCredited >= options.stalenessWindowSecs)
  const fresh = deduped.filter((e) => nowSecs - e.lastCredited < options.stalenessWindowSecs)
  return [...stale, ...fresh].slice(0, options.cohortMaxSize).map((e) => e.peer)
}

/**
 * Merge a cohort-consensus verdict with an optional trusted-reference verdict.
 * Shared verbatim with `antseed audit verify` (imported there) so the on-chain
 * verdict and its recomputation stay in lockstep — a re-runner recomputes both
 * components and requires this combination to equal the attested verdict.
 *
 * A certified reference is independent ground truth (single-seller audits rely
 * on it alone), so it OVERRIDES the cohort in BOTH directions:
 *   - reference DIFF → DIFF: adverse evidence a colluding cohort can't bury.
 *   - reference SAME → SAME: exoneration a POISONED cohort can't override — a
 *     seller whose answers match the trusted reference serves the right model
 *     even if a cohort majority (which could all be serving one substitute, or
 *     be sybils) reports DIFF. Without this, a poisoned cohort frames an honest
 *     seller the reference vindicates.
 * A reference UNKNOWN/UNDETERMINED carries no signal, so the cohort stands.
 */
export function combineVerdicts(
  cohortVerdict: FingerprintVerdict,
  referenceVerdict: FingerprintVerdict | undefined,
): FingerprintVerdict {
  if (referenceVerdict === 'DIFF') return 'DIFF'
  if (referenceVerdict === 'SAME') return 'SAME'
  return cohortVerdict
}

/**
 * Default cohort-grading knobs, mirroring @antseed/fingerprints' internal
 * defaults. Resolving them here (rather than passing `{}` and relying on the
 * library's own defaults) lets the audit persist the EXACT options it graded
 * with into the pack, so a re-runner reproduces the verdicts precisely.
 */
const DEFAULT_COHORT_OPTIONS: PersistedCohortOptions = {
  alpha: 0.05,
  minConsensusProbes: 10,
  minCoverage: 0.5,
  epsilon: 0.02,
  minConsensusSellers: 3,
}

/** Resolve the effective (defaults-applied) numeric cohort-grading options. */
function resolveCohortOptions(options?: CohortVerdictOptions): PersistedCohortOptions {
  return {
    alpha: options?.alpha ?? DEFAULT_COHORT_OPTIONS.alpha,
    minConsensusProbes: options?.minConsensusProbes ?? DEFAULT_COHORT_OPTIONS.minConsensusProbes,
    minCoverage: options?.minCoverage ?? DEFAULT_COHORT_OPTIONS.minCoverage,
    epsilon: options?.epsilon ?? DEFAULT_COHORT_OPTIONS.epsilon,
    minConsensusSellers: options?.minConsensusSellers ?? DEFAULT_COHORT_OPTIONS.minConsensusSellers,
  }
}

/**
 * ResponseAuth signatures are unprefixed hex (bytesToHex in @antseed/node);
 * the exchange-batch leaf derivation and the contract's `bytes` calldata need
 * 0x-prefixed BytesLike.
 */
function toBytesLikeSignature(signature: string): string {
  return signature.startsWith('0x') ? signature : `0x${signature}`
}

/**
 * Drop the `signature` field so the remaining payload is the exact preimage
 * the seller signed — what `buildResponseAuthSigningBytes` serializes and the
 * contract recomputes its EIP-191 digest over at anchor time.
 */
function stripResponseAuthSignature(
  auth: ResponseAuthPayload,
): Omit<ResponseAuthPayload, 'signature'> {
  const { signature: _signature, ...unsigned } = auth
  return unsigned
}

// ---------------------------------------------------------------------------
// Burned references (burn-and-refresh)
//
// A reveal publishes every probe of the round WITH its expected consensus
// answer, so the first reveal that includes a certified reference's probes
// makes them replayable: a substituting seller can scrape the reveal and echo
// the published answers, and — because a reference SAME overrides a cohort
// DIFF in combineVerdicts — a replayable reference would permanently exonerate
// it. The fix is to burn the reference the moment its reveal lands: burned
// references are never used for reference-mode grading again, their revealed
// probe ids join the rotation log (so LLM authoring never re-selects them),
// and the daemon re-enrolls a fresh reference. Until one exists, grading
// falls back to cohort-only (no reference verdict at all).
// ---------------------------------------------------------------------------

/** One `<slug>.burned.json` per service, listing referenceIds whose probes
 * have appeared in an on-chain reveal. */
const burnedReferencesStore = createServiceIdSetStore('.burned.json', 'burnedReferenceIds')

/** Load the burned referenceIds for a service (empty on any read error). */
export async function loadBurnedReferenceIds(dir: string, service: string): Promise<Set<string>> {
  return burnedReferencesStore.load(dir, service)
}

/** Persist a reference as burned for a service (idempotent). */
export async function recordBurnedReference(
  dir: string,
  service: string,
  referenceId: string,
  now: string,
): Promise<void> {
  const existing = await loadBurnedReferenceIds(dir, service)
  existing.add(referenceId)
  await burnedReferencesStore.save(dir, service, [...existing], now)
}

// ---------------------------------------------------------------------------
// Durable pending-reveal queue
//
// Reveals are persisted BEFORE they are attempted: the contract has no reveal
// deadline, so a reveal that fails (RPC outage) or is intentionally held back
// (`revealDelayMs`) is retried at the next round boundary — across daemon
// restarts — instead of being forgotten. The queue is one JSON file under
// the verifier data dir, drained at daemon startup and at the start of every
// round (and immediately after each round's attestations, which is how a
// revealDelayMs of 0 still reveals in-round).
// ---------------------------------------------------------------------------

/** One queued on-chain probe-set reveal. */
export interface PendingReveal {
  service: string
  probeCommitment: string
  /** Exact canonical bytes whose sha256 must equal the commitment. */
  probeSetJson: string
  /** On-chain pack pointer posted with the reveal ('' when unconfigured). */
  packUri: string
  /** ISO timestamp; the reveal is not attempted before this. */
  dueAt: string
  /**
   * Present when the revealed set is a certified reference's probes: the
   * reveal publishes them WITH expected answers, so the reference must be
   * burned (and its ids rotation-logged) the moment the reveal lands.
   */
  burnReference?: { referenceId: string; probeIds: string[] }
}

interface PendingRevealsFile {
  version: 1
  reveals: PendingReveal[]
}

function pendingRevealsPath(dir: string): string {
  return join(dir, 'pending-reveals.json')
}

/** Load the persisted pending reveals (empty on any read error). */
export async function loadPendingReveals(dir: string): Promise<PendingReveal[]> {
  try {
    const raw = await readFile(pendingRevealsPath(dir), 'utf8')
    const parsed = JSON.parse(raw) as Partial<PendingRevealsFile>
    if (!Array.isArray(parsed.reveals)) return []
    return parsed.reveals.filter((entry): entry is PendingReveal =>
      typeof entry?.probeCommitment === 'string'
      && typeof entry?.probeSetJson === 'string'
      && typeof entry?.service === 'string')
  } catch {
    return []
  }
}

async function savePendingReveals(dir: string, reveals: PendingReveal[]): Promise<void> {
  const file: PendingRevealsFile = { version: 1, reveals }
  await mkdir(dir, { recursive: true })
  await writeFile(pendingRevealsPath(dir), JSON.stringify(file, null, 2))
}

async function enqueuePendingReveal(dir: string, reveal: PendingReveal): Promise<void> {
  const existing = await loadPendingReveals(dir)
  // Commitments are per-round random, so a duplicate means a stale entry for
  // the same commitment — replace it rather than double-revealing.
  const merged = existing.filter((entry) => entry.probeCommitment !== reveal.probeCommitment)
  merged.push(reveal)
  await savePendingReveals(dir, merged)
}

/** The slice of AuditRunnerOptions the reveal queue needs (start.ts passes it standalone). */
export interface RevealQueueOptions {
  revealQueueDir: string
  probeLogDir: string
  probeRotationHistory: number
  log: (message: string) => void
  warn: (message: string) => void
}

/** Attempt one pending reveal; returns the tx hash, or undefined on failure. */
async function attemptReveal(
  identity: Identity,
  registryClient: VerifierRegistryClient,
  entry: PendingReveal,
  options: RevealQueueOptions,
): Promise<string | undefined> {
  const { log, warn } = options
  let tx: string
  try {
    tx = await registryClient.revealProbeSet(identity.wallet, {
      probeCommitment: entry.probeCommitment,
      probeSetJson: entry.probeSetJson,
      packUri: entry.packUri,
    })
  } catch (err) {
    warn(`probe set reveal failed for ${entry.probeCommitment.slice(0, 10)}…: ${(err as Error).message} (kept queued for retry)`)
    return undefined
  }
  log(`Revealed probe set for commitment ${entry.probeCommitment.slice(0, 10)}… (tx ${tx.slice(0, 10)}…)`)
  // The reveal just published these probes with their expected answers —
  // burn the reference and rotation-log the ids so nothing reuses them.
  if (entry.burnReference) {
    const now = new Date().toISOString()
    await recordBurnedReference(options.probeLogDir, entry.service, entry.burnReference.referenceId, now)
      .catch((err) => warn(
        `reference burn marker write failed for ${entry.service} — the revealed reference `
        + `could be replayed until it is marked burned: ${(err as Error).message}`,
      ))
    if (options.probeRotationHistory > 0) {
      await recordUsedProbeIds(
        options.probeLogDir,
        entry.service,
        entry.burnReference.probeIds,
        options.probeRotationHistory,
        now,
      ).catch((err) => warn(`probe rotation log write failed for ${entry.service}: ${(err as Error).message}`))
    }
  }
  return tx
}

/**
 * Attempt every DUE pending reveal (dueAt <= now). Successes leave the queue
 * (after burn-and-refresh bookkeeping for reference reveals); failures stay
 * queued with a warning — the contract has no reveal deadline, so retrying at
 * the next round boundary or after a restart is always safe. Returns
 * probeCommitment → revealTx for the reveals that landed.
 */
export async function drainPendingReveals(
  identity: Identity,
  registryClient: VerifierRegistryClient,
  options: RevealQueueOptions,
  now: number = Date.now(),
): Promise<Map<string, string>> {
  const pending = await loadPendingReveals(options.revealQueueDir)
  if (pending.length === 0) return new Map()
  const revealed = new Map<string, string>()
  const remaining: PendingReveal[] = []
  for (const entry of pending) {
    const dueAt = Date.parse(entry.dueAt)
    // An unparseable dueAt counts as due — better to retry than to strand.
    if (Number.isFinite(dueAt) && dueAt > now) {
      remaining.push(entry)
      continue
    }
    const tx = await attemptReveal(identity, registryClient, entry, options)
    if (tx !== undefined) revealed.set(entry.probeCommitment, tx)
    else remaining.push(entry)
  }
  if (revealed.size > 0) {
    await savePendingReveals(options.revealQueueDir, remaining)
      .catch((err) => options.warn(`pending-reveal queue write failed: ${(err as Error).message}`))
  }
  return revealed
}

/** All-null placeholder run for a seller whose probe execution itself failed. */
function failedRun(peer: PeerInfo, probeCount: number, error: string): SellerProbeRun {
  return {
    peerId: peer.peerId,
    agentId: peer.onChainAgentId,
    answers: new Array<number | null>(probeCount).fill(null),
    requestIds: [],
    probesPerRequest: [],
    responseAuths: [],
    exchanges: [],
    fullyAuthenticated: false,
    errors: [error],
  }
}

/**
 * Select the probe origin for a non-reference audit round, honoring the
 * llm → compositional → bank fallback order. The llm author receives the
 * rotation exclusions itself (content-derived dedupe) and returns a fresh
 * pool, so the returned `exclude` is empty on that path; the static-pool
 * paths keep the loaded exclusions for `generateProbeSet` rotation.
 */
async function selectProbeSource(
  service: string,
  usedIds: Set<string>,
  options: Pick<AuditRunnerOptions, 'probeSource' | 'probeAuthor' | 'probesPerAudit' | 'warn'>,
): Promise<{ source: ProbeSource; exclude: Set<string> }> {
  if (options.probeSource === 'llm') {
    if (options.probeAuthor) {
      try {
        const authored = await options.probeAuthor({
          service,
          count: options.probesPerAudit,
          exclude: usedIds,
        })
        if (authored.length > 0) {
          return { source: staticProbeSource(LLM_AUTHORED_SOURCE_ID, authored), exclude: new Set() }
        }
        options.warn(`${service}: LLM probe author returned no probes; falling back to compositional`)
      } catch (err) {
        options.warn(`${service}: LLM probe authoring failed (${(err as Error).message}); falling back to compositional`)
      }
    } else {
      options.warn(`${service}: probeSource "llm" but no probe author configured (verifier.upstream missing?); falling back to compositional`)
    }
    return { source: compositionalProbeSource(), exclude: usedIds }
  }
  return {
    source: options.probeSource === 'bank' ? probeBankSource() : compositionalProbeSource(),
    exclude: usedIds,
  }
}

/**
 * Run one cohort audit round for a service (transparent-audit sequencing):
 * generate/author probes → commit probe set on-chain → probe every cohort
 * member with identical batches → **anchor** every verified exchange
 * (agentId, requestHash, responseHash, responseAuthSig) on-chain as one batch
 * → cohort-consensus verdicts (+ optional KBF reference verdicts) → publish
 * the audit pack → attest each seller on-chain against the anchored batch
 * root → **reveal** the exact committed probe-set bytes on-chain.
 *
 * Returns null when the audit is skipped before any money moves (probe pool
 * too small for the on-chain minProbeCount).
 */
export async function runCohortAudit(
  node: AntseedNode,
  identity: Identity,
  registryClient: VerifierRegistryClient,
  service: string,
  cohort: PeerInfo[],
  reference: FingerprintReference | undefined,
  options: AuditRunnerOptions,
): Promise<CohortAuditResult | null> {
  const { log, warn } = options

  // Fail fast on hostile service names (e.g. "..") BEFORE any on-chain
  // commit or probe spend — the slug builds the rotation-log path.
  safeServiceSlug(service)

  if (
    !Number.isInteger(options.maxProbesPerRequest)
    || options.maxProbesPerRequest < 1
    || options.maxProbesPerRequest > MAX_AUDIT_PROBES_PER_REQUEST
  ) {
    warn(
      `${service}: maxProbesPerRequest must be an integer in [1, ${MAX_AUDIT_PROBES_PER_REQUEST}]; `
        + 'skipping audit (no commit, no probes)',
    )
    return null
  }

  // Choose the probe origin. A reference that matches the service is scored
  // against its certified answers (reference mode) — unless a past reveal
  // already published its probes (burned): the expected answers are public,
  // so a substituting seller could replay them and, via the reference-SAME
  // override in combineVerdicts, be permanently exonerated. A burned
  // reference falls back to cohort-only grading (no reference verdict) until
  // a fresh reference is enrolled. Otherwise author fresh probes (llm) or
  // draw from a large rotating source so a seller cannot memorize a finite
  // bank.
  let referenceMode = false
  let source: ProbeSource
  let exclude: Set<string>
  if (
    reference?.selfTest
    && !(options.burnedReferenceIds ?? await loadBurnedReferenceIds(options.probeLogDir, service)).has(reference.referenceId)
  ) {
    referenceMode = true
    source = staticProbeSource(reference.referenceId, reference.probes, { consensusCertified: true })
    exclude = new Set()
  } else {
    if (reference?.selfTest) {
      warn(
        `${service}: reference ${reference.referenceId.slice(0, 18)}… was revealed in a past audit (burned); `
          + 'grading cohort-only until a fresh reference is enrolled',
      )
    }
    // Rotation exclusions load only on this path (reference mode never
    // consults them): the llm author dedupes its candidates against them,
    // and the static-pool paths feed them into generateProbeSet.
    const usedIds = options.probeRotationHistory > 0
      ? await loadUsedProbeIds(options.probeLogDir, service)
      : new Set<string>()
    const selected = await selectProbeSource(service, usedIds, options)
    source = selected.source
    exclude = selected.exclude
  }

  // Rotation: record probes revealed against this service. Only for
  // non-certified sources here — certified reference probes rotate on reveal
  // instead (the reveal drain records them and burns the reference; see
  // PendingReveal.burnReference).
  const rotationEnabled = !source.consensusCertified && options.probeRotationHistory > 0

  // Never ask for more probes than the live pool can supply. When rotation
  // has exhausted the pool, expire the OLDEST exclusions (an explicit new
  // rotation cycle) instead of forcing a positive count against an empty
  // pool — generateProbeSet would throw and permanently kill this service's
  // audits. loadUsedProbeIds preserves file order, so Set iteration order is
  // oldest-first.
  const targetCount = Math.min(options.probesPerAudit, source.size)
  if (source.size - exclude.size < targetCount) {
    const toExpire = targetCount - (source.size - exclude.size)
    let expired = 0
    for (const id of exclude) {
      if (expired >= toExpire) break
      exclude.delete(id)
      expired += 1
    }
    warn(
      `${service}: probe pool for source ${source.id} exhausted by rotation; ` +
        `expired ${expired} oldest exclusion(s) to start a new rotation cycle`,
    )
  }
  const count = Math.min(options.probesPerAudit, source.size - exclude.size)
  if (count < options.probesPerAudit) {
    warn(
      `${service}: probe pool for source ${source.id} down to ${source.size - exclude.size}; ` +
        `auditing with ${count} probes this round`,
    )
  }

  // The contract rejects attestations below minProbeCount — skip BEFORE
  // committing or sending a single paid probe. (Also skips a fully empty
  // pool: a positive count is never forced against one.)
  if (count < Math.max(1, options.minProbeCount)) {
    warn(
      `${service}: effective probe count ${count} < on-chain minProbeCount ${options.minProbeCount}; ` +
        'skipping audit (no commit, no probes)',
    )
    return null
  }

  const maxRecords = maxAuditRecordCount(cohort.length, count, options.maxProbesPerRequest)
  if (maxRecords > MAX_AUDIT_BATCH_RECORDS) {
    warn(
      `${service}: configured round can produce ${maxRecords} exchange records, exceeding the on-chain `
        + `limit of ${MAX_AUDIT_BATCH_RECORDS}; reduce cohortMaxSize/probesPerAudit or increase `
        + 'maxProbesPerRequest (up to 3). Skipping audit (no commit, no probes)',
    )
    return null
  }

  // Fresh private probe set per round. The seed is random — determinism is
  // only needed for later re-verification, which the persisted probe set in
  // the evidence bundle provides.
  const probeSet = generateProbeSet({
    service,
    count,
    seed: randomBytes(32).toString('hex'),
    source,
    ...(exclude.size > 0 ? { exclude } : {}),
  })
  const probeCommitment = computeProbeCommitment(probeSet)

  // Commit BEFORE any probe leaves this machine. The contract rejects
  // attestations whose commitment is not strictly older than the submission,
  // which is what makes fabricated-after-the-fact results detectable.
  log(`Committing probe set ${probeCommitment.slice(0, 10)}… on-chain`)
  await registryClient.commitProbeSet(identity.wallet, probeCommitment)

  const execute: ProbeExecutor = options.probeExecutor
    ?? (async (target, svc, probes, maxPerRequest) => ({
      run: await probeSeller(node, target, svc, probes, maxPerRequest),
    }))

  const runs: SellerProbeRun[] = []
  for (const peer of cohort) {
    // Wire model id: the exact spelling this peer advertises (sellers match
    // it case-sensitively); normalized `service` is only a grouping key.
    const wireService = options.advertisedByPeer?.get(peer.peerId)
      ?? options.advertisedService
      ?? service
    log(`Probing ${peer.peerId.slice(0, 10)}… (agent ${peer.onChainAgentId}) with ${probeSet.probes.length} probes`)
    // Per-seller error boundary: one seller's probe path blowing up (e.g.
    // the last delegate disconnecting mid-audit) must not discard the whole
    // committed, partially-paid cohort audit.
    let run: SellerProbeRun
    try {
      const outcome = await execute(peer, wireService, probeSet, options.maxProbesPerRequest)
      run = outcome.run
    } catch (err) {
      warn(`  ${peer.peerId.slice(0, 10)}…: probe execution failed: ${(err as Error).message}`)
      run = failedRun(peer, probeSet.probes.length, `probe execution failed: ${(err as Error).message}`)
    }
    for (const error of run.errors) warn(`  ${peer.peerId.slice(0, 10)}…: ${error}`)
    runs.push(run)
  }

  // Record probe reveals only AFTER probes were actually sent. Recording
  // before the on-chain commit burned never-revealed probes into the
  // rotation log whenever the commit (or anything before dispatch) aborted.
  if (rotationEnabled) {
    await recordUsedProbeIds(
      options.probeLogDir,
      service,
      probeSet.probes.map((p) => p.id),
      options.probeRotationHistory,
      new Date().toISOString(),
    ).catch((err) => warn(`probe rotation log write failed for ${service}: ${(err as Error).message}`))
  }

  const observations: SellerObservation[] = runs.map((run) => ({
    sellerPeerId: run.peerId,
    agentId: run.agentId ?? 0,
    answers: run.answers,
    requestIds: run.requestIds,
    responseAuthHashes: run.responseAuths
      .filter((auth): auth is NonNullable<typeof auth> => auth !== null)
      .map((auth) => ({ requestHash: auth.requestHash, responseHash: auth.responseHash })),
  }))

  // Anchor BEFORE grading or attesting: every verified exchange of the round
  // — (agentId, requestHash, responseHash, responseAuthSig) — goes on-chain
  // as one batch, and the contract recomputes the Merkle root from calldata.
  // Verdicts then reference data that is already publicly bound; without an
  // anchored batch no attestation can be submitted at all.
  const records: ExchangeRecord[] = []
  // Per-record ResponseAuth signing preimages, aligned with `records`. The
  // contract re-derives each record's seller from its agentId and REVERTS
  // unless the record's `responseAuthSig` recovers to that seller over the
  // EIP-191 digest of this exact payload — so only exchanges whose seller
  // signature is genuine may be anchored. We only push records whose full
  // ResponseAuth verified locally (probing sets `exchange.responseAuth` only
  // for a verified StoredResponseAuth), so a bad signature can never reach
  // the anchor call.
  const signingPayloads: Uint8Array[] = []
  // Per-record stealth probe-bundle size, aligned with `records` — each >= 1,
  // so the batch's contract-summed probeCount always clears the >= records
  // floor. A partially-authenticated seller contributes only its verified
  // (anchored) requests.
  const recordProbeCounts: number[] = []
  for (const run of runs) {
    if (!run.agentId) continue
    run.exchanges.forEach((exchange, i) => {
      const auth = exchange.responseAuth
      // Defensive local pre-check mirroring the contract: skip any exchange
      // without a verified ResponseAuth AND any whose slim `responseAuths`
      // entry (set together, from the same verified record) is absent — the
      // contract reverts the WHOLE batch on a single bad signature, so nothing
      // unverified may be anchored.
      if (!auth || !run.responseAuths[i]) return
      records.push({
        agentId: BigInt(run.agentId!),
        requestHash: auth.requestHash,
        responseHash: auth.responseHash,
        responseAuthSig: toBytesLikeSignature(auth.signature),
      })
      signingPayloads.push(buildResponseAuthSigningBytes(stripResponseAuthSignature(auth)))
      recordProbeCounts.push(Math.max(1, run.probesPerRequest[i] ?? 1))
    })
  }
  let batchRoot: string | undefined
  let anchorTx: string | undefined
  if (records.length > 0) {
    try {
      const anchored = await registryClient.anchorExchangeBatch(identity.wallet, {
        probeCommitment,
        records,
        signingPayloads,
        recordProbeCounts,
      })
      batchRoot = anchored.batchRoot
      anchorTx = anchored.txHash
      log(`Anchored ${records.length} exchange(s): batch root ${batchRoot.slice(0, 10)}… (tx ${anchorTx.slice(0, 10)}…)`)
    } catch (err) {
      warn(`exchange batch anchoring failed: ${(err as Error).message}; skipping attestations and reveal this round`)
    }
  } else {
    warn(`${service}: no verified exchanges to anchor; skipping attestations and reveal`)
  }

  // Effective grading options, resolved once and persisted into the pack so a
  // re-runner re-grades with the exact values used here (not library defaults).
  const cohortOptions = resolveCohortOptions(options.cohortVerdictOptions)
  const cohortResult = computeCohortVerdicts(observations, probeSet.probes, cohortOptions)

  const outcomes: SellerAuditOutcome[] = []
  for (const run of runs) {
    const sellerVerdict = cohortResult.verdicts.find((v) => v.sellerPeerId === run.peerId)
    const cohortVerdict = sellerVerdict?.verdict ?? 'UNDETERMINED'

    let referenceVerdict: FingerprintVerdict | undefined
    if (referenceMode && reference?.selfTest) {
      // Reference mode only: the probe set IS the reference's certified probes,
      // so scoring answers against their consensus is meaningful. Compositional
      // and bank probes carry advisory consensus and MUST NOT reach this path
      // (they would mismatch every seller and forge a bogus DIFF).
      const matchVector = computeMatchVector(run.answers, probeSet.probes)
      referenceVerdict = computeKbfVerdict({
        selfHamming: reference.selfTest.hamming,
        selfTotal: reference.selfTest.total,
        targetMatchVector: matchVector,
      }).verdict
    }

    outcomes.push({
      peerId: run.peerId,
      agentId: run.agentId,
      verdict: combineVerdicts(cohortVerdict, referenceVerdict),
      cohortVerdict,
      ...(referenceVerdict !== undefined ? { referenceVerdict } : {}),
      fullyAuthenticated: run.fullyAuthenticated,
      attested: false,
      credited: false,
    })
  }

  // Audit pack (the evidence bundle, published): enough material for a third
  // party to re-run the whole audit from public data — the revealed probe
  // set, full ResponseAuth payloads, and the exact request/response bytes the
  // anchored hashes commit to. Written BEFORE attesting so a crash between
  // attestation and publication can never leave an on-chain evidenceHash
  // whose pack was lost.
  const evidenceBundle = {
    version: 1 as const,
    service,
    verifierAddress: identity.wallet.address,
    probeSet,
    sellers: runs.map((run, i) => {
      const sellerVerdict = cohortResult.verdicts.find((v) => v.sellerPeerId === run.peerId)!
      const outcome = outcomes[i]!
      return {
        ...observations[i]!,
        verdict: outcome.verdict,
        // Persist the pre-combination components so a re-runner recomputes the
        // combination that produced `verdict` (H1: never blanket-trust a DIFF).
        cohortVerdict: outcome.cohortVerdict,
        ...(outcome.referenceVerdict !== undefined ? { referenceVerdict: outcome.referenceVerdict } : {}),
        stats: sellerVerdict.stats,
        fullyAuthenticated: run.fullyAuthenticated,
        ...(run.carrierCount !== undefined ? { carrierCount: run.carrierCount } : {}),
        exchanges: run.exchanges,
      }
    }),
    cohort: cohortResult,
    // Effective grading options + stealth bundling factor, so a re-runner
    // reproduces the verdicts and the request plans exactly.
    cohortOptions,
    maxProbesPerRequest: options.maxProbesPerRequest,
    // Reference-mode inputs (self-test) let a re-runner recompute the reference
    // verdict behind each combined verdict. Present only in reference mode.
    ...(referenceMode && reference?.selfTest
      ? { reference: { selfTest: { hamming: reference.selfTest.hamming, total: reference.selfTest.total } } }
      : {}),
    createdAt: new Date().toISOString(),
  }
  // The pack file IS the canonical serialization of the bundle and the
  // on-chain evidenceHash is sha256 over those exact bytes (see
  // computeEvidenceHash) — serialize once, hash and write the same string.
  const packJson = canonicalJsonStringify(evidenceBundle)
  const evidenceHash = `0x${sha256Hex(packJson)}`
  const packPath = await writeAuditPack(options.publishDir, probeCommitment, packJson)
  log(`Audit pack ${evidenceHash.slice(0, 10)}… written to ${packPath}`)

  // Corroboration note: a SAME verdict carried by a single delegate is weaker
  // evidence — a colluding lone carrier could have served the real model only
  // to itself. Still attested (single carriers are legitimate when that is all
  // the roster offers), but flagged for operators and re-runners.
  for (let i = 0; i < runs.length; i += 1) {
    const carrierCount = runs[i]!.carrierCount
    if (outcomes[i]!.verdict === 'SAME' && carrierCount !== undefined && carrierCount < 2) {
      warn(`${runs[i]!.peerId.slice(0, 10)}…: SAME verdict corroborated by a single carrier (weak stealth)`)
    }
  }

  for (const outcome of outcomes) {
    if (!batchRoot) break // nothing anchored — no attestation can reference a batch
    const code = verdictToCode(outcome.verdict)
    if (code === VERIFIER_VERDICT_UNKNOWN || !outcome.agentId) continue
    if (!outcome.fullyAuthenticated) {
      // Unauthenticated probes are seller non-cooperation, not model
      // evidence — do not attest a verdict that can't be backed by signed
      // responses.
      warn(`Skipping attestation for agent ${outcome.agentId}: missing verified ResponseAuth on probe traffic`)
      continue
    }
    // lastCreditedAt is the on-chain credited marker: comparing it around the
    // submission distinguishes CREDITED attestations from ones the contract
    // recorded but refused to credit (cooldown, per-epoch cap).
    let creditedBefore = 0
    let creditedBeforeKnown = true
    try {
      creditedBefore = await registryClient.lastCreditedAt(outcome.agentId, service)
    } catch {
      creditedBeforeKnown = false
    }
    try {
      const tx = await registryClient.submitAttestation(identity.wallet, {
        agentId: outcome.agentId,
        serviceHash: serviceHash(service),
        verdict: code,
        evidenceHash,
        probeCommitment,
        batchRoot,
        probeCount: probeSet.probes.length,
        cohortSize: cohort.length,
      })
      outcome.attested = true
      try {
        const creditedAfter = await registryClient.lastCreditedAt(outcome.agentId, service)
        outcome.credited = creditedBeforeKnown ? creditedAfter > creditedBefore : creditedAfter > 0
      } catch {
        // Read failure after a successful submission: assume credited — the
        // conservative direction for budget accounting (never over-spend).
        outcome.credited = true
      }
      log(`Attested agent ${outcome.agentId} ${service}: ${outcome.verdict}${outcome.credited ? '' : ' (uncredited)'} (tx ${tx.slice(0, 10)}…)`)
    } catch (err) {
      warn(`Attestation failed for agent ${outcome.agentId}: ${(err as Error).message}`)
    }
  }

  // Reveal LAST, and only after at least one attestation referenced the
  // commitment (the contract enforces the same order): the exact canonical
  // probe-set bytes go on-chain, where sha256(bytes) is checked against the
  // pre-audit commitment — an on-chain-verified opening anyone can replay.
  // The reveal is PERSISTED to the pending queue before it is attempted, so a
  // failed send — or a configured revealDelayMs holdback — is retried at the
  // next round boundary (and across restarts) instead of being forgotten.
  let revealTx: string | undefined
  if (batchRoot && outcomes.some((o) => o.attested)) {
    const revealDelayMs = Math.max(0, options.revealDelayMs ?? 0)
    // On-chain pack pointer: when a publish base URL is configured, post the
    // per-round pack URI in the reveal so a re-runner can fetch the pack from
    // chain data alone (no --pack flag). Empty string when unset.
    const base = options.publishBaseUrl?.replace(/\/+$/, '')
    const packUri = base ? `${base}/${probeCommitment}.json` : ''
    const pending: PendingReveal = {
      service,
      probeCommitment,
      probeSetJson: canonicalProbeSetJson(probeSet),
      packUri,
      dueAt: new Date(Date.now() + revealDelayMs).toISOString(),
      // Reference mode: this reveal publishes certified probes WITH their
      // expected answers — burn-and-refresh bookkeeping runs when it lands.
      ...(referenceMode && reference
        ? { burnReference: { referenceId: reference.referenceId, probeIds: probeSet.probes.map((p) => p.id) } }
        : {}),
    }
    try {
      await enqueuePendingReveal(options.revealQueueDir, pending)
      if (revealDelayMs > 0) {
        log(`Probe set reveal for ${probeCommitment.slice(0, 10)}… queued (due in ${revealDelayMs}ms)`)
      }
      // Drain immediately: with revealDelayMs=0 the reveal still goes out
      // in-round, right after the attestations; a delayed or failed reveal
      // stays queued for the next round's drain.
      revealTx = (await drainPendingReveals(identity, registryClient, options)).get(probeCommitment)
    } catch (err) {
      // Queue write failed (local disk): degrade to the old attempt-once
      // behavior for a due reveal instead of silently skipping it.
      warn(`pending-reveal enqueue failed for ${probeCommitment.slice(0, 10)}…: ${(err as Error).message}`)
      if (revealDelayMs === 0) {
        revealTx = await attemptReveal(identity, registryClient, pending, options)
      }
    }
  }

  return {
    service,
    probeCommitment,
    evidenceHash,
    packPath,
    cohortSize: cohort.length,
    outcomes,
    ...(batchRoot ? { batchRoot } : {}),
    ...(anchorTx ? { anchorTx } : {}),
    ...(revealTx ? { revealTx } : {}),
  }
}
