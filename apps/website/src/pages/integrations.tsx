import {useMemo, useState, useEffect} from 'react';
import Link from '@docusaurus/Link';
import Layout from '@theme/Layout';
import Head from '@docusaurus/Head';
import {
  integrations,
  CATEGORY_LABELS,
  CATEGORY_TAGLINES,
  CATEGORY_ORDER,
  STATUS_LABELS,
  type IntegrationCategory,
  type Integration,
} from '../integrations/integrations';
import styles from '../integrations/integrations.module.css';

/* --------------------------- Category icons --------------------------- *
 * Inline SVG, ~20x20, stroke-based. Centralized so we don't sprinkle
 * ASCII glyphs around the UI.
 * -------------------------------------------------------------------- */

function CategoryIcon({category}: {category: IntegrationCategory}) {
  const common = {
    width: 20,
    height: 20,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.6,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };
  switch (category) {
    case 'coding-agent':
      return (
        <svg {...common}>
          <polyline points="8 7 3 12 8 17" />
          <polyline points="16 7 21 12 16 17" />
          <line x1="14" y1="4" x2="10" y2="20" />
        </svg>
      );
    case 'agent-platform':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="3.5" />
          <circle cx="12" cy="4.5" r="1.5" />
          <circle cx="19.5" cy="12" r="1.5" />
          <circle cx="12" cy="19.5" r="1.5" />
          <circle cx="4.5" cy="12" r="1.5" />
          <line x1="12" y1="6" x2="12" y2="8.5" />
          <line x1="18" y1="12" x2="15.5" y2="12" />
          <line x1="12" y1="18" x2="12" y2="15.5" />
          <line x1="6" y1="12" x2="8.5" y2="12" />
        </svg>
      );
    case 'framework':
      return (
        <svg {...common}>
          <rect x="3.5" y="3.5" width="7" height="7" rx="1" />
          <rect x="13.5" y="3.5" width="7" height="7" rx="1" />
          <rect x="3.5" y="13.5" width="7" height="7" rx="1" />
          <rect x="13.5" y="13.5" width="7" height="7" rx="1" />
        </svg>
      );
    case 'cli':
      return (
        <svg {...common}>
          <rect x="3" y="5" width="18" height="14" rx="2" />
          <polyline points="7 10 10 12 7 14" />
          <line x1="12" y1="15" x2="17" y2="15" />
        </svg>
      );
  }
}

function IntegrationCard({i}: {i: Integration}) {
  return (
    <Link to={`/integrations/${i.slug}`} className={styles.card}>
      <div className={styles.cardHead}>
        <div className={styles.logoWrap}>
          {i.logo ? (
            <img src={`/logos/${i.logo}`} alt="" className={styles.logoImg} />
          ) : (
            <span className={styles.logoGlyph}>{i.glyph ?? i.name[0]}</span>
          )}
        </div>
        <div className={styles.cardMeta}>
          <h3 className={styles.cardTitle}>{i.name}</h3>
        </div>
      </div>
      <p className={styles.cardLine}>{i.oneLiner}</p>
      <div className={styles.cardFooter}>
        <span className={styles.cardSetup}>{i.setupMinutes} min</span>
        {i.status !== 'verified' && (
          <span className={styles.cardSetup}>{STATUS_LABELS[i.status]}</span>
        )}
        <span className={styles.cardArrow} aria-hidden="true">→</span>
      </div>
    </Link>
  );
}

function CategorySection({
  category,
  items,
}: {
  category: IntegrationCategory;
  items: Integration[];
}) {
  if (items.length === 0) return null;
  return (
    <section className={styles.catSection} id={`cat-${category}`}>
      <header className={styles.catHeader}>
        <div className={styles.catGlyph} aria-hidden="true">
          <CategoryIcon category={category} />
        </div>
        <div className={styles.catHeaderText}>
          <div className={styles.catTitleRow}>
            <h2 className={styles.catTitle}>{CATEGORY_LABELS[category]}</h2>
            <span className={styles.catCount}>
              {items.length} {items.length === 1 ? 'tool' : 'tools'}
            </span>
          </div>
          <p className={styles.catTagline}>{CATEGORY_TAGLINES[category]}</p>
        </div>
      </header>
      <div className={styles.catGrid}>
        {items.map((i) => (
          <IntegrationCard key={i.slug} i={i} />
        ))}
      </div>
    </section>
  );
}

export default function ConnectHub(): JSX.Element {
  const [query, setQuery] = useState('');

  const grouped = useMemo<Record<IntegrationCategory, Integration[]>>(() => {
    const out = {} as Record<IntegrationCategory, Integration[]>;
    for (const cat of CATEGORY_ORDER) out[cat] = [];
    for (const i of integrations) {
      if (query.trim()) {
        const q = query.toLowerCase();
        if (
          !i.name.toLowerCase().includes(q) &&
          !i.oneLiner.toLowerCase().includes(q) &&
          !CATEGORY_LABELS[i.category].toLowerCase().includes(q)
        )
          continue;
      }
      out[i.category].push(i);
    }
    return out;
  }, [query]);

  const totalShown = useMemo(
    () => Object.values(grouped).reduce((n, arr) => n + arr.length, 0),
    [grouped],
  );

  // Smooth-scroll to anchor on click. Avoids the default jumpy behavior on
  // long pages and accounts for the fixed navbar height.
  useEffect(() => {
    function onClick(e: MouseEvent) {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const anchor = target.closest('a[data-jump]') as HTMLAnchorElement | null;
      if (!anchor) return;
      const id = anchor.getAttribute('data-jump');
      if (!id) return;
      const el = document.getElementById(id);
      if (!el) return;
      e.preventDefault();
      const top = el.getBoundingClientRect().top + window.scrollY - 80;
      window.scrollTo({top, behavior: 'smooth'});
      history.replaceState(null, '', `#${id}`);
    }
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, []);

  return (
    <Layout
      title="Integrations — AntSeed"
      description="Every way to use AntSeed: coding agents, autonomous agents, editors, SDKs, frameworks, partner platforms. Anthropic and OpenAI compatible. Drop-in via localhost:8377.">
      <Head>
        <link
          rel="alternate"
          type="text/markdown"
          href="/skill.md"
          title="Agent-readable integration guide"
        />
      </Head>

      <section className={styles.hero}>
        <span className={styles.kicker}>Integrations</span>
        <h1 className={styles.heroTitle}>One local endpoint. Every tool you already use.</h1>
        <p className={styles.heroSub}>
          AntSeed runs a buyer proxy at <code>http://localhost:8377</code> that speaks{' '}
          <strong>all four major LLM API protocols</strong> — Anthropic Messages,
          OpenAI Chat Completions, OpenAI Responses, and OpenAI Completions — and
          translates between them on the fly. Pick your tool below; AntSeed makes it
          fit. Each <em>service</em> on the network advertises which protocols it
          accepts <em>natively</em> (in <code>matchingServices[].protocols</code>) —
          matching your tool's wire format to that list is the smoothest path.
        </p>
        <div className={styles.heroCtaRow}>
          <Link to="/docs/install" className={styles.heroCta}>
            Install AntSeed →
          </Link>
          <a href="/skill.md" className={styles.heroCtaGhost}>
            For agents: skill.md →
          </a>
        </div>
      </section>

      <nav className={styles.jumpNav} aria-label="Jump to category">
        {CATEGORY_ORDER.map((cat) => {
          const count = grouped[cat].length;
          if (count === 0) return null;
          return (
            <a
              key={cat}
              href={`#cat-${cat}`}
              data-jump={`cat-${cat}`}
              className={styles.jumpLink}>
              <span className={styles.jumpIcon}>
                <CategoryIcon category={cat} />
              </span>
              <span className={styles.jumpLabel}>{CATEGORY_LABELS[cat]}</span>
              <span className={styles.jumpCount}>{count}</span>
            </a>
          );
        })}
      </nav>

      <section className={styles.searchRow}>
        <input
          type="search"
          placeholder="Search integrations…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className={styles.search}
        />
        {query && (
          <span className={styles.resultCount}>
            {totalShown} match{totalShown === 1 ? '' : 'es'}
          </span>
        )}
      </section>

      <div className={styles.sections}>
        {totalShown === 0 ? (
          <p className={styles.noResults}>
            No matches for <strong>{query}</strong>. Try the{' '}
            <Link to="/integrations/curl">raw HTTP page</Link> — anything that speaks Anthropic or
            OpenAI works.
          </p>
        ) : (
          CATEGORY_ORDER.map((cat) => (
            <CategorySection key={cat} category={cat} items={grouped[cat]} />
          ))
        )}
      </div>

      <section className={styles.bottomBlock}>
        <div>
          <h3>Don't see your tool?</h3>
          <p>
            If your tool accepts an Anthropic or OpenAI base URL, AntSeed already works with
            it — see the <Link to="/integrations/curl">raw HTTP page</Link> for the contract. Want
            it added here? Open a PR on{' '}
            <a
              href="https://github.com/AntSeed/antseed/blob/main/apps/website/src/integrations/integrations.ts"
              target="_blank"
              rel="noopener noreferrer">
              integrations.ts
            </a>
            .
          </p>
        </div>
        <div>
          <h3>Building an integration?</h3>
          <p>
            Read the <Link to="/docs/guides/using-the-api">protocol guide</Link>, grab{' '}
            <a href="/skill.md">skill.md</a> for your agent, and ping us in{' '}
            <a href="https://t.me/antseed" target="_blank" rel="noopener noreferrer">
              Telegram
            </a>{' '}
            for partner verification.
          </p>
        </div>
      </section>
    </Layout>
  );
}
