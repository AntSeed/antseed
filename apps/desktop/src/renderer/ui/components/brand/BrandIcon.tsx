import type { CSSProperties, JSX } from 'react';

/**
 * Vendor brand marks for the VPR Home screen (tool buttons + Popular list).
 *
 * These render inline as SVG so they inherit `currentColor` where monochrome
 * and pin brand hues where the mark is iconic.
 *
 * Resolution is by substring match against a profile `name`, a provider slug,
 * or a model label, so callers can pass whatever identifier they have on hand.
 */

export type BrandKey =
  | 'anthropic'
  | 'openai'
  | 'codex'
  | 'opencode'
  | 'pi'
  | 'crush'
  | 'goose'
  | 'zed'
  | 'deepseek'
  | 'qwen'
  | 'kimi'
  | 'glm'
  | 'gemini'
  | 'grok'
  | 'mistral'
  | 'minimax'
  | 'llama'
  | 'telegram'
  | 'generic';

type BrandGlyph = (props: { size: number }) => JSX.Element;

const ANTHROPIC_ORANGE = '#D97757';
const CRUSH_PINK = '#FF60B8';
const ZED_BLUE = '#084CCF';
const DEEPSEEK_BLUE = '#4D6BFE';
const GLM_BLUE = '#3859FF';
const GEMINI_BLUE = '#4285F4';
const MISTRAL_ORANGE = '#FA500F';
const META_BLUE = '#0668E1';
const TELEGRAM_BLUE = '#26A5E4';
const MINIMAX_ICON = 'data:image/png;base64,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';

const glyphs: Record<BrandKey, BrandGlyph> = {
  // Anthropic / Claude — radiating sunburst mark.
  anthropic: ({ size }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <g stroke={ANTHROPIC_ORANGE} strokeWidth={2} strokeLinecap="round">
        <path d="M12 3v18" />
        <path d="M3 12h18" />
        <path d="M5.6 5.6l12.8 12.8" />
        <path d="M18.4 5.6L5.6 18.4" />
      </g>
    </svg>
  ),
  // OpenAI / ChatGPT — interlocked knot approximated as a hexagonal rosette.
  openai: ({ size }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 3.2l6.9 4v9.6L12 20.8l-6.9-4V7.2L12 3.2z"
        stroke="currentColor"
        strokeWidth={1.7}
        strokeLinejoin="round"
      />
      <circle cx="12" cy="12" r="3.1" stroke="currentColor" strokeWidth={1.7} />
    </svg>
  ),
  // Codex — OpenAI's monochrome look: terminal window with a prompt.
  codex: ({ size }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="4.5" stroke="currentColor" strokeWidth={1.7} />
      <g stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
        <path d="M7.2 9.2l3.2 2.8-3.2 2.8" />
        <path d="M12.8 15.2h4" />
      </g>
    </svg>
  ),
  // Opencode — outlined nested square.
  opencode: ({ size }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3.5" y="3.5" width="17" height="17" rx="3.5" stroke="currentColor" strokeWidth={1.8} />
      <rect x="8.5" y="8.5" width="7" height="7" rx="1.5" fill="currentColor" />
    </svg>
  ),
  // pi — the tool's blocky geometric "P" monogram.
  pi: ({ size }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M6 4.5h10.5v10.5h-5.25V19.5H6V4.5zm3.5 3.5v3.5H13V8H9.5z"
        fill="currentColor"
        fillRule="evenodd"
      />
    </svg>
  ),
  // Crush (Charm) — glamour heart in charm pink.
  crush: ({ size }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 20.2S4 15.2 4 9.6C4 6.9 6 5 8.4 5c1.5 0 2.8.7 3.6 1.9C12.8 5.7 14.1 5 15.6 5 18 5 20 6.9 20 9.6c0 5.6-8 10.6-8 10.6z"
        fill={CRUSH_PINK}
      />
    </svg>
  ),
  // goose (Block) — walking goose silhouette.
  goose: ({ size }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M15.2 3.5c1.5 0 2.6 1.1 2.6 2.5 0 .4-.1.8-.3 1.2l2.5 1-2.3 1c-.1 2.6-1.2 4-2.7 5.2-1.1.9-1.8 1.6-2 2.9h3.3v2.2H6.2c-1.9 0-3.2-1.3-3.2-3 0-1.8 1.4-3 3.3-3h2.9c.9 0 1.6-.4 2.2-1 .9-.9 1.5-1.9 1.6-3.4-.9-.4-1.5-1.3-1.5-2.4 0-1.8 1.5-3.2 3.7-3.2z"
        fill="currentColor"
      />
    </svg>
  ),
  // Zed — brand-blue tile with the angular Z stroke.
  zed: ({ size }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="2.5" y="2.5" width="19" height="19" rx="5" fill={ZED_BLUE} />
      <path
        d="M7.5 7.5H16.5L7.5 16.5H16.5"
        stroke="#fff"
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ),
  // Deepseek — stylized whale.
  deepseek: ({ size }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M3 13.5c3.2 0 4.6-1.6 6.2-3.4 1.5-1.7 3-3.4 6.3-3.4 2 0 3.4.7 4.5 1.7-.6 2.1-1.7 3.3-3.2 4-1.9.9-3 .3-4.6 1.2C15.8 15 13.9 17.5 10 17.5c-4 0-7-2-7-4z"
        fill={DEEPSEEK_BLUE}
      />
      <circle cx="16.3" cy="9.4" r="0.9" fill="#fff" />
    </svg>
  ),
  // Qwen — geometric petal mark (used for the default free model).
  qwen: ({ size }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 2.5l3.4 6h-6.8L12 2.5zM4.2 8.2h6.8l-3.4 6-3.4-6zM13 8.2h6.8l-3.4 6-3.4-6zM8.6 15.5h6.8L12 21.5l-3.4-6z"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinejoin="round"
      />
    </svg>
  ),
  // Kimi / Moonshot — dark tile with the angular K mark.
  kimi: ({ size }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="2.5" y="2.5" width="19" height="19" rx="5.5" fill="#141416" />
      <rect x="2.5" y="2.5" width="19" height="19" rx="5.5" stroke="currentColor" strokeOpacity={0.25} strokeWidth={0.75} />
      <g stroke="#fff" strokeWidth={2.1} strokeLinecap="round" strokeLinejoin="round">
        <path d="M8.2 6.8v10.4" />
        <path d="M8.2 13.4l7-6.6" />
        <path d="M10.6 11.4l5 5.8" />
      </g>
    </svg>
  ),
  // GLM / Z.ai — blue tile with a Z stroke.
  glm: ({ size }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="2.5" y="2.5" width="19" height="19" rx="6" fill={GLM_BLUE} />
      <path
        d="M8.5 8.2h7l-7 7.6h7"
        stroke="#fff"
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ),
  // Gemini — four-point sparkle.
  gemini: ({ size }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 2.5c.6 5.3 4.2 8.9 9.5 9.5-5.3.6-8.9 4.2-9.5 9.5-.6-5.3-4.2-8.9-9.5-9.5 5.3-.6 8.9-4.2 9.5-9.5z"
        fill={GEMINI_BLUE}
      />
    </svg>
  ),
  // Grok / xAI — slanted cut mark.
  grok: ({ size }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <g stroke="currentColor" strokeWidth={2} strokeLinecap="round">
        <path d="M5 5l14 14" />
        <path d="M19 5l-5.6 5.6" />
      </g>
    </svg>
  ),
  // Mistral — chunky orange M.
  mistral: ({ size }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M4 19V5h3l5 6 5-6h3v14h-3v-8.6l-5 6-5-6V19H4z"
        fill={MISTRAL_ORANGE}
      />
    </svg>
  ),
  // MiniMax — exact favicon served by minimax.io.
  minimax: ({ size }) => (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <image width="32" height="32" href={MINIMAX_ICON} />
    </svg>
  ),
  // Llama / Meta — infinity loop.
  llama: ({ size }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M7 8.5c-4.5 0-4.5 7 0 7 4.5 0 5.5-7 10-7 4.5 0 4.5 7 0 7-4.5 0-5.5-7-10-7z"
        stroke={META_BLUE}
        strokeWidth={1.8}
      />
    </svg>
  ),
  // Telegram — brand-blue disc with the paper-plane knocked out.
  telegram: ({ size }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"
        fill={TELEGRAM_BLUE}
      />
    </svg>
  ),
  // Fallback — generic chip.
  generic: ({ size }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="4" y="4" width="16" height="16" rx="4" stroke="currentColor" strokeWidth={1.7} />
      <circle cx="12" cy="12" r="2.4" fill="currentColor" />
    </svg>
  ),
};

/* Model-family marks are matched BEFORE the generic provider/protocol marks:
   the haystack mixes provider slug and model label (e.g. "openai Kimi K3"
   for a Kimi model served over the OpenAI protocol), and the model family
   must win over the transport. */
const MATCHERS: Array<[BrandKey, RegExp]> = [
  // Pure model families first — these never appear as provider slugs.
  ['kimi', /(kimi|moonshot)/i],
  ['glm', /(glm|zhipu)/i],
  ['deepseek', /deep-?seek/i],
  ['qwen', /(qwen|tongyi)/i],
  ['gemini', /(gemini|gemma|google)/i],
  ['grok', /(grok|(^|[^a-z0-9])x-?ai([^a-z0-9]|$))/i],
  ['mistral', /(mistral|mixtral|magistral|devstral|codestral)/i],
  ['minimax', /mini[-\s]?max/i],
  ['llama', /llama/i],
  // Vendors that double as provider/protocol slugs.
  ['telegram', /telegram/i],
  ['anthropic', /(anthropic|claude)/i],
  ['codex', /codex/i],
  ['openai', /(openai|chatgpt|gpt|gpt-)/i],
  ['opencode', /(opencode|open-code)/i],
  ['crush', /crush/i],
  ['goose', /goose/i],
  // Standalone words only — these appear inside too many other identifiers.
  ['zed', /(^|[^a-z0-9])zed([^a-z0-9]|$)/i],
  ['pi', /(^|[^a-z0-9])pi([^a-z0-9]|$)/i],
];

export function resolveBrandKey(...candidates: Array<string | null | undefined>): BrandKey {
  const haystack = candidates.filter(Boolean).join(' ');
  if (!haystack) return 'generic';
  for (const [key, pattern] of MATCHERS) {
    if (pattern.test(haystack)) return key;
  }
  return 'generic';
}

export type BrandIconProps = {
  /** Any identifier — profile name, provider slug, or model label. */
  name?: string | null;
  /** Extra hints matched alongside `name` (e.g. provider + label). */
  hints?: Array<string | null | undefined>;
  /** Explicit brand key; skips resolution when provided. */
  brand?: BrandKey;
  size?: number;
  className?: string;
  style?: CSSProperties;
};

export function BrandIcon({ name, hints, brand, size = 20, className, style }: BrandIconProps): JSX.Element {
  const key = brand ?? resolveBrandKey(name, ...(hints ?? []));
  const Glyph = glyphs[key];
  return (
    <span className={className} style={{ display: 'inline-flex', ...style }} aria-hidden="true">
      <Glyph size={size} />
    </span>
  );
}
