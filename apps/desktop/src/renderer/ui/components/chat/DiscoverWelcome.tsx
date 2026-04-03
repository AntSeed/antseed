import { useState, useMemo, useCallback, useRef } from 'react';
import Skeleton from 'react-loading-skeleton';
import 'react-loading-skeleton/dist/skeleton.css';
import type { ChatServiceOptionEntry } from '../../../core/state';
import { useUiSnapshot } from '../../hooks/useUiSnapshot';
import { useActions } from '../../hooks/useActions';
import styles from './DiscoverWelcome.module.scss';

/* ── Filter categories ───────────────────────────────────────────────── */

const FILTERS = [
  'All', 'Text', 'Code', 'Image', 'Reasoning', 'Uncensored',
  'Private', 'Fast', 'Free', 'Agents', 'Research', 'Writing', 'Legal', 'Math',
] as const;

/* ── Card data type ──────────────────────────────────────────────────── */

type CardItem = {
  name: string;
  peerLabel: string;
  value: string;
  provider: string;
  providerCount: number;
  tags: string[];
  gradient: string;
  description: string;
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
};

/* ── Service-name → visual gradient (for provider avatars) ─────────── */

const SERVICE_GRADIENTS: Record<string, string> = {
  llama:     'linear-gradient(180deg, #0668E1, #0553B7)',
  deepseek:  'linear-gradient(180deg, #536DFE, #304FFE)',
  kimi:      'linear-gradient(180deg, #0D0D18, #252545)',
  qwen:      'linear-gradient(180deg, #615CED, #4440C4)',
  flux:      'linear-gradient(180deg, #1C1C1E, #3A3A3C)',
  mistral:   'linear-gradient(180deg, #FF7000, #E05800)',
  claude:    'linear-gradient(180deg, #DA6B47, #C45D3D)',
  gpt:       'linear-gradient(180deg, #0FA37F, #0D8C6D)',
  openai:    'linear-gradient(180deg, #0FA37F, #0D8C6D)',
  gemini:    'linear-gradient(180deg, #4285F4, #1A73E8)',
  phi:       'linear-gradient(180deg, #0078D4, #005A9E)',
  command:   'linear-gradient(180deg, #39594D, #2A4A3D)',
  glm:       'linear-gradient(180deg, #00B4D8, #0096C7)',
  minimax:   'linear-gradient(180deg, #E040FB, #AA00FF)',
  yi:        'linear-gradient(180deg, #1A1A2E, #16213E)',
  gemma:     'linear-gradient(180deg, #4285F4, #1A73E8)',
  community: 'linear-gradient(180deg, #1FD87A, #17C46E)',
};

const FALLBACK_GRADIENTS = [
  'linear-gradient(180deg, #ffa66c, #ff7b15)',
  'linear-gradient(180deg, #5ca9e0, #178dd6)',
  'linear-gradient(180deg, #4ece64, #00be2c)',
  'linear-gradient(180deg, #6fc5ff, #38b2ff)',
  'linear-gradient(180deg, #f27796, #ec4b74)',
  'linear-gradient(180deg, #8B5CF6, #7C3AED)',
  'linear-gradient(180deg, #06B6D4, #0891B2)',
  'linear-gradient(180deg, #EF4444, #DC2626)',
  'linear-gradient(180deg, #EAB308, #CA8A04)',
  'linear-gradient(180deg, #84CC16, #65A30D)',
];

function simpleHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

function getGradient(name: string): string {
  const lower = name.toLowerCase();
  for (const [key, gradient] of Object.entries(SERVICE_GRADIENTS)) {
    if (lower.includes(key)) return gradient;
  }
  return FALLBACK_GRADIENTS[simpleHash(lower) % FALLBACK_GRADIENTS.length];
}

/* ── Infer tags from service name / categories ───────────────────────── */

function inferTags(serviceId: string, categories: string[]): string[] {
  if (categories.length > 0) return categories.slice(0, 3);

  const tags: string[] = [];
  const lower = serviceId.toLowerCase();

  if (lower.includes('code') || lower.includes('claude') || lower.includes('codex') || lower.includes('starcoder'))
    tags.push('Code');
  if (lower.includes('uncensored') || lower.includes('dolphin'))
    tags.push('Uncensored');
  if (lower.includes('reason') || lower.includes('deepseek') || lower.includes('think'))
    tags.push('Reasoning');
  if (lower.includes('flux') || lower.includes('sdxl') || lower.includes('dall'))
    tags.push('Image');
  if (lower.includes('fast') || lower.includes('flash') || lower.includes('mini') || lower.includes('haiku'))
    tags.push('Fast');
  if (lower.includes('text') || lower.includes('chat') || lower.includes('llama') || lower.includes('mistral'))
    tags.push('Text');
  if (lower.includes('free'))
    tags.push('Free');
  if (lower.includes('write') || lower.includes('content'))
    tags.push('Writing');
  if (lower.includes('legal'))
    tags.push('Legal');
  if (lower.includes('math'))
    tags.push('Math');
  if (lower.includes('agent'))
    tags.push('Agents');
  if (lower.includes('research'))
    tags.push('Research');
  if (lower.includes('private') || lower.includes('tee'))
    tags.push('Private');

  return tags.length > 0 ? tags.slice(0, 3) : ['Text'];
}

/* ── Generate description from service name ──────────────────────────── */

function generateDescription(serviceId: string, categories: string[], provider: string): string {
  const lower = serviceId.toLowerCase();
  const prov = provider || 'a network peer';

  if (lower.includes('claude')) return `Access to Anthropic's Claude model. Powered by ${prov}.`;
  if (lower.includes('gpt') || lower.includes('openai')) return `OpenAI model access through ${prov}.`;
  if (lower.includes('llama')) return `Meta's Llama open-weight model. Hosted by ${prov}.`;
  if (lower.includes('deepseek')) return `DeepSeek reasoning model. Served by ${prov}.`;
  if (lower.includes('mistral')) return `Mistral's flagship model. Strong multilingual and instruction following.`;
  if (lower.includes('kimi')) return `Moonshot's Kimi reasoning model. High-performance math and code.`;
  if (lower.includes('qwen')) return `Alibaba's Qwen model series. Multilingual and versatile.`;
  if (lower.includes('gemini') || lower.includes('gemma')) return `Google's model. Powered by ${prov}.`;
  if (lower.includes('flux') || lower.includes('sdxl')) return `Image generation model. Served by ${prov}.`;
  if (categories.length > 0) return `${categories.join(' & ')} service powered by ${prov}.`;
  return `AI service powered by ${prov}.`;
}

/* ── Build cards from network service options ──────────────────────────── */

function buildCards(options: ChatServiceOptionEntry[]): CardItem[] {
  return options.map((opt) => ({
    name: opt.label || opt.id,
    peerLabel: opt.peerLabel || '',
    value: opt.value,
    provider: opt.provider,
    providerCount: opt.count,
    tags: inferTags(opt.id, opt.categories),
    gradient: getGradient(opt.peerLabel || opt.provider || opt.id),
    description: opt.description || generateDescription(opt.id, opt.categories, opt.peerLabel || opt.provider),
    inputUsdPerMillion: opt.inputUsdPerMillion,
    outputUsdPerMillion: opt.outputUsdPerMillion,
  }));
}

/* ── Filter matching ─────────────────────────────────────────────────── */

const FILTER_TAG_MAP: Record<string, string[]> = {
  Text:        ['Text'],
  Code:        ['Code', 'Coding'],
  Image:       ['Vision', 'Image'],
  Reasoning:   ['Reasoning'],
  Uncensored:  ['Uncensored'],
  Private:     ['Private', 'Privacy'],
  Fast:        ['Fast'],
  Free:        ['Free'],
  Agents:      ['Agent', 'Agents'],
  Research:    ['Research'],
  Writing:     ['Writing'],
  Legal:       ['Legal'],
  Math:        ['Math'],
};

function matchesFilter(item: CardItem, filter: string): boolean {
  if (filter === 'All') return true;
  const matchTags = FILTER_TAG_MAP[filter];
  if (!matchTags) return false;
  return item.tags.some((t) => matchTags.some((m) => t.toLowerCase().includes(m.toLowerCase())));
}

/* ── Format pricing ──────────────────────────────────────────────────── */

function formatPrice(usdPerMillion: number): string {
  if (usdPerMillion <= 0) return 'Free';
  if (usdPerMillion < 0.01) return `$${usdPerMillion.toFixed(3)}/M`;
  return `$${usdPerMillion.toFixed(2)}/M`;
}

/* ── Skeleton card ───────────────────────────────────────────────────── */

const skeletonBaseColor = 'rgba(0,0,0,0.04)';
const skeletonHighlightColor = 'rgba(0,0,0,0.07)';

function SkeletonCard() {
  return (
    <div className={styles.card}>
      <div className={styles.cardBody}>
        <div className={styles.cardTags}>
          <Skeleton width={52} height={18} borderRadius={24} baseColor={skeletonBaseColor} highlightColor={skeletonHighlightColor} />
          <Skeleton width={42} height={18} borderRadius={24} baseColor={skeletonBaseColor} highlightColor={skeletonHighlightColor} />
        </div>
        <Skeleton width="65%" height={16} baseColor={skeletonBaseColor} highlightColor={skeletonHighlightColor} />
        <Skeleton width="90%" height={12} baseColor={skeletonBaseColor} highlightColor={skeletonHighlightColor} />
        <Skeleton width="55%" height={12} baseColor={skeletonBaseColor} highlightColor={skeletonHighlightColor} />
      </div>
      <div className={styles.cardFooter}>
        <Skeleton width={90} height={12} baseColor={skeletonBaseColor} highlightColor={skeletonHighlightColor} />
      </div>
    </div>
  );
}

/* ── Provider avatar ─────────────────────────────────────────────────── */

function ProviderAvatar({ name, gradient }: { name: string; gradient: string }) {
  const letter = (name || '?').charAt(0).toUpperCase();
  return (
    <span className={styles.providerAvatar} style={{ background: gradient }}>
      {letter}
    </span>
  );
}

/* ── Main component ──────────────────────────────────────────────────── */

type DiscoverWelcomeProps = {
  serviceOptions: ChatServiceOptionEntry[];
  onStartChatting: (serviceValue: string) => void;
};

export function DiscoverWelcome({ serviceOptions, onStartChatting }: DiscoverWelcomeProps) {
  const [activeFilter, setActiveFilter] = useState('All');
  const { creditsAvailableUsdc } = useUiSnapshot();
  const actions = useActions();
  const hasCredits = parseFloat(creditsAvailableUsdc) > 0;
  const filtersRef = useRef<HTMLDivElement>(null);

  const hasNetworkData = serviceOptions.length > 0;
  const cards = useMemo(
    () => (hasNetworkData ? buildCards(serviceOptions) : []),
    [hasNetworkData, serviceOptions],
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

  const scrollFilters = useCallback((dir: 'left' | 'right') => {
    const el = filtersRef.current;
    if (!el) return;
    el.scrollBy({ left: dir === 'right' ? 120 : -120, behavior: 'smooth' });
  }, []);

  return (
    <div className={styles.discover}>
      {/* Scrollable content area */}
      <div className={styles.cardsScroll}>
        <div className={styles.cardsInner}>

          {/* Hero */}
          <div className={styles.header}>
            <h1 className={styles.heading}>
              What do you need <span className={styles.headingAccent}>AI</span> for?
            </h1>
            <p className={styles.subtitle}>
              Pick a service to start chatting. Filter by what you need.
              Everything is anonymous — no account required.
            </p>
          </div>

          {/* Filter pills */}
          <div className={styles.filtersWrap}>
            <div className={styles.filters} ref={filtersRef}>
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
            <div className={styles.filtersFade}>
              <button
                className={styles.filtersArrow}
                onClick={() => scrollFilters('right')}
                aria-label="Scroll filters"
              >
                ›
              </button>
            </div>
          </div>

          {/* Cards */}
          {!hasNetworkData ? (
            <>
              <div className={styles.loadingHint}>
                Connecting to network...
              </div>
              <div className={styles.cardGrid}>
                {Array.from({ length: 9 }, (_, i) => (
                  <SkeletonCard key={i} />
                ))}
              </div>
            </>
          ) : filtered.length > 0 ? (
            <div className={styles.cardGrid}>
              {filtered.map((item) => (
                <Card
                  key={item.value || item.name}
                  item={item}
                  onClick={handleClick}
                />
              ))}
            </div>
          ) : (
            <div className={styles.emptyFilter}>No services match this filter.</div>
          )}

        </div>
      </div>
    </div>
  );
}

/* ── Card ─────────────────────────────────────────────────────────────── */

function Card({
  item,
  onClick,
}: {
  item: CardItem;
  onClick: (v: string) => void;
}) {
  const providerName = item.peerLabel?.replace(/\s*\([^)]*\)\s*$/, '') || item.provider || 'Peer';
  const hasPricing = item.inputUsdPerMillion > 0 || item.outputUsdPerMillion > 0;

  return (
    <div
      className={styles.card}
      onClick={() => onClick(item.value)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(item.value); } }}
    >
      {/* Body: tags, name, description, pricing */}
      <div className={styles.cardBody}>
        <div className={styles.cardTags}>
          {item.tags.map((t) => (
            <span key={t} className={styles.tag}>{t}</span>
          ))}
        </div>
        <div className={styles.cardName}>{item.name}</div>
        <div className={styles.cardDesc}>{item.description}</div>
        {hasPricing && (
          <div className={styles.cardPricing}>
            <span>{formatPrice(item.inputUsdPerMillion)} input tokens</span>
            <span className={styles.pricingDot} />
            <span>{formatPrice(item.outputUsdPerMillion)} output tokens</span>
          </div>
        )}
        {!hasPricing && (
          <div className={styles.cardPricing}>
            <span>Free</span>
          </div>
        )}
      </div>

      {/* Footer: provider + stats */}
      <div className={styles.cardFooter}>
        <div className={styles.cardProvider}>
          <span className={styles.cardProviderBy}>By</span>
          <ProviderAvatar name={providerName} gradient={item.gradient} />
          <span className={styles.cardProviderName}>{providerName}</span>
        </div>
        {item.providerCount > 1 && (
          <span className={styles.cardProviderCount}>
            {item.providerCount} providers
          </span>
        )}
      </div>
    </div>
  );
}
