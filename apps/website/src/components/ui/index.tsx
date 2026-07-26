/**
 * Shared design-system components, extracted from the homepage —
 * the reference implementation of the Figma design. Use these on
 * every page instead of re-implementing buttons/FAQs/headers.
 */
import {useEffect, useRef, useState, type CSSProperties, type ReactNode} from 'react';
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
export function ArrowRight() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
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
  children,
}: {
  /** dark: ink fill · ghost: white + hairline · light: outline on dark surfaces · white: white fill on dark */
  variant?: 'dark' | 'ghost' | 'light' | 'white';
  /** md: 40px (sections) · lg: 48px (hero / final CTA) */
  size?: 'md' | 'lg';
  to?: string;
  href?: string;
  arrow?: boolean;
  osIcons?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const cls = [
    styles.btn,
    size === 'lg' && styles.btnLg,
    variant === 'dark' && styles.btnDark,
    variant === 'ghost' && styles.btnGhost,
    variant === 'light' && styles.btnLight,
    variant === 'white' && styles.btnWhite,
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

/* ---------- SectionHeader ---------- */
export function SectionHeader({
  kicker,
  title,
  lead,
}: {
  kicker?: string;
  title: ReactNode;
  lead?: string;
}) {
  return (
    <>
      {kicker && <p className={styles.kicker}>{kicker}</p>}
      <h2 className={styles.title}>{title}</h2>
      {lead && <p className={styles.lead}>{lead}</p>}
    </>
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
