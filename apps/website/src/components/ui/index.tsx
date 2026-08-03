/**
 * Shared design-system components, extracted from the homepage —
 * the reference implementation of the Figma design. Use these on
 * every page instead of re-implementing buttons/FAQs/headers.
 */
import {useEffect, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode} from 'react';
import Link from '@docusaurus/Link';
import styles from './ui.module.css';

/* ---------- Reveal — scroll-triggered entrance ---------- */
/**
 * Fades + lifts its content in the first time it scrolls into view.
 * Renders visible for SSR/no-JS (hidden state only applies under
 * `html[data-anim]`, set on hydration) and respects reduced motion.
 * `delay` (ms) staggers siblings, e.g. cards in a grid.
 */
export function Reveal({
  children,
  delay = 0,
  className,
  style,
}: {
  children: ReactNode;
  delay?: number;
  className?: string;
  style?: CSSProperties;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    if (
      typeof IntersectionObserver === 'undefined' ||
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ) {
      setShown(true);
      return undefined;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setShown(true);
          observer.disconnect();
        }
      },
      {rootMargin: '0px 0px -8% 0px', threshold: 0.05},
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      className={[styles.reveal, shown && styles.revealShown, className].filter(Boolean).join(' ')}
      style={delay ? {...style, transitionDelay: `${delay}ms`} : style}>
      {children}
    </div>
  );
}

/* ---------- icons — exact glyphs from the Figma file ---------- */
/* ri:apple-fill (20) */
export function AppleIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path d="M9.72749 6.01831C8.99749 6.01831 7.86749 5.18831 6.67749 5.21831C5.10749 5.23831 3.66749 6.12831 2.85749 7.53831C1.22749 10.3683 2.43749 14.5483 4.02749 16.8483C4.80749 17.9683 5.72749 19.2283 6.94749 19.1883C8.11749 19.1383 8.55749 18.4283 9.97749 18.4283C11.3875 18.4283 11.7875 19.1883 13.0275 19.1583C14.2875 19.1383 15.0875 18.0183 15.8575 16.8883C16.7475 15.5883 17.1175 14.3283 17.1375 14.2583C17.1075 14.2483 14.6875 13.3183 14.6575 10.5183C14.6375 8.17831 16.5675 7.05831 16.6575 7.00831C15.5575 5.39831 13.8675 5.21831 13.2775 5.17831C11.7375 5.05831 10.4475 6.01831 9.72749 6.01831ZM12.3275 3.65831C12.9775 2.87831 13.4075 1.78831 13.2875 0.708313C12.3575 0.748313 11.2375 1.32831 10.5675 2.10831C9.96749 2.79831 9.44749 3.90831 9.58749 4.96831C10.6175 5.04831 11.6775 4.43831 12.3275 3.65831Z" />
    </svg>
  );
}

/* ri:windows-fill (20) */
export function WindowsIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path d="M2.50083 4.56583L8.64833 3.71917V9.65833H2.5L2.50083 4.56583ZM2.50083 15.4342L8.64833 16.2817V10.415H2.5L2.50083 15.4342ZM9.32417 16.3717L17.5008 17.5V10.415H9.32417V16.3717ZM9.32417 3.62833V9.65833H17.5008V2.5L9.32417 3.62833Z" />
    </svg>
  );
}

/* hugeicons:arrow-right-02 (20) */
export function ArrowRight({size = 20}: {size?: number}) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M15.4167 10H4.16669M10.8334 15C10.8334 15 15.8334 11.3175 15.8334 10C15.8334 8.6825 10.8334 5 10.8334 5" />
    </svg>
  );
}

/* ---------- Button — the Figma "Default model" pill ---------- */
export function Button({
  variant = 'dark',
  size = 'md',
  to,
  href,
  arrow,
  osIcons,
  className,
  onClick,
  children,
}: {
  /** dark: ink fill · ghost: white + hairline · light: outline on dark surfaces · white: white fill on dark · clay: economics pages only */
  variant?: 'dark' | 'ghost' | 'light' | 'white' | 'clay';
  /** md: 40px (sections) · lg: 48px (hero / final CTA) */
  size?: 'md' | 'lg';
  to?: string;
  href?: string;
  arrow?: boolean;
  osIcons?: boolean;
  className?: string;
  /** intercept navigation (e.g. reroute mobile taps); may preventDefault */
  onClick?: (e: MouseEvent<HTMLAnchorElement>) => void;
  children: ReactNode;
}) {
  const cls = [
    styles.btn,
    size === 'lg' && styles.btnLg,
    variant === 'dark' && styles.btnDark,
    variant === 'ghost' && styles.btnGhost,
    variant === 'light' && styles.btnLight,
    variant === 'white' && styles.btnWhite,
    variant === 'clay' && styles.btnClay,
    className,
  ]
    .filter(Boolean)
    .join(' ');
  const inner = (
    <>
      {osIcons && (
        <span className={`${styles.osIcons} vprOsIcons`}>
          <AppleIcon />
          <WindowsIcon />
        </span>
      )}
      {children}
      {arrow && <ArrowRight />}
    </>
  );
  if (to) {
    return (
      <Link to={to} className={cls} onClick={onClick}>
        {inner}
      </Link>
    );
  }
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={cls} onClick={onClick}>
      {inner}
    </a>
  );
}

/* ---------- SectionHeader ---------- */
export function SectionHeader({
  kicker,
  title,
  lead,
}: {
  kicker?: string;
  title: ReactNode;
  lead?: ReactNode;
}) {
  return (
    <>
      {kicker && <p className={styles.kicker}>{kicker}</p>}
      <h2 className={styles.title}>{title}</h2>
      {lead && <p className={styles.lead}>{lead}</p>}
    </>
  );
}

/* ---------- Section — the page rhythm (96/64px bands, 1200 inner) ----------
   `tone` picks the surface: plain white, the tinted #F4F5F4 well, or the ink
   band. `width` narrows the content column without breaking the band. */
export function Section({
  tone = 'plain',
  width = 'lg',
  compact,
  id,
  className,
  innerClassName,
  children,
}: {
  tone?: 'plain' | 'tinted' | 'ink';
  width?: 'sm' | 'md' | 'lg' | 'xl';
  /** half-height band, for filter bars and other chrome */
  compact?: boolean;
  id?: string;
  className?: string;
  innerClassName?: string;
  children: ReactNode;
}) {
  return (
    <section
      id={id}
      className={[
        styles.section,
        tone === 'tinted' && styles.sectionTinted,
        tone === 'ink' && styles.sectionInk,
        compact && styles.sectionCompact,
        className,
      ]
        .filter(Boolean)
        .join(' ')}>
      <div
        className={[
          styles.sectionInner,
          width === 'sm' && styles.widthSm,
          width === 'md' && styles.widthMd,
          width === 'xl' && styles.widthXl,
          innerClassName,
        ]
          .filter(Boolean)
          .join(' ')}>
        {children}
      </div>
    </section>
  );
}

/* Grid step must match .pageHeroDotsVisible background-size (9px tiles,
   same as the brand page's "Dot grid" motif swatch) so the sparkle lands
   exactly on a real dot. */
const HERO_GRID_STEP = 9;

function PageHeroSparkle() {
  const ref = useRef<HTMLDivElement>(null);
  const [dot, setDot] = useState<{x: number; y: number; key: number} | null>(null);

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined;
    let key = 0;
    const pick = () => {
      const el = ref.current;
      if (!el) return;
      const {width, height} = el.getBoundingClientRect();
      const cols = Math.max(1, Math.floor(width / HERO_GRID_STEP));
      const rows = Math.max(1, Math.floor(height / HERO_GRID_STEP));
      const col = Math.floor(Math.random() * cols);
      const row = Math.floor(Math.random() * rows);
      key += 1;
      setDot({x: HERO_GRID_STEP / 2 + col * HERO_GRID_STEP, y: HERO_GRID_STEP / 2 + row * HERO_GRID_STEP, key});
    };
    pick();
    const id = setInterval(pick, 4000);
    return () => clearInterval(id);
  }, []);

  return (
    <div ref={ref} className={styles.pageHeroSparkleLayer} aria-hidden="true">
      {dot && <span key={dot.key} className={styles.pageHeroSparkleDot} style={{left: dot.x, top: dot.y}} />}
    </div>
  );
}

/* ---------- PageHero — the homepage hero's type scale, for inner pages ----------
   Same dot-grid backdrop, kicker, display title and 18/26 lead as the home
   hero, so every page opens in the same voice. */
export function PageHero({
  kicker,
  title,
  badge,
  lead,
  note,
  accent = 'green',
  animatedDots = false,
  children,
}: {
  kicker?: ReactNode;
  title: ReactNode;
  /** status pill under the title */
  badge?: ReactNode;
  lead?: ReactNode;
  /** small line under the buttons */
  note?: ReactNode;
  /** clay tints the dot grid + <em> for the economics page */
  accent?: 'green' | 'clay';
  /** swaps in the visible gray dot grid from the brand page's "Dot grid"
   * motif (instead of the default barely-there grid) plus a single
   * randomly-picked dot that sparkles on repeat */
  animatedDots?: boolean;
  /** button row */
  children?: ReactNode;
}) {
  return (
    <header className={`${styles.pageHero} ${accent === 'clay' ? styles.pageHeroClay : ''}`}>
      <div className={`${styles.pageHeroDots} ${animatedDots ? styles.pageHeroDotsVisible : ''}`} aria-hidden="true">
        {animatedDots && <PageHeroSparkle />}
      </div>
      <div className={styles.pageHeroInner}>
        {kicker && <p className={styles.kicker}>{kicker}</p>}
        <h1 className={styles.pageHeroTitle}>{title}</h1>
        {badge && <div className={styles.pageHeroBadge}>{badge}</div>}
        {lead && <p className={styles.pageHeroLead}>{lead}</p>}
        {children && <div className={styles.pageHeroCtas}>{children}</div>}
        {note && <div className={styles.pageHeroNote}>{note}</div>}
      </div>
    </header>
  );
}

/* ---------- StatTile — the shared number card ---------- */
export function StatTile({
  value,
  label,
  accent,
}: {
  value: ReactNode;
  label: ReactNode;
  accent?: boolean;
}) {
  return (
    <div className={styles.statTile}>
      <strong className={`${styles.statTileValue} ${accent ? styles.statTileAccent : ''}`}>{value}</strong>
      <span className={styles.statTileLabel}>{label}</span>
    </div>
  );
}

/* ---------- LinkArrow — inline "keep reading" link, ink + arrow glyph ----------
   Replaces the literal "→" characters that used to be typed into copy. */
export function LinkArrow({
  to,
  href,
  className,
  children,
}: {
  to?: string;
  href?: string;
  className?: string;
  children: ReactNode;
}) {
  const cls = [styles.linkArrow, className].filter(Boolean).join(' ');
  const inner = (
    <>
      {children}
      <ArrowRight size={16} />
    </>
  );
  if (to) {
    return (
      <Link to={to} className={cls}>
        {inner}
      </Link>
    );
  }
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={cls}>
      {inner}
    </a>
  );
}

/* ---------- Ticks — render `backticks` in authored copy as <code> ----------
   Integration copy is written in markdown-ish plain strings; without this the
   backticks render literally on the page. */
const TICK_SPLIT = /(`[^`]+`)/g;

export function Ticks({children}: {children?: string}) {
  if (!children) return null;
  return (
    <>
      {children.split(TICK_SPLIT).map((part, i) =>
        part.length > 2 && part.startsWith('`') && part.endsWith('`') ? (
          <code key={i}>{part.slice(1, -1)}</code>
        ) : (
          part
        ),
      )}
    </>
  );
}

/** Same conversion for strings that are injected as HTML. */
export function ticksToHtml(html: string) {
  return html.replace(/`([^`]+)`/g, '<code>$1</code>');
}

/* ---------- Terminal — the ink code card from the homepage ---------- */
export function Terminal({
  title,
  children,
  className,
}: {
  title?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={[styles.terminal, className].filter(Boolean).join(' ')}>
      <div className={styles.terminalBar}>
        <span className={styles.terminalDots} aria-hidden="true">
          <i /><i /><i />
        </span>
        {title && <span className={styles.terminalTitle}>{title}</span>}
      </div>
      <pre className={styles.terminalBody}>{children}</pre>
    </div>
  );
}

/* ---------- FinalCta — the ink closing band, shared by every page ---------- */
export function FinalCta({
  title,
  sub,
  note,
  children,
}: {
  title: ReactNode;
  sub?: ReactNode;
  note?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className={styles.finalCta}>
      <Reveal className={styles.finalCtaInner}>
        <h2 className={styles.finalCtaTitle}>{title}</h2>
        {sub && <p className={styles.finalCtaSub}>{sub}</p>}
        <div className={styles.finalCtaBtns}>{children}</div>
        {note && <p className={styles.finalCtaNote}>{note}</p>}
      </Reveal>
    </section>
  );
}

/* ---------- Faq — white pill rows (Figma "Fair questions.") ---------- */
export interface FaqItem {
  q: string;
  /** Answer — plain text or an HTML string (links, <code>). */
  a: string;
}

export function Faq({items, defaultOpen = null}: {items: FaqItem[]; defaultOpen?: number | null}) {
  const [openIdx, setOpenIdx] = useState<number | null>(defaultOpen);
  return (
    <div className={styles.faqList}>
      {items.map((item, i) => (
        <div key={i} className={styles.faqItem}>
          <button
            type="button"
            className={styles.faqSummary}
            aria-expanded={openIdx === i}
            onClick={() => setOpenIdx(openIdx === i ? null : i)}>
            <span>{item.q}</span>
            <span className={`${styles.faqToggle} ${openIdx === i ? styles.faqToggleOpen : ''}`}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 4V20M20 12H4" />
              </svg>
            </span>
          </button>
          <div className={`${styles.faqCollapse} ${openIdx === i ? styles.faqCollapseOpen : ''}`}>
            <p className={styles.faqAnswer} dangerouslySetInnerHTML={{__html: item.a}} />
          </div>
        </div>
      ))}
    </div>
  );
}
