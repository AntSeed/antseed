import { useState, useMemo, useCallback } from 'react';
import Skeleton from 'react-loading-skeleton';
import 'react-loading-skeleton/dist/skeleton.css';
import type { ChatServiceOptionEntry } from '../../../core/state';
import { stringHash, PEER_GRADIENTS, getPeerDisplayName, formatPerMillionPrice } from '../../../core/peer-utils';
import styles from './DiscoverWelcome.module.scss';

/* ── Filter categories ───────────────────────────────────────────────── */

/* ── Known service categories ────────────────────────────────────────── */

const SERVICE_CATEGORIES = [
  'Code', 'Text', 'Image', 'Reasoning', 'Agents',
  'Research', 'Writing', 'Fast', 'Private', 'Free',
] as const;

const SERVICE_CATEGORIES_LOWER = new Set(SERVICE_CATEGORIES.map((c) => c.toLowerCase()));

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
  inputUsdPerMillion: number | null;
  outputUsdPerMillion: number | null;
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

function getGradient(name: string): string {
  const lower = name.toLowerCase();
  for (const [key, gradient] of Object.entries(SERVICE_GRADIENTS)) {
    if (lower.includes(key)) return gradient;
  }
  return PEER_GRADIENTS[stringHash(lower) % PEER_GRADIENTS.length];
}

/* ── Capitalize category label ────────────────────────────────────────── */

function capitalizeCategory(cat: string): string {
  if (cat.length === 0) return cat;
  return cat.charAt(0).toUpperCase() + cat.slice(1);
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
  return options.map((opt) => {
    const tags = opt.categories.map(capitalizeCategory);
    return {
      name: opt.label || opt.id,
      peerLabel: opt.peerLabel || '',
      value: opt.value,
      provider: opt.provider,
      providerCount: opt.count,
      tags,
      gradient: getGradient(opt.peerLabel || opt.provider || opt.id),
      description: opt.description || generateDescription(opt.id, opt.categories, opt.peerLabel || opt.provider),
      inputUsdPerMillion: opt.inputUsdPerMillion,
      outputUsdPerMillion: opt.outputUsdPerMillion,
    };
  });
}

/* ── Filter pills: only show categories present in the data ──────────── */

function activeFilters(cards: CardItem[]): string[] {
  const present = new Set<string>();
  for (const card of cards) {
    for (const tag of card.tags) {
      present.add(tag.toLowerCase());
    }
  }
  return SERVICE_CATEGORIES.filter((c) => present.has(c.toLowerCase()));
}

function matchesFilter(item: CardItem, filter: string): boolean {
  if (filter === 'All') return true;
  return item.tags.some((t) => t.toLowerCase() === filter.toLowerCase());
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

  const hasNetworkData = serviceOptions.length > 0;
  const cards = useMemo(
    () => (serviceOptions.length > 0 ? buildCards(serviceOptions) : []),
    [serviceOptions],
  );

  const filters = useMemo(() => activeFilters(cards), [cards]);

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
      <div className={styles.cardsScroll}>
        <div className={styles.cardsInner}>

          <div className={styles.header}>
            <h1 className={styles.heading}>
              What do you need <span className={styles.headingAccent}>AI</span> for?
            </h1>
            <p className={styles.subtitle}>
              Pick a service to start chatting. Filter by what you need.
              Everything is anonymous — no account required.
            </p>
          </div>

          {filters.length > 0 && (
          <div className={styles.filters}>
            <button
              className={`${styles.filterPill}${activeFilter === 'All' ? ` ${styles.filterActive}` : ''}`}
              onClick={() => setActiveFilter('All')}
            >
              All
            </button>
            {filters.map((f) => (
              <button
                key={f}
                className={`${styles.filterPill}${activeFilter === f ? ` ${styles.filterActive}` : ''}`}
                onClick={() => setActiveFilter(f)}
              >
                {f}
              </button>
            ))}
          </div>
          )}
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
  const providerName = (item.peerLabel ? getPeerDisplayName(item.peerLabel) : '') || item.provider || 'Peer';
  const hasInput = item.inputUsdPerMillion != null;
  const hasOutput = item.outputUsdPerMillion != null;
  const isFree = hasInput && hasOutput && item.inputUsdPerMillion === 0 && item.outputUsdPerMillion === 0;

  return (
    <div
      className={styles.card}
      onClick={() => onClick(item.value)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(item.value); } }}
    >
      <div className={styles.cardBody}>
        <div className={styles.cardTags}>
          {item.tags.map((t) => (
            <span key={t} className={styles.tag}>{t}</span>
          ))}
        </div>
        <div className={styles.cardName}>{item.name}</div>
        <div className={styles.cardDesc}>{item.description}</div>
        <div className={styles.cardPricing}>
          {isFree ? (
            <span>Free</span>
          ) : hasInput || hasOutput ? (
            <>
              <span>{formatPerMillionPrice(item.inputUsdPerMillion ?? 0)} input tokens</span>
              <span className={styles.pricingDot} />
              <span>{formatPerMillionPrice(item.outputUsdPerMillion ?? 0)} output tokens</span>
            </>
          ) : null}
        </div>
      </div>

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
