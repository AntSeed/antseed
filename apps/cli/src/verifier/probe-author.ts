import type { KbfProbe } from '@antseed/fingerprints'
import { staticProbeSource, validateCandidateProbes } from '@antseed/fingerprints'
import { buildKbfReference, postChatCompletion } from './reference-builder.js'
import type { UpstreamApiConfig } from './reference-builder.js'

/**
 * LLM probe authoring (transparent audits).
 *
 * A static or procedural probe space ossifies once revealed: transparent audits reveal every
 * probe after its audit, so probes must be cheap to mint fresh. This module
 * asks the trusted upstream (the same OpenAI-compatible endpoint used for
 * reference enrollment) to AUTHOR ~2x candidate numeric-cloze probes, then
 * pushes them through the EXISTING certification machinery
 * (`buildKbfReference`: consistency across temperatures + independent
 * hold-out) so only probes the reference model answers stably survive.
 *
 * Nothing the authoring model emits is trusted: candidates are re-validated
 * field-by-field by `validateCandidateProbes` (@antseed/fingerprints), probe
 * ids are content-derived by the validator (never taken from the LLM), and
 * every certified `consensus` is the upstream reference model's own median —
 * not the authoring model's claim.
 */

export const LLM_AUTHORED_SOURCE_ID = 'llm-author/v1'

/** Candidates requested per needed probe (validation + certification attrition). */
const CANDIDATE_OVERSAMPLE = 2

/**
 * High-but-not-maximal temperature: diverse candidates without degrading JSON
 * shape adherence.
 */
const AUTHOR_TEMPERATURE = 0.9

/** Generous budget: ~120 tokens per candidate probe object. */
const AUTHOR_MAX_TOKENS_PER_CANDIDATE = 120

export interface AuthorProbesOptions {
  /** Network service the probes will audit (recorded, not sent upstream). */
  service: string
  /**
   * Upstream model that CERTIFIES candidates — the reference model for the
   * audited service (resolveUpstreamModel spelling).
   */
  model: string
  /**
   * Upstream model that AUTHORS candidates (`verifier.probeAuthorModel`).
   * Defaults to `model`.
   */
  authorModel?: string
  /** Certified probes to return. */
  count: number
  /** Probe ids already revealed against this service (rotation log). */
  exclude?: ReadonlySet<string>
  /** Consistency-filter passes forwarded to certification. */
  temperatures?: number[]
  selfTestTemperature?: number
  batchSize?: number
  /** Injectable for tests. Defaults to global fetch. */
  fetchFn?: typeof fetch
  log?: (message: string) => void
}

export interface AuthoredProbes {
  /** Exactly `count` certified probes, upstream-median consensus. */
  probes: KbfProbe[]
  /** Certification hold-out result over ALL stable candidates. */
  selfTest: { hamming: number; total: number; coverage: number; errorRate: number }
  /** Candidates rejected by shape/content validation. */
  rejectedCount: number
  /** Valid candidates dropped because their id was already used (rotation). */
  dedupedCount: number
}

/**
 * Authoring prompt: strict-JSON candidate request. The schema mirrors
 * `validateCandidateProbes` exactly; everything else in the reply is ignored
 * by the defensive array extraction below.
 */
export function buildAuthorPrompt(count: number): string {
  return [
    `Write exactly ${count} factual quiz questions with a single numeric answer each.`,
    '',
    'Requirements for every question:',
    '- The answer is one number that is stable over time (physics constants, historical dates, geography, anatomy, astronomy, chemistry, classical mathematics).',
    '- NEVER use time-varying facts: no populations, prices, market data, records, versions, or anything phrased with "current", "latest", "today", "as of", or "this year".',
    '- Phrase the question as a cloze statement whose blank is the marker ___ (three underscores), e.g. "The melting point of tungsten in degrees Celsius is ___.". Include the unit in the wording so the answer is a bare number.',
    '- The statement must be 20-500 characters long.',
    '',
    'Respond with ONLY a JSON array (no prose, no code fences). Each element must be an object with exactly these fields:',
    '{',
    '  "name": string,                  // short unique subject label, e.g. "tungsten-melting-point"',
    '  "domain": string,                // topical domain, e.g. "chemistry"',
    '  "template": string,              // the cloze statement containing ___',
    '  "consensus": number,             // the correct answer',
    '  "range": [number, number],       // plausibility bounds with lo < consensus < hi',
    '  "tolerance": { "mode": "absolute" | "relative", "value": number }  // acceptable answer slack; relative value <= 1',
    '}',
  ].join('\n')
}

/**
 * Defensively locate the JSON array in a completion. Models occasionally wrap
 * the payload in prose or code fences despite instructions; the raw text is
 * never trusted beyond "contains one JSON array".
 */
export function extractJsonArray(text: string): unknown {
  const attempts: string[] = [text.trim()]
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  if (fenced?.[1]) attempts.push(fenced[1].trim())
  const first = text.indexOf('[')
  const last = text.lastIndexOf(']')
  if (first !== -1 && last > first) attempts.push(text.slice(first, last + 1))
  for (const candidate of attempts) {
    try {
      const parsed: unknown = JSON.parse(candidate)
      if (Array.isArray(parsed)) return parsed
    } catch {
      // fall through to the next extraction strategy
    }
  }
  return null
}

async function requestCandidates(
  upstream: UpstreamApiConfig,
  model: string,
  candidateCount: number,
  fetchFn: typeof fetch,
): Promise<string> {
  const body = {
    model,
    messages: [{ role: 'user', content: buildAuthorPrompt(candidateCount) }],
    temperature: AUTHOR_TEMPERATURE,
    max_tokens: candidateCount * AUTHOR_MAX_TOKENS_PER_CANDIDATE,
  }
  return postChatCompletion(upstream, body, fetchFn, 'probe author upstream')
}

/**
 * Author + certify `count` fresh probes for one audit round:
 *
 * 1. Ask the authoring model for `2*count` strict-JSON candidates.
 * 2. Validate every candidate (shape, cloze marker, finite numbers, sane
 *    tolerance, banned volatile patterns) — `validateCandidateProbes`.
 * 3. Drop candidates whose content-derived id was already revealed against
 *    this service (rotation-log dedupe).
 * 4. Certify the survivors with the existing reference machinery: sample the
 *    reference model across temperatures, keep only stable probes (median
 *    becomes the certified consensus), score an independent hold-out pass.
 *
 * Throws when fewer than `count` probes survive — callers fall back to the
 * compositional source rather than auditing with a thin set.
 */
export async function authorProbes(
  upstream: UpstreamApiConfig,
  options: AuthorProbesOptions,
): Promise<AuthoredProbes> {
  const {
    service,
    model,
    authorModel = options.model,
    count,
    exclude,
    temperatures,
    selfTestTemperature,
    batchSize,
    fetchFn = fetch,
    log = () => {},
  } = options
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`authorProbes: count must be a positive integer, got ${count}`)
  }

  const candidateCount = count * CANDIDATE_OVERSAMPLE
  log(`Authoring ${candidateCount} candidate probes for ${service} via ${authorModel}`)
  const completion = await requestCandidates(upstream, authorModel, candidateCount, fetchFn)

  const raw = extractJsonArray(completion)
  if (raw === null) {
    throw new Error('authorProbes: completion contained no parseable JSON array')
  }
  const { probes: valid, rejected } = validateCandidateProbes(raw)
  if (rejected.length > 0) {
    log(`Rejected ${rejected.length} candidate(s): ${rejected.slice(0, 3).map((r) => r.reason).join('; ')}${rejected.length > 3 ? '; …' : ''}`)
  }

  // Rotation dedupe: ids are content-derived, so a re-authored duplicate of a
  // previously revealed probe is dropped no matter how it is re-worded — as
  // long as (domain, template) match. Fresh wordings pass, by design.
  const fresh = exclude && exclude.size > 0 ? valid.filter((p) => !exclude.has(p.id)) : valid
  const dedupedCount = valid.length - fresh.length
  if (dedupedCount > 0) log(`Dropped ${dedupedCount} already-used candidate(s) (rotation log)`)

  if (fresh.length < count) {
    throw new Error(
      `authorProbes: only ${fresh.length} valid fresh candidate(s) out of ${candidateCount} authored (< ${count} needed)`,
    )
  }

  // Certification via the EXISTING enrollment path: consistency filtering
  // across temperatures + hold-out self-error, against the reference model.
  const reference = await buildKbfReference(upstream, {
    model,
    service,
    probeSource: staticProbeSource(`${LLM_AUTHORED_SOURCE_ID}:candidates`, fresh),
    candidateCount: fresh.length,
    minProbes: count,
    ...(temperatures ? { temperatures } : {}),
    ...(selfTestTemperature !== undefined ? { selfTestTemperature } : {}),
    ...(batchSize !== undefined ? { batchSize } : {}),
    fetchFn,
    log,
  })

  const probes = reference.probes.slice(0, count)
  log(`Certified ${reference.probes.length}/${fresh.length} candidates; using ${probes.length}`)
  return {
    probes,
    selfTest: {
      hamming: reference.selfTest.hamming,
      total: reference.selfTest.total,
      coverage: reference.selfTest.coverage,
      errorRate: reference.selfTest.errorRate,
    },
    rejectedCount: rejected.length,
    dedupedCount,
  }
}
