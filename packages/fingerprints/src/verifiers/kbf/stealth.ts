/**
 * Stealth KBF request engine.
 *
 * The rigid `buildKbfChatRequestBody` builder produces a blatantly recognizable
 * probe ("TASK: ... Output ONLY in (N) <number> format"). A cheating seller can
 * classify that in one regex and route it to the real model (a defeat device —
 * spec 07 "Threat Model").
 *
 * This module instead emits requests that read like organic user chat: a normal
 * person asking a factual question, phrased naturally, with no numbering, no
 * "TASK/RULES" header, and no rigid output contract. A free-text extractor
 * (`extractAnswersFreeText`) then recovers the numeric answers from prose.
 *
 * Everything is fully deterministic from `probeSet.nonce` + probe ids via the
 * shared deterministic RNG (RFC 5869 HKDF-SHA256 seed derivation feeding a
 * NIST SP 800-90A HMAC_DRBG — see prng.ts), so a stored probe set reproduces
 * byte-identical requests for later evidence re-verification. No
 * `Math.random`, no `Date`.
 */

import type { KbfProbe, ProbeSet } from '../../types.js';
import { createRng, type DeterministicRng } from '../../prng.js';
import { renderKbfProbeLine, type KbfChatMessage } from './prompts.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type StealthChatMessage = KbfChatMessage;

export interface StealthRequestBody {
  model: string;
  messages: StealthChatMessage[];
  max_tokens?: number;
}

export interface StealthRequestPlan {
  /** Indices into probeSet.probes covered by this request, in question order. */
  probeIndices: number[];
  /** The probes at those indices, same order. */
  probes: KbfProbe[];
  /** OpenAI-compatible chat.completions request body. */
  body: StealthRequestBody;
}

export interface BuildStealthChatRequestsOptions {
  /** Max probes bundled into a single organic message. Default 3, min 1. */
  maxProbesPerRequest?: number;
}

const DEFAULT_MAX_PROBES_PER_REQUEST = 3;

/**
 * Partition ALL probes of a probe set into organic-looking chat requests.
 *
 * Request sizes (1..maxProbesPerRequest) and every stylistic choice (context
 * framing, phrasing variant, connectors, answer nudge, optional system message)
 * are drawn from a single seeded PRNG stream, so the output is a pure function
 * of the probe set. Every probe is covered exactly once, in set order.
 */
export function buildStealthChatRequests(
  model: string,
  probeSet: ProbeSet,
  options: BuildStealthChatRequestsOptions = {},
): StealthRequestPlan[] {
  const maxPerRequest = Math.max(1, Math.floor(options.maxProbesPerRequest ?? DEFAULT_MAX_PROBES_PER_REQUEST));

  const probes = probeSet.probes ?? [];
  // JSON-encoded so ids containing `,` / `|` can never collide with another
  // id list that joins to the same string.
  const seedString = JSON.stringify([probeSet.nonce, probes.map((p) => p.id)]);
  const rng = createRng(seedString, 'stealth');

  const plans: StealthRequestPlan[] = [];
  let cursor = 0;
  while (cursor < probes.length) {
    const remaining = probes.length - cursor;
    // Pseudo-random size in 1..min(maxPerRequest, remaining).
    const cap = Math.min(maxPerRequest, remaining);
    const size = 1 + rng.nextInt(cap);
    const probeIndices: number[] = [];
    const chunk: KbfProbe[] = [];
    // Never bundle two probes about the SAME entity (e.g. tungsten melting
    // point + tungsten boiling point) into one message: the response answers
    // both in one breath ("The melting point of tungsten is 3422°C, and its
    // boiling point is 5555°C.") and the shared entity anchor makes the
    // extractor grab the same number for both probes. A duplicate name ends
    // the chunk early and starts the next request instead.
    const namesInChunk = new Set<string>();
    for (let k = 0; k < size; k++) {
      const probe = probes[cursor + k]!;
      const nameKey = probe.name.toLowerCase();
      if (namesInChunk.has(nameKey)) break;
      namesInChunk.add(nameKey);
      probeIndices.push(cursor + k);
      chunk.push(probe);
    }
    cursor += chunk.length;

    const body = buildRequestBody(model, chunk, rng);
    plans.push({ probeIndices, probes: chunk, body });
  }

  return plans;
}

// ---------------------------------------------------------------------------
// Message construction
// ---------------------------------------------------------------------------

/**
 * Context framings — a person's reason for asking. `{q}` is where the
 * question(s) go. Tone, capitalization and punctuation vary so no single
 * lexical signature identifies the request as a probe.
 *
 * The second block are *task-shaped* framings: the fact is embedded in a piece
 * of real-looking work (a writeup, a spec sheet, a review) rather than a bare
 * trivia question. This widens the request silhouette so "route every short
 * factual question to the real model" is a leakier classifier for a cheating
 * seller. It raises the bar; it does not close it — genuine shape overlap with
 * the expensive traffic worth substituting (long coding/agentic requests) is
 * the job of the opt-in LLM generator and, ultimately, scoring organic traffic.
 */
const FRAMINGS: readonly string[] = [
  '{q}', // bare — no preamble at all
  'ok settling a bet with a friend — {q}',
  'prepping for pub quiz tonight, {q}',
  "helping my kid with homework and we're a bit stuck. {q}",
  'writing an article and want to get a detail right. {q}',
  "got a crossword clue i can't crack — {q}",
  'random thing i got curious about: {q}',
  'need this for a report at work. {q}',
  'Hi! Quick question if you have a sec. {q}',
  'trivia night is rough this week. {q}',
  'explaining this to a student later and want to double-check: {q}',
  'hey, {q}',
  'so, {q}',
  'quick fact check for a blog post — {q}',
  // Task-shaped framings.
  'working on a short writeup and need to nail one detail before I continue — {q}',
  'filling in a spec sheet for a project and one cell is blank: {q}',
  'sanity-checking a draft a colleague sent. one figure looks off — {q}',
  'putting together some notes and want to get this right: {q}',
  'building a small reference table and need one entry — {q}',
  "double-checking a fact for some docs i'm writing. {q}",
  'updating a cheat sheet and blanked on one thing: {q}',
];

/** Soft, natural answer nudges — appear in only ~half of requests. */
const NUDGES: readonly string[] = [
  'Short answers are fine.',
  'Just the numbers work.',
  'No need for detail, just the figures.',
  'A rough number is totally fine.',
  "Ballpark's ok.",
];

/** Conversational connectors joining questions in a multi-probe message. */
const CONNECTORS: readonly string[] = [
  '\nalso, ',
  '\nand one more — ',
  '\noh and ',
  '\n',
  ' also, ',
  '\nplus, ',
];

const GENERIC_SYSTEM_PROMPT = 'You are a helpful assistant.';

function buildRequestBody(model: string, probes: readonly KbfProbe[], rng: DeterministicRng): StealthRequestBody {
  // Render each probe as a natural question.
  const questions = probes.map((probe) => pickQuestion(probe, rng));

  // Join conversationally.
  let userContent = questions[0] ?? '';
  for (let i = 1; i < questions.length; i++) {
    const connector = pickFrom(CONNECTORS, rng);
    userContent += connector + questions[i];
  }

  // Wrap in a context framing.
  const framing = pickFrom(FRAMINGS, rng);
  userContent = framing.replace('{q}', userContent);

  // Soft answer nudge on ~half of requests.
  if (rng.nextFloat() < 0.5) {
    userContent += ` ${pickFrom(NUDGES, rng)}`;
  }

  // Most organic clients send no system message; a minority carry a generic one.
  const withSystem = rng.nextFloat() < 0.25;
  const messages: StealthChatMessage[] = withSystem
    ? [
        { role: 'system', content: GENERIC_SYSTEM_PROMPT },
        { role: 'user', content: userContent },
      ]
    : [{ role: 'user', content: userContent }];

  // `max_tokens` and `temperature` are intentionally omitted. Organic chat
  // clients usually leave both unset; pinning a fixed value (e.g. temperature 0
  // or a round max_tokens on every message) is itself a fingerprintable tell,
  // which is exactly what a stealth probe must avoid.
  return { model, messages };
}

function pickFrom<T>(arr: readonly T[], rng: DeterministicRng): T {
  return arr[rng.nextInt(arr.length)]!;
}

// ---------------------------------------------------------------------------
// Cloze → natural-question transformer
// ---------------------------------------------------------------------------

/** `The <property> of <name> is [approximately] ___<unit>.` */
const STRUCTURED_RE = /^The (.+?) of (.+?) is (?:approximately )?___(.*?)\.?\s*$/;
/** Any `<subject> is [approximately] ___<unit>.` cloze. */
const FALLBACK_RE = /^(.*?) is (?:approximately )?___(.*?)\.?\s*$/;

function lowerFirst(text: string): string {
  return text.length > 0 ? text[0]!.toLowerCase() + text.slice(1) : text;
}

/**
 * Turn a probe into a natural question, picking one of several phrasing
 * variants with the supplied RNG. Never emits `___`, numbering, or the raw
 * template. Deterministic given `rng`.
 */
function pickQuestion(probe: KbfProbe, rng: DeterministicRng): string {
  const rendered = renderKbfProbeLine(probe);

  const structured = STRUCTURED_RE.exec(rendered);
  if (structured) {
    const property = structured[1]!.trim();
    const name = structured[2]!.trim();
    const unit = (structured[3] ?? '').trim();
    const unitIn = unit ? ` in ${unit}` : '';
    const unitParen = unit ? ` (in ${unit})` : '';
    const variants = [
      `what's the ${property} of ${name}?${unitParen}`,
      `${name} — anyone know its ${property}${unitIn}?`,
      `i need the ${property} of ${name}${unitIn} for something i'm writing`,
      `do you happen to know the ${property} of ${name}${unitIn}?`,
      `the ${property} of ${name}${unitIn} — what is it?`,
    ];
    return pickFrom(variants, rng);
  }

  const fallback = FALLBACK_RE.exec(rendered);
  if (fallback) {
    const subject = fallback[1]!.trim();
    const unit = (fallback[2] ?? '').trim();
    const unitIn = unit ? ` in ${unit}` : '';
    const subjectLc = lowerFirst(subject);
    const variants = [
      `what is ${subjectLc}${unitIn}?`,
      `${subject}${unitIn} — what's the value?`,
      `i'm trying to remember ${subjectLc}${unitIn}, any idea?`,
      `remind me — ${subjectLc}${unitIn}?`,
    ];
    return pickFrom(variants, rng);
  }

  // Last-resort: strip the blank from the raw cloze and turn it into a question.
  // (No bank template reaches here, but keep the transform total and safe.)
  const stripped = rendered.replace(/___/g, 'what value').replace(/\.\s*$/, '');
  return `quick question — ${lowerFirst(stripped)}?`;
}

/**
 * Render a single probe as a natural question, deterministically seeded by
 * `seed` (default: the probe id). Exposed for reference / testing; the request
 * builder uses the internal PRNG-driven variant.
 */
export function renderStealthQuestion(probe: KbfProbe, seed: string = probe.id): string {
  return pickQuestion(probe, createRng(seed, 'stealth-question'));
}

// ---------------------------------------------------------------------------
// Free-text answer extraction
// ---------------------------------------------------------------------------

interface NumberCandidate {
  value: number;
  /** Character offset of the number token in the response. */
  index: number;
}

/**
 * Global numeric scanner: optional leading ~/≈, optional sign, digits with
 * optional thousands-commas, optional decimals (including the leading-decimal
 * `.5` form — matching only the `5` would silently change magnitude), optional
 * scientific exponent.
 */
const NUMBER_SCAN_RE = /[~≈]?\s*([-+]?(?:\d[\d,]*(?:\.\d+)?|\.\d+)(?:[eE][-+]?\d+)?)/g;

/** Words that mark a number as a precision qualifier, never an answer. */
const QUALIFIER_AFTER_RE = /^\s*(?:decimal|dp\b|sig\b|significant|places\b)/i;

function scanNumbers(text: string): NumberCandidate[] {
  const out: NumberCandidate[] = [];
  NUMBER_SCAN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = NUMBER_SCAN_RE.exec(text)) !== null) {
    const raw = match[1]!;
    const value = Number.parseFloat(raw.replace(/,/g, ''));
    if (!Number.isFinite(value)) continue;

    // Point index at the digit token, not any leading ~/≈ or whitespace.
    const digitOffset = match[0].length - raw.length;
    const start = match.index + digitOffset;
    const end = start + raw.length;

    // Reject numbers embedded inside a token rather than standing as an answer:
    //  - preceded by a letter or `^` ("K2", "10^34" exponent) — but a sign is ok;
    //  - followed by a letter or `^` ("2n", "10^34" mantissa);
    //  - part of a compound like "base-10" (a `-` glued to a preceding letter);
    //  - a leading-decimal fragment of a larger token ("1.2.3" → ".3");
    //  - a precision qualifier like "6 decimal places".
    const before = start > 0 ? text[start - 1]! : '';
    const after = end < text.length ? text[end]! : '';
    if (/[A-Za-z^]/.test(before)) continue;
    if (before === '-' && start >= 2 && /[A-Za-z]/.test(text[start - 2]!)) continue;
    if (raw.startsWith('.') && /\d/.test(before)) continue;
    if (/[A-Za-z^]/.test(after)) continue;
    if (QUALIFIER_AFTER_RE.test(text.slice(end))) continue;

    out.push({ value, index: start });
  }
  return out;
}

const KEYWORD_STOPWORDS = new Set([
  'the', 'of', 'is', 'a', 'an', 'at', 'to', 'in', 'per', 'and', 'by', 'its', 'for',
  'value', 'approximately', 'rounded', 'decimal', 'places', 'are', 'was', 'been',
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((tok) => {
      if (KEYWORD_STOPWORDS.has(tok)) return false;
      // Keep alphabetic words of length >= 2, and pure-digit tokens (the "3" in
      // "square root of 3" is the distinguisher between otherwise-identical
      // probes) so anchoring can localise to the right sentence.
      return tok.length >= 2 || /^\d+$/.test(tok);
    });
}

/**
 * Salient keyword tokens for a probe: the entity name plus the property/subject
 * words. Anchoring later picks the rarest of these, which is the most
 * discriminating (avoids latching onto a generic word like "sun" or "constant"
 * that also appears in a neighbouring probe's sentence).
 */
function keywordsFor(probe: KbfProbe): string[] {
  const rendered = renderKbfProbeLine(probe);
  const tokens = new Set(tokenize(probe.name));
  const structured = STRUCTURED_RE.exec(rendered);
  if (structured) {
    for (const tok of tokenize(structured[1]!)) tokens.add(tok);
    for (const tok of tokenize(structured[2]!)) tokens.add(tok);
  } else {
    const fallback = FALLBACK_RE.exec(rendered);
    if (fallback) {
      for (const tok of tokenize(fallback[1]!)) tokens.add(tok);
    }
  }
  // Verb stems for gerund property words: "melting point" answers often read
  // "tungsten MELTS at 3422°C" and "boiling point" as "it BOILS at 5555°C".
  // The base form (tokenOffsets already fuzzes a trailing 's') lets the anchor
  // land in the verb's sentence instead of only on the entity name.
  for (const tok of [...tokens]) {
    if (tok.endsWith('ing') && tok.length >= 6) {
      tokens.add(tok.slice(0, -3));
    }
  }
  return [...tokens];
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** All start offsets where `token` (fuzzy on a trailing plural 's') occurs. */
function tokenOffsets(token: string, haystackLower: string): number[] {
  const stem = token.endsWith('s') ? token.slice(0, -1) : token;
  const re = new RegExp(`\\b${escapeRegExp(stem)}s?\\b`, 'g');
  const offsets: number[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(haystackLower)) !== null) {
    offsets.push(match.index);
    if (match.index === re.lastIndex) re.lastIndex++; // guard zero-width
  }
  return offsets;
}

function inRange(value: number, probe: KbfProbe): boolean {
  const [lo, hi] = probe.range;
  return value >= lo && value <= hi;
}

/** Max char distance between an anchor keyword and its associated number. */
const ASSOCIATION_WINDOW = 140;

/**
 * Predicate cues, tiered by strength. A number right after a copula/equality
 * ("is 3880", "was 46", ": 687") is the answer slot itself; one after an
 * attaching preposition ("melting point of 3880", "melts at 3880") is
 * predicate-attached; anything else ("in 2020", a bare subject integer) is
 * incidental. Two tiers — rather than one predicate flag — let "…point of
 * 3880" beat "in 2020" while "…of 3 is 1.732051" still resolves to the
 * strongly-cued 1.732051, not the subject-embedded 3.
 */
const STRONG_CUE_RE =
  /(?:\bis|\bwas|\bare|\bwere|\bequals?|\babout|\bapprox(?:imately)?|\baround|\broughly|[:=≈~])\s*$/i;
const WEAK_CUE_RE = /(?:\bof|\bat|\bas)\s*$/i;

/** 0 strong cue, 1 weak cue, 2 no cue — lower ranks win in pickInSentence. */
function cueRank(text: string, index: number): number {
  const before = text.slice(Math.max(0, index - 18), index);
  if (STRONG_CUE_RE.test(before)) return 0;
  if (WEAK_CUE_RE.test(before)) return 1;
  return 2;
}

/**
 * Offsets of the RAREST-occurring keyword among `tokens`. The rarest token is
 * the most discriminating: it avoids anchoring on a generic word (e.g.
 * "constant") that also matches a neighbouring probe's sentence.
 */
function rarestAnchors(tokens: readonly string[], haystackLower: string): number[] {
  let bestCount = Infinity;
  let offsets: number[] = [];
  for (const token of tokens) {
    const found = tokenOffsets(token, haystackLower);
    if (found.length === 0) continue;
    if (found.length < bestCount) {
      bestCount = found.length;
      offsets = [...found];
    } else if (found.length === bestCount) {
      offsets.push(...found);
    }
  }
  return offsets;
}

/**
 * True if a sentence terminator (`.`/newline/`!`/`?`) separates two offsets.
 * A `.` flanked by digits is a decimal separator, not a boundary — "11.86
 * years is Jupiter's orbital period." is ONE sentence.
 */
function terminatorBetween(text: string, a: number, b: number): boolean {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  for (let i = lo; i < hi; i++) {
    const ch = text[i]!;
    if (ch === '\n' || ch === '!' || ch === '?') return true;
    if (ch === '.') {
      const prev = i > 0 ? text[i - 1]! : '';
      const next = i + 1 < text.length ? text[i + 1]! : '';
      if (/\d/.test(prev) && /\d/.test(next)) continue; // decimal point
      return true;
    }
  }
  return false;
}

/**
 * Numeric values that literally appear in the probe's rendered question text
 * (e.g. the 3 in "square root of 3"). A model restating the question makes
 * these look like cued answers ("For the square root OF 3 you get …"), so
 * they are strongly DEPRIORITIZED as candidates — used only when no other
 * in-range candidate qualifies, because a legitimate answer may coincide with
 * a number in the question (deprioritize, never exclude).
 */
function questionEchoValues(probe: KbfProbe): ReadonlySet<number> {
  return new Set(scanNumbers(renderKbfProbeLine(probe)).map((c) => c.value));
}

/**
 * Pick the answer from candidates that sit in the SAME sentence as an anchor.
 * Sorts by question-echo status first (a number copied from the question text
 * loses to any non-echo candidate — see questionEchoValues), then cue strength
 * (strong predicate cue, then weak, then none — see cueRank), nearest to the
 * anchor within a tier. So the predicate-attached "…melting point of 3880"
 * beats the incidental "in 2020" even when 2020 sits closer to the anchor,
 * and the true answer in "For the square root of 3 you get 1.732051" beats
 * the question-echoed 3 despite the 3's stronger cue. Returns null if no
 * in-range candidate shares a sentence with any anchor.
 */
function pickInSentence(
  text: string,
  candidates: readonly NumberCandidate[],
  anchors: readonly number[],
  probe: KbfProbe,
  echoValues: ReadonlySet<number>,
): number | null {
  let best: NumberCandidate | null = null;
  let bestKey = Infinity;
  // cueRank ∈ {0,1,2} and dist < text.length, so any non-echo candidate's key
  // (< 3·len) always beats any echo candidate's key (≥ 3·len).
  const echoTier = 3 * text.length;
  for (const cand of candidates) {
    if (!inRange(cand.value, probe)) continue;
    const rank = cueRank(text, cand.index);
    const echoPenalty = echoValues.has(cand.value) ? echoTier : 0;
    for (const anchor of anchors) {
      if (terminatorBetween(text, anchor, cand.index)) continue; // different sentence
      const dist = Math.abs(cand.index - anchor);
      const key = echoPenalty + rank * text.length + dist;
      if (key < bestKey) {
        bestKey = key;
        best = cand;
      }
    }
  }
  return best ? best.value : null;
}

/**
 * Extract each probe's numeric answer from free-form prose. The model may
 * answer in sentences, markdown lists, or bold, in any order.
 *
 * Strategy:
 *  1. Scan all numeric candidates (commas, decimals, scientific, ~/≈, signs).
 *  2. Anchor each probe by its keywords (entity name first, then property
 *     words; fuzzy on plurals) and take the nearest in-range candidate.
 *  3. If NO probe could be anchored (the model answered in question order
 *     without naming anything), fall back to positional alignment.
 *  4. `range` vetoes wildly out-of-range grabs; a probe with no confident
 *     candidate stays null — prefer null over a wrong number.
 *
 * Never throws.
 */
/**
 * Blank out markdown/numbered-list ordinals ("1. …", "2) …") so they cannot be
 * mistaken for answers by the positional fallback. Only a short line-leading
 * integer followed by `.`/`)` and further content on the same line qualifies —
 * a bare "3880." answer line is left alone. Replacement preserves offsets.
 */
function stripListNumbering(text: string): string {
  return text.replace(
    /^([ \t]*)(\d{1,3})([.)])([ \t]+\S)/gm,
    (_m, lead: string, ordinal: string, punct: string, rest: string) =>
      lead + ' '.repeat(ordinal.length + punct.length) + rest,
  );
}

export function extractAnswersFreeText(
  responseText: string,
  probes: readonly KbfProbe[],
): Array<number | null> {
  const answers: Array<number | null> = new Array(probes.length).fill(null);
  try {
    if (typeof responseText !== 'string' || probes.length === 0) {
      return answers;
    }
    // U+2212 (Unicode minus) is a plain minus; normalizing (same length, so
    // offsets are preserved) keeps "−430" from being read as +430.
    const text = responseText.replace(/−/g, '-');
    const candidates = scanNumbers(text);
    if (candidates.length === 0) {
      return answers;
    }
    // ASCII-only fold: full Unicode toLowerCase can change string LENGTH
    // (e.g. 'İ' → 'i̇'), which would misalign anchor offsets (found in
    // `lower`) against candidate/sentence offsets (found in `text`). Anchors
    // are lowercased ASCII keywords, so ASCII folding keeps offsets 1:1.
    const lower = text.replace(/[A-Z]/g, (c) => c.toLowerCase());

    let anyAnchored = false;
    for (let i = 0; i < probes.length; i++) {
      const probe = probes[i]!;
      const anchors = rarestAnchors(keywordsFor(probe), lower);
      if (anchors.length === 0) {
        continue; // unanchored — may be resolved by positional fallback
      }
      anyAnchored = true;
      const echoValues = questionEchoValues(probe);

      // First scope to the SENTENCE holding an anchor: the answer lives in the
      // same clause as its subject, so this walls off numbers bleeding in from
      // neighbouring sentences. Within the sentence, question-echoed numbers
      // lose to everything else, then cue strength decides (strong "is/:"-cued
      // beats weak "of/at"-cued beats uncued — so the subject integer in
      // "square root of 3" and the incidental year in "As measured in 2020"
      // both lose); nearest to the anchor breaks ties.
      const local = pickInSentence(text, candidates, anchors, probe, echoValues);
      if (local !== null) {
        answers[i] = local;
        continue;
      }

      // Fallback: the anchor's own sentence had no number (e.g. "…of tungsten?
      // That's 3422°C."). Take the nearest forward in-range candidate overall,
      // again deprioritizing question-echoed numbers to non-answer status.
      let best: NumberCandidate | null = null;
      let bestDist = Infinity;
      let bestEcho: NumberCandidate | null = null;
      let bestEchoDist = Infinity;
      for (const cand of candidates) {
        if (!inRange(cand.value, probe)) continue;
        const isEcho = echoValues.has(cand.value);
        for (const anchor of anchors) {
          const delta = cand.index - anchor;
          if (delta < 0 || delta > ASSOCIATION_WINDOW) continue;
          if (isEcho) {
            if (delta < bestEchoDist) {
              bestEchoDist = delta;
              bestEcho = cand;
            }
          } else if (delta < bestDist) {
            bestDist = delta;
            best = cand;
          }
        }
      }
      const chosen = best ?? bestEcho;
      if (chosen) {
        answers[i] = chosen.value;
      }
    }

    // Positional fallback: response answered in order without naming probes.
    // List ordinals are stripped first ("1. 3880" must yield 3880, not 1), and
    // the answers are taken from the contiguous candidate window with the most
    // in-range values, so preamble numerals ("here are 2 quick answers: …")
    // don't shift the alignment. Score ties break toward the LAST window:
    // answers follow preambles, so when a preamble numeral happens to be
    // in-range for a probe ("here are 2 quick answers: 46 and 3880" with a
    // [2, 500] range), the later window holds the real answer run.
    if (!anyAnchored) {
      const positional = scanNumbers(stripListNumbering(text));
      if (positional.length >= probes.length) {
        let bestStart = 0;
        let bestScore = -1;
        for (let start = 0; start + probes.length <= positional.length; start++) {
          let score = 0;
          for (let i = 0; i < probes.length; i++) {
            if (inRange(positional[start + i]!.value, probes[i]!)) score += 1;
          }
          if (score >= bestScore) {
            bestScore = score;
            bestStart = start;
          }
        }
        for (let i = 0; i < probes.length; i++) {
          const cand = positional[bestStart + i]!;
          answers[i] = inRange(cand.value, probes[i]!) ? cand.value : null;
        }
      }
    }
  } catch {
    // Extraction must never throw; return whatever was resolved so far.
  }
  return answers;
}
