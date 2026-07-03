import type { CSSProperties, JSX } from 'react';

/**
 * Vendor brand marks for the VPR Home screen (tool buttons + Popular list).
 *
 * These are hand-authored, recognizable-but-generic geometric marks — not the
 * vendors' exact trademarked logos. They render inline as SVG so they inherit
 * `currentColor` where monochrome and pin brand hues where the mark is iconic.
 *
 * Resolution is by substring match against a profile `name`, a provider slug,
 * or a model label, so callers can pass whatever identifier they have on hand.
 */

export type BrandKey =
  | 'anthropic'
  | 'openai'
  | 'codex'
  | 'opencode'
  | 'deepseek'
  | 'qwen'
  | 'generic';

type BrandGlyph = (props: { size: number }) => JSX.Element;

const ANTHROPIC_ORANGE = '#D97757';
const CODEX_BLUE = '#4d6bfe';
const DEEPSEEK_BLUE = '#4D6BFE';

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
  // Codex — rounded blue tile with a code caret.
  codex: ({ size }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="2.5" y="2.5" width="19" height="19" rx="6" fill={CODEX_BLUE} />
      <path
        d="M10 8.5L6.5 12L10 15.5M14 8.5L17.5 12L14 15.5"
        stroke="#fff"
        strokeWidth={1.7}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ),
  // Opencode — outlined nested square.
  opencode: ({ size }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3.5" y="3.5" width="17" height="17" rx="3.5" stroke="currentColor" strokeWidth={1.8} />
      <rect x="8.5" y="8.5" width="7" height="7" rx="1.5" fill="currentColor" />
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
  // Fallback — generic chip.
  generic: ({ size }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="4" y="4" width="16" height="16" rx="4" stroke="currentColor" strokeWidth={1.7} />
      <circle cx="12" cy="12" r="2.4" fill="currentColor" />
    </svg>
  ),
};

const MATCHERS: Array<[BrandKey, RegExp]> = [
  ['anthropic', /(anthropic|claude)/i],
  ['codex', /codex/i],
  ['openai', /(openai|chatgpt|gpt|gpt-)/i],
  ['opencode', /(opencode|open-code)/i],
  ['deepseek', /deep-?seek/i],
  ['qwen', /(qwen|tongyi)/i],
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
