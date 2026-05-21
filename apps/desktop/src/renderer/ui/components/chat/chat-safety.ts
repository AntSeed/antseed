export type SensitiveChatArtifact =
  | { type: 'url'; value: string; scheme: string; display: string }
  | { type: 'wallet-address'; value: string; chainHint: string };

export type ChatTextSegment =
  | { type: 'text'; text: string }
  | { type: 'artifact'; artifact: SensitiveChatArtifact };

type MatchCandidate = {
  start: number;
  end: number;
  artifact: SensitiveChatArtifact;
  priority: number;
};

const ZERO_WIDTH_CHARS = /[\u200B-\u200D\uFEFF]/g;
const URL_OR_PAYMENT_URI_PATTERN = /\b(?:(?:https?:\/\/|www\.)[^\s<>{}|\\^`"']+|(?:ethereum|bitcoin|solana|wc):[^\s<>{}|\\^`"']+)/giu;
const EVM_ADDRESS_PATTERN = /\b0x[a-fA-F0-9]{40}\b/g;
const BITCOIN_ADDRESS_PATTERN = /\b(?:bc1[ac-hj-np-z02-9]{25,87}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})\b/gi;
const COSMOS_ADDRESS_PATTERN = /\b[a-z]{2,16}1[0-9a-z]{38,58}\b/gi;
// Broad enough to catch common Solana/base58 addresses, but constrained to avoid
// ordinary prose: base58 only, 32-44 chars, and at least one digit plus both cases.
const SOLANA_ADDRESS_PATTERN = /\b(?=[1-9A-HJ-NP-Za-km-z]{32,44}\b)(?=[1-9A-HJ-NP-Za-km-z]*\d)(?=[1-9A-HJ-NP-Za-km-z]*[A-Z])(?=[1-9A-HJ-NP-Za-km-z]*[a-z])[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;

const TRAILING_URL_PUNCTUATION = /[),.;:!?]+$/;
const PAYMENT_INTENT_PATTERN = /\b(?:send|transfer|deposit|top\s*up|fund|funds|pay|payment|required|billing|balance|insufficient|add\s+credits?|add\s+funds?|connect\s+(?:your\s+)?wallet|approve\s+(?:the\s+)?(?:transaction|token|spend|allowance)|claim\s+(?:refund|airdrop|reward)|verify\s+(?:your\s+)?wallet|wallet\s+verification)\b/i;

function normalizeForDetection(text: string): string {
  return text
    .normalize('NFKC')
    .replace(ZERO_WIDTH_CHARS, '')
    .replace(/[._\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function trimUrlPunctuation(value: string): string {
  let next = value;
  while (TRAILING_URL_PUNCTUATION.test(next)) {
    const candidate = next.replace(TRAILING_URL_PUNCTUATION, '');
    if (candidate.length === next.length || candidate.length === 0) break;
    next = candidate;
  }
  return next;
}

function urlArtifact(rawValue: string): SensitiveChatArtifact | null {
  const trimmed = trimUrlPunctuation(rawValue.trim());
  if (!trimmed) return null;
  const withProtocol = trimmed.toLowerCase().startsWith('www.') ? `https://${trimmed}` : trimmed;

  try {
    const parsed = new URL(withProtocol);
    const scheme = parsed.protocol.replace(/:$/, '').toLowerCase();
    if (!scheme) return null;

    let display = scheme;
    if (scheme === 'http' || scheme === 'https') {
      display = parsed.hostname.replace(/^www\./i, '') || 'external link';
    } else if (scheme === 'mailto') {
      display = 'email link';
    } else if (scheme === 'wc') {
      display = 'WalletConnect link';
    } else if (scheme === 'ethereum' || scheme === 'bitcoin' || scheme === 'solana') {
      display = `${scheme} payment link`;
    }

    return { type: 'url', value: withProtocol, scheme, display };
  } catch {
    return null;
  }
}

function pushRegexMatches(
  candidates: MatchCandidate[],
  text: string,
  pattern: RegExp,
  chainHint: string,
  priority: number,
): void {
  pattern.lastIndex = 0;
  for (const match of text.matchAll(pattern)) {
    const value = match[0];
    if (!value || match.index === undefined) continue;
    candidates.push({
      start: match.index,
      end: match.index + value.length,
      artifact: { type: 'wallet-address', value, chainHint },
      priority,
    });
  }
}

function collectSensitiveArtifacts(text: string): MatchCandidate[] {
  const candidates: MatchCandidate[] = [];

  URL_OR_PAYMENT_URI_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(URL_OR_PAYMENT_URI_PATTERN)) {
    const raw = match[0];
    if (!raw || match.index === undefined) continue;
    const artifact = urlArtifact(raw);
    if (!artifact) continue;
    candidates.push({
      start: match.index,
      end: match.index + trimUrlPunctuation(raw).length,
      artifact,
      priority: 10,
    });
  }

  pushRegexMatches(candidates, text, EVM_ADDRESS_PATTERN, 'EVM', 5);
  pushRegexMatches(candidates, text, BITCOIN_ADDRESS_PATTERN, 'Bitcoin', 4);
  pushRegexMatches(candidates, text, COSMOS_ADDRESS_PATTERN, 'Cosmos', 3);
  pushRegexMatches(candidates, text, SOLANA_ADDRESS_PATTERN, 'wallet-like', 2);

  candidates.sort((a, b) => a.start - b.start || b.priority - a.priority || (b.end - b.start) - (a.end - a.start));

  const selected: MatchCandidate[] = [];
  let cursor = 0;
  for (const candidate of candidates) {
    if (candidate.start < cursor) continue;
    selected.push(candidate);
    cursor = candidate.end;
  }
  return selected;
}

export function segmentSensitiveChatText(text: string): ChatTextSegment[] {
  if (!text) return [{ type: 'text', text: '' }];
  const matches = collectSensitiveArtifacts(text);
  if (matches.length === 0) return [{ type: 'text', text }];

  const segments: ChatTextSegment[] = [];
  let cursor = 0;
  for (const match of matches) {
    if (match.start > cursor) {
      segments.push({ type: 'text', text: text.slice(cursor, match.start) });
    }
    segments.push({ type: 'artifact', artifact: match.artifact });
    cursor = match.end;
  }
  if (cursor < text.length) {
    segments.push({ type: 'text', text: text.slice(cursor) });
  }
  return segments;
}

export function findSensitiveChatArtifacts(text: string): SensitiveChatArtifact[] {
  return collectSensitiveArtifacts(text).map((match) => match.artifact);
}

export function hasSensitiveChatArtifact(text: string): boolean {
  return collectSensitiveArtifacts(text).length > 0;
}

export function isLikelyUnsafePaymentInstruction(text: string): boolean {
  if (!hasSensitiveChatArtifact(text)) return false;
  return PAYMENT_INTENT_PATTERN.test(normalizeForDetection(text));
}

export function formatArtifactLabel(artifact: SensitiveChatArtifact): string {
  if (artifact.type === 'wallet-address') {
    return `${artifact.chainHint} address hidden`;
  }
  if (artifact.scheme === 'wc') return 'WalletConnect link hidden';
  if (artifact.scheme === 'ethereum' || artifact.scheme === 'bitcoin' || artifact.scheme === 'solana') {
    return `${artifact.scheme} payment link hidden`;
  }
  return `External link: ${artifact.display}`;
}
