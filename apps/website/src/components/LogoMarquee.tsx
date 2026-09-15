import type {ReactNode} from 'react';
import styles from '../pages/index.module.css';
import {
  Anthropic,
  OpenAI,
  Google,
  DeepSeek,
  Meta,
  Qwen,
  Mistral,
  Moonshot,
  Zhipu,
  Minimax,
  Cohere,
  NousResearch,
} from '@lobehub/icons';

type IconSize = (props: {size?: number}) => ReactNode;
type IconCombine = (props: {size?: number; textMultiple?: number}) => ReactNode;
type LobeIcon = IconSize & {Combine?: IconCombine; Text?: IconSize};
const LOBE_ICONS: Record<string, LobeIcon> = {
  Anthropic,
  OpenAI,
  Google,
  DeepSeek,
  Meta,
  Qwen,
  Mistral,
  Moonshot,
  Zhipu,
  Minimax,
  Cohere,
  NousResearch,
};

/* ============================================================
   LOGO MARQUEE — model lockups drifting across the ink band
   ============================================================ */
/* Per-logo optical height — normalizes perceived size, not component
   defaults. Wide/flat wordmarks sit a touch shorter; compact icon+text
   marks sit a touch taller, so every lockup reads as roughly the same
   visual weight in the row. Rendered via @lobehub/icons' `.Combine`
   (icon + real wordmark) so every brand gets its official lockup. */
const MARQUEE_LOCKUPS: [string, number][] = [
  ['Anthropic', 16],
  ['OpenAI', 22],
  ['Google', 22],
  ['DeepSeek', 22],
  ['Meta', 22],
  ['Qwen', 22],
  ['Mistral', 20],
  ['Moonshot', 20],
  ['Zhipu', 20],
  ['Minimax', 20],
  ['Cohere', 20],
  ['NousResearch', 18],
];

export function LogoMarquee() {
  const run = MARQUEE_LOCKUPS.map(([name, size]) => {
    const Icon = LOBE_ICONS[name];
    // Anthropic ships no `.Combine` in this package — `.Text` is its full
    // wordmark (same official mark). Google ships icon-only variants, and
    // Meta's `.Text` here actually draws "Llama" (the model brand), not
    // the Meta wordmark — both fall back to the real fetched SVGs.
    let content: ReactNode;
    if (name === 'Google' || name === 'Meta') {
      const file = name === 'Google' ? 'google.svg' : 'meta.svg';
      content = <img src={`/logos/lockups/${file}`} alt={name} loading="lazy" style={{height: size}} />;
    } else if (name === 'NousResearch') {
      // The package's NousResearch wordmark reports a 35px box but paints
      // wider, colliding with the next lockup. Icon + a set wordmark instead.
      content = (
        <span className={styles.marqueeLockup}>
          <Icon size={size} />
          <span className={styles.marqueeWordmark}>Nous Research</span>
        </span>
      );
    } else if (Icon.Combine) {
      // Each brand ships its own text/icon ratio (0.45–0.85); normalize
      // to one consistent multiple so no wordmark reads smaller than the rest.
      content = <Icon.Combine size={size} textMultiple={0.85} />;
    } else {
      content = <Icon.Text size={size} />;
    }
    return (
      <span className={styles.marqueeItem} key={name}>
        {content}
      </span>
    );
  });
  return (
    <section className={styles.marqueeBand} aria-label="Models available on the network">
      <div className={styles.marquee}>
        <div className={styles.marqueeRun}>{run}</div>
        <div className={styles.marqueeRun} aria-hidden="true">{run}</div>
      </div>
    </section>
  );
}
