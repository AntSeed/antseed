import { useState, useMemo, useCallback } from 'react';
import type { ChatModelOptionEntry } from '../../../core/state';
import styles from './DiscoverWelcome.module.scss';

/* ── Tag colour map (from Figma design tokens) ──────────────────────── */

const TAG_STYLES: Record<string, { bg: string; border: string; color: string }> = {
  ANON:        { bg: 'rgba(0,0,0,0.06)',       border: 'rgba(0,0,0,0.18)',       color: '#4a4a48' },
  Free:        { bg: 'rgba(31,216,122,0.12)',   border: 'rgba(31,216,122,0.35)',  color: '#1fd87a' },
  Uncensored:  { bg: 'rgba(245,158,11,0.12)',   border: 'rgba(251,191,36,0.35)',  color: '#fbbf24' },
  Fast:        { bg: 'rgba(6,182,212,0.12)',    border: 'rgba(34,211,238,0.35)',  color: '#22d3ee' },
  Private:     { bg: 'rgba(139,92,246,0.12)',   border: 'rgba(139,92,246,0.35)',  color: '#8b5cf6' },
  Reasoning:   { bg: 'rgba(252,211,77,0.1)',    border: 'rgba(252,211,77,0.35)',  color: '#fcd34d' },
  Code:        { bg: 'rgba(59,130,246,0.12)',   border: 'rgba(59,130,246,0.35)',  color: '#3b82f6' },
  Vision:      { bg: 'rgba(236,72,153,0.1)',    border: 'rgba(236,72,153,0.35)',  color: '#f472b6' },
  Image:       { bg: 'rgba(236,72,153,0.1)',    border: 'rgba(236,72,153,0.35)',  color: '#f472b6' },
  Agent:       { bg: 'rgba(217,70,239,0.12)',   border: 'rgba(217,70,239,0.35)',  color: '#d946ef' },
  Research:    { bg: 'rgba(139,92,246,0.12)',   border: 'rgba(139,92,246,0.35)',  color: '#8b5cf6' },
  Writing:     { bg: 'rgba(251,146,60,0.12)',   border: 'rgba(251,146,60,0.35)', color: '#fb923c' },
  Legal:       { bg: 'rgba(252,211,77,0.1)',    border: 'rgba(252,211,77,0.35)',  color: '#fcd34d' },
  Math:        { bg: 'rgba(34,197,94,0.12)',    border: 'rgba(34,197,94,0.35)',   color: '#22c55e' },
  Agents:      { bg: 'rgba(217,70,239,0.12)',   border: 'rgba(217,70,239,0.35)',  color: '#d946ef' },
};

/* ── Filter categories ───────────────────────────────────────────────── */

const FILTERS = [
  'All', 'Code', 'Image', 'Reasoning', 'Uncensored',
  'Private', 'Fast', 'Free', 'Agents', 'Research', 'Writing', 'Legal', 'Math',
] as const;

/* ── Card data type ──────────────────────────────────────────────────── */

type CardItem = {
  name: string;
  value: string;
  provider: string;
  providerCount: number;
  tags: string[];
  gradient: string;
};

/* ── Model-name → visual gradient ────────────────────────────────────── */

const MODEL_GRADIENTS: Record<string, string> = {
  llama:     'linear-gradient(135deg, #0668E1, #0553B7)',  // Meta blue
  deepseek:  'linear-gradient(135deg, #536DFE, #304FFE)',  // DeepSeek indigo
  kimi:      'linear-gradient(135deg, #0D0D18, #252545)',  // Moonshot dark
  qwen:      'linear-gradient(135deg, #615CED, #4440C4)',  // Alibaba Cloud purple
  flux:      'linear-gradient(135deg, #1C1C1E, #3A3A3C)',  // Black Forest Labs dark
  mistral:   'linear-gradient(135deg, #FF7000, #E05800)',  // Mistral orange
  claude:    'linear-gradient(135deg, #DA6B47, #C45D3D)',  // Anthropic orange
  gpt:       'linear-gradient(135deg, #0FA37F, #0D8C6D)',  // OpenAI green
  openai:    'linear-gradient(135deg, #0FA37F, #0D8C6D)',  // OpenAI green
  gemini:    'linear-gradient(135deg, #4285F4, #1A73E8)',  // Google blue
  phi:       'linear-gradient(135deg, #0078D4, #005A9E)',  // Microsoft blue
  command:   'linear-gradient(135deg, #39594D, #2A4A3D)',  // Cohere teal
  glm:       'linear-gradient(135deg, #00B4D8, #0096C7)',  // Zhipu AI cyan
  minimax:   'linear-gradient(135deg, #E040FB, #AA00FF)',  // Minimax magenta
  yi:        'linear-gradient(135deg, #1A1A2E, #16213E)',  // 01.AI dark blue
  gemma:     'linear-gradient(135deg, #4285F4, #1A73E8)',  // Google blue
  community: 'linear-gradient(135deg, #1FD87A, #17C46E)',  // AntSeed green
};

const FALLBACK_GRADIENTS = [
  'linear-gradient(135deg, #0EA5E9, #0284C7)',  // sky blue
  'linear-gradient(135deg, #F97316, #EA580C)',  // orange
  'linear-gradient(135deg, #8B5CF6, #7C3AED)',  // violet
  'linear-gradient(135deg, #10B981, #059669)',  // emerald
  'linear-gradient(135deg, #EC4899, #DB2777)',  // pink
  'linear-gradient(135deg, #EAB308, #CA8A04)',  // yellow
  'linear-gradient(135deg, #06B6D4, #0891B2)',  // cyan
  'linear-gradient(135deg, #EF4444, #DC2626)',  // red
  'linear-gradient(135deg, #6366F1, #4F46E5)',  // indigo
  'linear-gradient(135deg, #84CC16, #65A30D)',  // lime
];

function simpleHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

function getGradient(modelId: string): string {
  const lower = modelId.toLowerCase();
  for (const [key, gradient] of Object.entries(MODEL_GRADIENTS)) {
    if (lower.includes(key)) return gradient;
  }
  return FALLBACK_GRADIENTS[simpleHash(lower) % FALLBACK_GRADIENTS.length];
}

/* ── Infer tags from model name / protocol ───────────────────────────── */

function inferTags(modelId: string, protocol: string): string[] {
  const tags: string[] = ['ANON'];
  const lower = modelId.toLowerCase();

  if (lower.includes('code') || lower.includes('claude') || lower.includes('codex') || lower.includes('codebot') || lower.includes('starcoder'))
    tags.push('Code');
  if (lower.includes('uncensored') || lower.includes('dolphin'))
    tags.push('Uncensored');
  if (lower.includes('reason') || lower.includes('deepseek') || lower.includes('think'))
    tags.push('Reasoning');
  if (lower.includes('flux') || lower.includes('sdxl') || lower.includes('dall'))
    tags.push('Image');
  if (lower.includes('fast') || lower.includes('flash') || lower.includes('mini') || lower.includes('haiku'))
    tags.push('Fast');
  if (protocol === 'free' || lower.includes('free'))
    tags.push('Free');

  return tags;
}

/* ── Build cards from network model options ──────────────────────────── */

function buildCards(options: ChatModelOptionEntry[]): CardItem[] {
  return options.map((opt) => ({
    name: opt.label || opt.id,
    value: opt.value,
    provider: opt.provider,
    providerCount: opt.count,
    tags: inferTags(opt.id, opt.protocol),
    gradient: getGradient(opt.id),
  }));
}

/* ── Showcase fallback (when no network data yet) ────────────────────── */

const SHOWCASE_CARDS: CardItem[] = [
  {
    name: 'Community Peers', value: 'community', provider: 'community', providerCount: 0,
    tags: ['ANON', 'Free'],
    gradient: 'linear-gradient(135deg, rgba(51,236,142,0.15), rgba(31,216,122,0.25))',
  },
  {
    name: 'llama-4-scout', value: '', provider: '', providerCount: 5,
    tags: ['ANON', 'Uncensored', 'Fast'],
    gradient: 'linear-gradient(135deg, #0668E1, #0553B7)',
  },
  {
    name: 'deepseek-v3.2', value: '', provider: '', providerCount: 3,
    tags: ['ANON', 'Private', 'Reasoning'],
    gradient: 'linear-gradient(135deg, #4D6EFC, #2F4FCC)',
  },
  {
    name: 'kimi-k2.5', value: '', provider: '', providerCount: 2,
    tags: ['ANON', 'Code', 'Reasoning'],
    gradient: 'linear-gradient(135deg, #0D0D18, #252545)',
  },
  {
    name: 'qwen3-235b', value: '', provider: '', providerCount: 4,
    tags: ['ANON', 'Uncensored', 'Private'],
    gradient: 'linear-gradient(135deg, #06b6d4, #0891b2)',
  },
  {
    name: 'flux-1.1-pro', value: '', provider: '', providerCount: 2,
    tags: ['ANON', 'Image', 'Uncensored'],
    gradient: 'linear-gradient(135deg, #1c1c1e, #3a3a3c)',
  },
  {
    name: 'mistral-large-3', value: '', provider: '', providerCount: 3,
    tags: ['ANON', 'Fast', 'Code'],
    gradient: 'linear-gradient(135deg, #ff7000, #e05800)',
  },
];

/* ── Helpers ──────────────────────────────────────────────────────────── */

function Tag({ label }: { label: string }) {
  const s = TAG_STYLES[label] ?? TAG_STYLES.Text!;
  return (
    <span
      className={styles.tag}
      style={{ background: s.bg, borderColor: s.border, color: s.color }}
    >
      {label}
    </span>
  );
}

function CardIcon({ item }: { item: CardItem }) {
  const letter = item.name.charAt(0).toUpperCase();

  return (
    <div
      className={styles.cardIcon}
      style={{ background: item.gradient, borderRadius: 8 }}
    >
      <span className={styles.cardInitials}>{letter}</span>
    </div>
  );
}

/* ── Filter matching ─────────────────────────────────────────────────── */

const FILTER_TAG_MAP: Record<string, string[]> = {
  Code:        ['Code'],
  Image:       ['Vision', 'Image'],
  Reasoning:   ['Reasoning'],
  Uncensored:  ['Uncensored'],
  Private:     ['Private'],
  Fast:        ['Fast'],
  Free:        ['Free'],
  Agents:      ['Agent'],
  Research:    ['Research'],
  Writing:     ['Writing'],
  Legal:       ['Legal'],
  Math:        ['Math'],
};

function matchesFilter(item: CardItem, filter: string): boolean {
  if (filter === 'All') return true;
  const matchTags = FILTER_TAG_MAP[filter];
  if (!matchTags) return false;
  return item.tags.some((t) => matchTags.includes(t));
}

/* ── Main component ──────────────────────────────────────────────────── */

type DiscoverWelcomeProps = {
  modelOptions: ChatModelOptionEntry[];
  onStartChatting: (modelValue: string) => void;
};

export function DiscoverWelcome({ modelOptions, onStartChatting }: DiscoverWelcomeProps) {
  const [activeFilter, setActiveFilter] = useState('All');

  const hasNetworkData = modelOptions.length > 0;
  const cards = useMemo(
    () => (hasNetworkData ? buildCards(modelOptions) : SHOWCASE_CARDS),
    [hasNetworkData, modelOptions],
  );

  const filtered = useMemo(
    () => cards.filter((c) => matchesFilter(c, activeFilter)),
    [cards, activeFilter],
  );

  const handleClick = useCallback(
    (value: string) => {
      if (value) onStartChatting(value);
    },
    [onStartChatting],
  );

  return (
    <div className={styles.discover}>
      {/* Header */}
      <div className={styles.header}>
        <h1 className={styles.heading}>
          What do you need <span className={styles.headingAccent}>AI</span> for?
        </h1>
        <p className={styles.subtitle}>
          Pick a model or agent to start. Filter by what you need.
          Everything is anonymous — no account required.
        </p>
      </div>

      {/* Filter pills */}
      <div className={styles.filters}>
        {FILTERS.map((f) => (
          <button
            key={f}
            className={`${styles.filterPill}${activeFilter === f ? ` ${styles.filterActive}` : ''}`}
            onClick={() => setActiveFilter(f)}
          >
            {f}
          </button>
        ))}
      </div>

      {/* Scrollable cards area */}
      <div className={styles.cardsScroll}>
        <div className={styles.cardsInner}>
          {!hasNetworkData && (
            <div className={styles.loadingHint}>
              Connecting to network... showing preview.
            </div>
          )}

          {filtered.length > 0 ? (
            <>
              <div className={styles.sectionLabel}>
                {hasNetworkData ? 'Available Models' : 'Models'}
              </div>
              <div className={styles.cardGrid}>
                {filtered.map((item) => (
                  <Card
                    key={item.value || item.name}
                    item={item}
                    hasNetworkData={hasNetworkData}
                    onClick={handleClick}
                  />
                ))}
              </div>
            </>
          ) : (
            <div className={styles.emptyFilter}>No models match this filter.</div>
          )}
        </div>

        {/* Footer */}
        <div className={styles.footer}>
          No account · No data stored · Peer-to-peer · antseed.com
        </div>
      </div>
    </div>
  );
}

/* ── Card ─────────────────────────────────────────────────────────────── */

function Card({
  item,
  hasNetworkData,
  onClick,
}: {
  item: CardItem;
  hasNetworkData: boolean;
  onClick: (v: string) => void;
}) {
  const providerLabel =
    item.providerCount === 1
      ? '1 provider'
      : item.providerCount > 1
        ? `${item.providerCount} providers`
        : '';

  const clickable = !!item.value;

  return (
    <div
      className={`${styles.card}${!hasNetworkData ? ` ${styles.cardPreview}` : ''}${clickable ? ` ${styles.cardClickable}` : ''}`}
      onClick={clickable ? () => onClick(item.value) : undefined}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onKeyDown={clickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(item.value); } } : undefined}
    >
      {/* Top row: icon + name */}
      <div className={styles.cardTop}>
        <CardIcon item={item} />
        <div className={styles.cardMeta}>
          <div className={styles.cardName}>{item.name}</div>
          {providerLabel && <div className={styles.cardPrice}>{providerLabel}</div>}
        </div>
      </div>

      {/* Tags */}
      <div className={styles.cardTags}>
        {item.tags.map((t) => (
          <Tag key={t} label={t} />
        ))}
      </div>

      {/* Bottom: CTA */}
      <div className={styles.cardBottom}>
        {clickable ? (
          <span className={styles.cardCta}>
            Start chatting <span className={styles.cardCtaArrow}>→</span>
          </span>
        ) : (
          <span className={styles.cardCtaDisabled}>Coming soon</span>
        )}
      </div>
    </div>
  );
}
