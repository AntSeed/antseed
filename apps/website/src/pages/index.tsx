import {useEffect, useRef, useState, type MutableRefObject, type RefObject, type ReactNode, type CSSProperties} from 'react';
import Head from '@docusaurus/Head';
import Link from '@docusaurus/Link';
import {useHistory} from '@docusaurus/router';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import Layout from '@theme/Layout';
import styles from './index.module.css';
import {useLatestDesktopDownload} from '../lib/useLatestDesktopDownload';
import {useNetworkStats} from '../lib/useNetworkStats';
import {useMarketplaceShowcase} from '../lib/useMarketplacePrices';
import {Button, Faq, Reveal, SectionHeader, ArrowRight} from '../components/ui';
import {HeroDemo, DEMO_BEATS, DEMO_TOTAL_FRAMES} from '../components/HeroDemo';
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
  XiaomiMiMo,
  Tencent,
  Stepfun,
  Nvidia,
  XAI,
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
   COUNT-UP — numbers tick up (expo ease) when scrolled into view.
   Keeps prefix/suffix and digit grouping: "$143K+", "18,440".
   ============================================================ */
function CountUp({value, duration = 1100}: {value: string; duration?: number}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [text, setText] = useState(value);

  useEffect(() => {
    const el = ref.current;
    const match = value.match(/^(\D*)([\d,.]+)(.*)$/);
    if (!el || !match) return undefined;
    if (
      typeof IntersectionObserver === 'undefined' ||
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ) {
      return undefined;
    }
    const prefix = match[1];
    const digits = match[2].replace(/,/g, '');
    const suffix = match[3];
    const target = parseFloat(digits) || 0;
    const decimals = digits.includes('.') ? digits.split('.')[1].length : 0;
    const format = (n: number) =>
      prefix +
      n.toLocaleString('en-US', {minimumFractionDigits: decimals, maximumFractionDigits: decimals}) +
      suffix;
    setText(format(0));
    let raf = 0;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        observer.disconnect();
        const start = performance.now();
        const tick = (now: number) => {
          const t = Math.min((now - start) / duration, 1);
          const eased = t === 1 ? 1 : 1 - Math.pow(2, -10 * t);
          setText(format(t >= 1 ? target : target * eased));
          if (t < 1) raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
      },
      {threshold: 0.4},
    );
    observer.observe(el);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [value, duration]);

  return <span ref={ref}>{text}</span>;
}

/* ============================================================
   HERO DOT CANVAS — dot grid that ripples out from the demo and
   surfaces the AntSeed ant, in sync with the live demo timeline.
   Ported from the design prototype (Remotion beats at 30 fps).
   ============================================================ */
const BEATS = DEMO_BEATS;
const ANT_H = 800;
const ANT_W = Math.round((15.2738 / 18) * ANT_H);
const DOT_LIGHT = '213,217,215';
const DOT_DARK = '197,208,203';
const SPARKLE_RGB = [16, 185, 129] as const;
const SAMPLE_OFFSETS = [-4, 0, 4];

const parseRgb = (s: string) => s.split(',').map(Number);

const isDarkTheme = () =>
  document.documentElement.dataset.theme === 'dark' ||
  (document.documentElement.dataset.theme !== 'light' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches);

interface HeroDot {
  x: number;
  y: number;
  arrival: number;
  isAnt: boolean;
  sizeFactor: number;
  appearAt: number;
  dissolveAt: number;
  sparkles: {start: number; end: number}[];
}

function HeroDotCanvas({
  frameRef,
  shutdownRef,
  originRef,
}: {
  frameRef: MutableRefObject<number>;
  /** 0 while the demo loops; otherwise the manual power-off's virtual frame. */
  shutdownRef: MutableRefObject<number>;
  originRef: RefObject<HTMLDivElement>;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const ctx = canvas.getContext('2d', {alpha: true});
    if (!ctx) return undefined;
    const host = canvas.parentElement;
    if (!host) return undefined;

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let color = isDarkTheme() ? DOT_DARK : DOT_LIGHT;
    let disposed = false;
    let width = 0;
    let height = 0;
    let dots: HeroDot[] = [];
    let dotScale = 1;

    // Offscreen raster of the ant silhouette, alpha-sampled per dot.
    const antCanvas = document.createElement('canvas');
    antCanvas.width = ANT_W;
    antCanvas.height = ANT_H;
    const antCtx = antCanvas.getContext('2d');
    let antAlpha: Uint8ClampedArray | null = null;
    const antImg = new Image();

    const antCoverage = (x: number, y: number, data: Uint8ClampedArray) => {
      let hit = 0;
      let total = 0;
      for (const dy of SAMPLE_OFFSETS) {
        const py = Math.round(y + dy);
        if (py < 0 || py >= ANT_H) continue;
        for (const dx of SAMPLE_OFFSETS) {
          const px = Math.round(x + dx);
          if (px < 0 || px >= ANT_W) continue;
          total++;
          if (data[(py * ANT_W + px) * 4 + 3] > 40) hit++;
        }
      }
      return total > 0 ? hit / total : 0;
    };

    const layout = () => {
      const rect = host.getBoundingClientRect();
      width = Math.max(1, Math.round(rect.width));
      height = Math.max(1, Math.round(rect.height));
      dotScale = width <= 640 ? 0.6 : 1;
      const step = 9 * dotScale;
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      // Ripple origin: the demo card (falls back to hero center).
      let originX = width / 2;
      let originY = 0.375 * height;
      const origin = originRef.current;
      if (origin) {
        const o = origin.getBoundingClientRect();
        originX = o.left - rect.left + 0.5 * o.width;
        originY = o.top - rect.top + 0.375 * o.height;
      }
      const antLeft = originX - ANT_W / 2;
      const antTop = originY - ANT_H / 2 - 120;
      const diagonal = Math.hypot(width, height);

      const next: HeroDot[] = [];
      for (let y = 0; y <= height + step; y += step) {
        for (let x = 0; x <= width + step; x += step) {
          const dist = Math.hypot(x - originX, y - originY);
          const coverage = antAlpha ? antCoverage(x - antLeft, y - antTop, antAlpha) : 0;
          const isAnt = coverage > 0;
          const sizeFactor = isAnt ? (0.4 + 0.6 * coverage) * (0.85 + 0.3 * Math.random()) : 1;

          // A sparse subset of ant dots twinkle green once the ant has settled.
          const sparkles: {start: number; end: number}[] = [];
          if (isAnt && Math.random() < 0.035) {
            const lifeStart = BEATS.surfaceStart + 70;
            const lifeEnd = BEATS.fadeOutStart - 20;
            let t = lifeStart + Math.random() * (lifeEnd - lifeStart);
            while (t < lifeEnd) {
              const dur = 22 + Math.random() * 12;
              sparkles.push({start: t, end: t + dur});
              t += dur + 200 + Math.random() * 300;
            }
          }

          next.push({
            x,
            y,
            arrival: BEATS.surfaceStart + (dist / diagonal) * 36,
            isAnt,
            sizeFactor,
            appearAt: isAnt ? BEATS.surfaceStart + 40 * Math.random() : 0,
            dissolveAt: isAnt
              ? BEATS.fadeOutStart + Math.random() * (BEATS.fadeOutEnd - BEATS.fadeOutStart)
              : 0,
            sparkles,
          });
        }
      }
      dots = next;
    };

    const antAlphaAt = (frame: number, appearAt: number, dissolveAt: number) => {
      if (frame < appearAt) return 0;
      const fadeIn = Math.min(1, (frame - appearAt) / 3);
      if (frame < dissolveAt) return fadeIn;
      return fadeIn * Math.max(0, 1 - (frame - dissolveAt) / 3);
    };

    const rippleAlphaAt = (sinceArrival: number) => {
      if (sinceArrival < 0) return 0;
      if (sinceArrival < 5) return sinceArrival / 5;
      if (sinceArrival < 8) return 1;
      const fading = sinceArrival - 8;
      return fading < 12 ? 1 - fading / 12 : 0;
    };

    /**
     * Manual power-off: the scene frame is frozen, so the dots dissolve off
     * `shut` — a virtual frame sweeping the loop's own fade-out window. Each
     * dot keeps its staggered `dissolveAt`, so the ant melts away exactly the
     * way it does at the end of a loop.
     */
    const shutdownAlphaAt = (shut: number, dot: HeroDot) => {
      if (shut <= 0) return 1;
      if (!dot.isAnt) return Math.max(0, 1 - (shut - BEATS.fadeOutStart) / 6);
      if (shut < dot.dissolveAt) return 1;
      return Math.max(0, 1 - (shut - dot.dissolveAt) / 3);
    };

    const drawFrame = (frame: number, shut: number) => {
      ctx.clearRect(0, 0, width, height);
      const baseRgb = parseRgb(color);
      const shutT = shut > 0 ? (shut - BEATS.fadeOutStart) / (BEATS.fadeOutEnd - BEATS.fadeOutStart) : 0;
      for (const dot of dots) {
        const alpha =
          (dot.isAnt
            ? antAlphaAt(frame, dot.appearAt, dot.dissolveAt)
            : rippleAlphaAt(frame - dot.arrival)) * shutdownAlphaAt(shut, dot);
        if (alpha <= 0.01) continue;

        let pulse = 0;
        for (const s of dot.sparkles) {
          if (frame >= s.start && frame <= s.end) {
            const progress = (frame - s.start) / (s.end - s.start);
            pulse = Math.sin(progress * Math.PI); // smooth ease in/out, 0 -> 1 -> 0
            break;
          }
        }
        if (shut > 0) pulse *= Math.max(0, 1 - shutT);

        const radius = 2.6 * dotScale * dot.sizeFactor * (0.5 + 0.5 * alpha) * (1 + 0.6 * pulse);

        if (pulse > 0.02) {
          const glowRadius = radius * (1 + 1.6 * pulse);
          ctx.beginPath();
          ctx.fillStyle = `rgba(${SPARKLE_RGB[0]},${SPARKLE_RGB[1]},${SPARKLE_RGB[2]},${0.16 * pulse})`;
          ctx.arc(dot.x, dot.y, glowRadius, 0, 2 * Math.PI);
          ctx.fill();
        }

        ctx.beginPath();
        if (pulse > 0.02) {
          const sparkleT = pulse * 0.7;
          const r = Math.round(baseRgb[0] + (SPARKLE_RGB[0] - baseRgb[0]) * sparkleT);
          const g = Math.round(baseRgb[1] + (SPARKLE_RGB[1] - baseRgb[1]) * sparkleT);
          const b = Math.round(baseRgb[2] + (SPARKLE_RGB[2] - baseRgb[2]) * sparkleT);
          ctx.fillStyle = `rgba(${r},${g},${b},${Math.min(1, 0.75 * alpha + 0.25 * pulse)})`;
        } else {
          ctx.fillStyle = `rgba(${color},${0.75 * alpha})`;
        }
        ctx.arc(dot.x, dot.y, radius, 0, 2 * Math.PI);
        ctx.fill();
      }
    };

    const drawStatic = () => {
      ctx.clearRect(0, 0, width, height);
      for (const dot of dots) {
        ctx.beginPath();
        ctx.fillStyle = `rgba(${color},${dot.isAnt ? 0.4 : 0.16})`;
        ctx.arc(dot.x, dot.y, 2.6 * dotScale * dot.sizeFactor, 0, 2 * Math.PI);
        ctx.fill();
      }
    };

    antImg.src = '/ant-icon.svg';
    antImg.onload = () => {
      if (disposed || !antCtx) return;
      antCtx.clearRect(0, 0, ANT_W, ANT_H);
      antCtx.drawImage(antImg, 0, 0, ANT_W, ANT_H);
      antAlpha = antCtx.getImageData(0, 0, ANT_W, ANT_H).data;
      layout();
      if (reducedMotion) drawStatic();
    };
    layout();

    if (reducedMotion) {
      drawStatic();
      const resize = new ResizeObserver(() => {
        layout();
        drawStatic();
      });
      resize.observe(host);
      return () => {
        disposed = true;
        resize.disconnect();
      };
    }

    let raf = 0;
    const loop = () => {
      drawFrame(frameRef.current % DEMO_TOTAL_FRAMES, shutdownRef.current);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    const resize = new ResizeObserver(layout);
    resize.observe(host);
    const themeWatch = new MutationObserver(() => {
      color = isDarkTheme() ? DOT_DARK : DOT_LIGHT;
    });
    themeWatch.observe(document.documentElement, {attributes: true, attributeFilter: ['data-theme']});

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      resize.disconnect();
      themeWatch.disconnect();
    };
  }, [frameRef, shutdownRef, originRef]);

  return <canvas ref={canvasRef} className={styles.heroCanvas} aria-hidden="true" />;
}

/* ============================================================
   ROTATING SUBTITLE — cycles hero phrases, then snaps back.
   (From the hero prototype; the Figma frame shows the first.)
   ============================================================ */
const HERO_PHRASES = ['Every Model, No Middleman.', 'Anonymous and Always On.', 'Self hosted.'];
const HERO_LOOP = [...HERO_PHRASES, HERO_PHRASES[0]];

function RotatingSub() {
  const [index, setIndex] = useState(0);
  const [animated, setAnimated] = useState(true);

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined;
    const timer = setTimeout(() => {
      setAnimated(true);
      setIndex((i) => i + 1);
    }, 2400);
    return () => clearTimeout(timer);
  }, [index]);

  useEffect(() => {
    if (index !== HERO_LOOP.length - 1) return undefined;
    const timer = setTimeout(() => {
      setAnimated(false);
      setIndex(0);
    }, 600);
    return () => clearTimeout(timer);
  }, [index]);

  return (
    <span className={styles.heroSub}>
      <span
        className={styles.heroSubTrack}
        style={{
          transform: `translateY(-${1.6 * index}em)`,
          transition: animated ? 'transform 600ms cubic-bezier(0.65, 0, 0.35, 1)' : 'none',
        }}>
        {HERO_LOOP.map((phrase, i) => (
          <span key={i} className={styles.heroSubLine}>
            {phrase}
          </span>
        ))}
      </span>
    </span>
  );
}

/* ============================================================
   HERO
   ============================================================ */
/* On phones (where the label reads "Get Started") the VPR buttons route to
   the /get-started Telegram flow instead of downloading an installer the
   device can't run. Desktop keeps the direct download. Matches the 640px
   breakpoint that swaps the label in custom.css. */
function useMobileGetStarted() {
  const history = useHistory();
  return (e: {preventDefault: () => void}) => {
    if (window.matchMedia('(max-width: 640px)').matches) {
      e.preventDefault();
      history.push('/get-started');
    }
  };
}

function DownloadCta({caption, size = 'lg'}: {caption?: string; size?: 'md' | 'lg'}) {
  const download = useLatestDesktopDownload();
  const onGetStarted = useMobileGetStarted();
  return (
    <div className={styles.ctaBlock}>
      <Button href={download.href} osIcons size={size} className="vprBtn" onClick={onGetStarted}>
        <span className="vprLabelDesktop">Download VPR</span>
        <span className="vprLabelMobile">Get Started<ArrowRight /></span>
      </Button>
      {caption && <span className={styles.ctaCaption}>{caption}</span>}
    </div>
  );
}

/* Hero stats — tokens/revenue/providers stream from Antscan's on-chain
   snapshot via useNetworkStats (fallbacks in the hook). Models is still
   hand-maintained: the model directory lives in the network DHT and has
   no public API yet. */
const HERO_MODELS_STAT = {value: '610+', label: 'Models', accent: true};

function Hero() {
  const stats = useNetworkStats();
  const heroStats: {value: string; label: string; accent?: boolean}[] = [
    {value: stats.tokens, label: 'Tokens Processed'},
    {value: stats.revenue, label: 'Network Revenue'},
    {value: stats.providers, label: 'Providers'},
    HERO_MODELS_STAT,
  ];
  const demoRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef(0);
  const shutdownRef = useRef(0);

  return (
    <header className={styles.hero}>
      <HeroDotCanvas frameRef={frameRef} shutdownRef={shutdownRef} originRef={demoRef} />
      <div className={styles.heroInner}>
        <h1 className={styles.heroTitle}>The Open Market for AI Inference</h1>
        <RotatingSub />
        <DownloadCta caption="Start for free. Keep using your tools." />
        <div className={styles.demoFrame} ref={demoRef}>
          <HeroDemo frameRef={frameRef} shutdownRef={shutdownRef} />
        </div>
        <dl className={styles.statsRow}>
          {heroStats.map((s) => (
            <div key={s.label} className={styles.stat}>
              <dd className={`${styles.statValue} ${s.accent ? styles.statAccent : ''}`}>
                <CountUp value={s.value} />
              </dd>
              <dt className={styles.statLabel}>{s.label}</dt>
            </div>
          ))}
        </dl>
      </div>
    </header>
  );
}

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

function LogoMarquee() {
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

/* ============================================================
   PRICING — the same models, a fraction of the price
   ============================================================ */
/* The pricing rows are derived live by useMarketplaceShowcase — the
   models the network sells hardest (most proven sellers on the DHT),
   matched to OpenRouter's catalog for names and official prices. Logos
   render from the same Lobehub set as the marquee, keyed by vendor. */
const VENDOR_GLYPHS = {
  ...LOBE_ICONS,
  XiaomiMiMo,
  Tencent,
  Stepfun,
  Nvidia,
  XAI,
} as unknown as Record<string, IconSize>;

/* hugeicons:checkmark (12) */
function CheckIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.25 6.93002L3.6747 8.35472C4.07982 8.75985 4.74183 8.74244 5.1251 8.31658L10 2.90002" />
    </svg>
  );
}

/* Drop-trail dots — spaced to match the dashed line asset's 8px pitch
   (dots at y=3..91), each lighting up in sequence top-to-bottom. */
const DROP_TRAIL_DOTS = Array.from({length: 11}, (_, i) => 3 + i * 8);
const DROP_TRAIL_CYCLE = 1.6;

function PricingSection() {
  const download = useLatestDesktopDownload();
  const onGetStarted = useMobileGetStarted();
  const pricingRows = useMarketplaceShowcase();
  return (
    <section className={styles.pricingSection}>
      <div className={styles.dropTrail} aria-hidden="true">
        <img src="/img/home/dots-down.svg" alt="" className={styles.dropTrailLine} />
        {DROP_TRAIL_DOTS.map((top, i) => {
          // Line asset fades in top-to-bottom (transparent at y=3, solid
          // at y=91) — each dot's peak brightness follows that same ramp.
          const peak = 0.25 + 0.75 * ((top - 3) / 88);
          return (
            <span
              key={i}
              className={styles.dropTrailDot}
              style={{
                top,
                animationDelay: `${i * (DROP_TRAIL_CYCLE / DROP_TRAIL_DOTS.length)}s`,
                ['--dot-peak' as string]: peak,
              }}
            />
          );
        })}
      </div>
      <div className={styles.sectionInner}>
        <Reveal>
          <SectionHeader
            title={
              <>
                The same models.
                <br />
                <span className={styles.titleAccent}>A fraction of the price.</span>
              </>
            }
            lead="Providers set their own prices on the open market, and that competition is what keeps pushing the cost down."
          />
        </Reveal>
        <Reveal className={styles.buttonRow} delay={60}>
          <Button href={download.href} osIcons className="vprBtn" onClick={onGetStarted}>
            <span className="vprLabelDesktop">Download VPR</span>
            <span className="vprLabelMobile">Get Started<ArrowRight /></span>
          </Button>
          <Button href="https://antseedstats.com/network" variant="ghost" arrow>See live pricing</Button>
        </Reveal>
        <Reveal className={styles.priceCard} delay={120}>
          <img className={styles.priceAnt} src="/img/home/antdots-b.png" alt="" aria-hidden="true" />
          <div className={styles.priceHead}>
            <span>Official API Price</span>
            <a
              className={styles.priceLive}
              href="https://antseedstats.com/network"
              target="_blank"
              rel="noopener noreferrer">
              <span className={styles.signalDots} aria-hidden="true"><i /><i /><i /></span>
              Live Marketplace
              <span className={styles.priceLiveArrow}><ArrowRight /></span>
            </a>
          </div>
          <div className={styles.priceRows}>
            {pricingRows.map((row) => {
              const Glyph = VENDOR_GLYPHS[row.vendorKey];
              return (
              <div key={row.model} className={styles.priceRow}>
                <span className={styles.priceLogo}>{Glyph ? <Glyph size={22} /> : null}</span>
                <span className={styles.priceModel}>
                  <strong>{row.model}</strong>
                  <em>{row.vendor}</em>
                </span>
                <span className={styles.priceOfficial}>
                  <s>{row.official}</s>
                  <em>/M tokens</em>
                </span>
                <span className={styles.priceBest}>
                  <span className={styles.priceBestTop}>
                    <strong>{row.best}</strong>
                    <i className={styles.bestBadge}><CheckIcon /> Best price</i>
                  </span>
                  <span className={styles.priceBestSub}>
                    /M tokens
                  </span>
                </span>
                <span className={styles.priceSave}>
                  <strong>{row.save}</strong>
                  <em>Save</em>
                </span>
              </div>
              );
            })}
          </div>
        </Reveal>
        <Reveal className={styles.payNote} delay={160}>
          <img src="/img/home/icon-shield-sm.svg" alt="" width="24" height="24" />
          You only pay for what you use. Settlement is direct, secure, and non-custodial.
        </Reveal>
      </div>
    </section>
  );
}

/* ============================================================
   PRIVATE BY DESIGN
   ============================================================ */
function PrivateByDesign() {
  return (
    <section className={styles.privacyWrap}>
      <div className={styles.privacyPanel}>
        <img className={styles.privacyDotsLeft} src="/img/home/antdots-w.png" alt="" aria-hidden="true" />
        <img className={styles.privacyDotsRight} src="/img/home/antdots-w.png" alt="" aria-hidden="true" />
        <Reveal>
          <h2 className={styles.privacyGhostTitle}>Private by design</h2>
        </Reveal>
        <div className={styles.privacyGrid}>
          <Reveal className={styles.privacyCardDark}>
            <img className={styles.privacySpy} src="/img/home/spy-dots.png" alt="" aria-hidden="true" />
            <div className={styles.privacyCopy}>
              <h3>Anonymous</h3>
              <p>No account, no email, like using AI with VPN.</p>
              <Link to="/blog/trust-without-a-middleman" className={styles.privacyMore}>
                Learn more
                <ArrowRight size={16} />
              </Link>
            </div>
          </Reveal>
          <Reveal className={styles.privacyCardGreen} delay={110}>
            <img className={styles.privacyShield} src="/img/home/shield-dots.png" alt="" aria-hidden="true" />
            <div className={styles.privacyCopyGreen}>
              <h3>Private</h3>
              <p>
                Choose a TEE-verified provider for extra privacy, your request runs end-to-end
                encrypted inside a sealed hardware enclave, so not even the provider can see your
                prompt.
              </p>
              <Link to="/blog/dont-trust-the-tee-label" className={styles.privacyMore}>
                Learn more
                <ArrowRight size={16} />
              </Link>
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  );
}

/* ============================================================
   OWNED BY NO ONE — decentralization cards
   ============================================================ */
const OWNED_CARDS = [
  {
    title: 'Open Source and On‑Chain',
    body: 'The Protocol, VPR, Verifications, Network Data and Payments',
    illo: <img src="/img/home/illo-best-prices.svg" alt="" aria-hidden="true" />,
    link: {href: 'https://github.com/AntSeed/antseed', label: 'View on GitHub'},
  },
  {
    title: 'Private by design',
    body: 'No account, no email, nothing tying your requests back to you. Choose TEE verified providers for hardware level privacy.',
    illo: <img src="/img/home/illo-private-by-design.svg" alt="" aria-hidden="true" />,
  },
  {
    title: 'Distributed and always on',
    body: "The routing layer that can't go down, can't lock your account, and can't read your prompts.",
    illo: <img src="/img/home/illo-distributed-always-on.svg" alt="" aria-hidden="true" />,
  },
];

function OwnedByNoOne() {
  return (
    <section className={styles.section}>
      <div className={styles.sectionInner}>
        <Reveal>
          <SectionHeader
            title={
              <>
                Owned by no one.
                <br />
                <span className={styles.titleAccent}>Available to everyone.</span>
              </>
            }
            lead="AntSeed is a decentralized peer to peer network. It moves AI requests the way BitTorrent moves files. There is no central server, no company in the middle."
          />
        </Reveal>
        <Reveal className={styles.buttonRow} delay={60}>
          <Button to="/docs" variant="ghost" arrow>Read Docs</Button>
        </Reveal>
        <div className={styles.cardGrid3}>
          {OWNED_CARDS.map((card, i) => (
            <Reveal key={card.title} className={styles.featureCard} delay={i * 100}>
              <div className={styles.featureIlloWell}>{card.illo}</div>
              <div className={styles.featureDivider} />
              <div className={styles.featureCopy}>
                <h3>{card.title}</h3>
                <p>{card.body}</p>
                {card.link && (
                  <a
                    href={card.link.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={styles.featureLinkArrow}
                  >
                    {card.link.label}
                    <ArrowRight />
                  </a>
                )}
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ============================================================
   RUNS ON YOUR COMPUTER
   ============================================================ */
const RUNS_CARDS = [
  {
    title: 'Easy setup.',
    body: 'Download, run, done. No config, no migration.',
    illo: <img src="/img/home/illo-easy-setup.svg" alt="" aria-hidden="true" />,
  },
  {
    title: 'Your tools, unchanged.',
    body: 'Point to your own agents and AI apps at one local address.',
    illo: <img src="/img/home/illo-tools-unchanged.svg" alt="" aria-hidden="true" />,
  },
  {
    title: 'Pay how you want.',
    body: 'Top up by card or crypto, whichever you prefer.',
    illo: <img src="/img/home/illo-pay-how-you-want.svg" alt="" aria-hidden="true" />,
  },
];

function RunsOnYourComputer() {
  return (
    <section className={`${styles.section} ${styles.sectionTinted}`}>
      <div className={styles.sectionInner}>
        <Reveal>
          <h2 className={styles.runsTitle}>
            Runs on your computer.
            <br />
            Works with every tool you use.
          </h2>
          <p className={styles.runsLead}>
            The Virtual Private Router is self-hosted software that connects your favorite AI tools
            to any model on the AntSeed network. No limits, no lock-in.
          </p>
        </Reveal>
        <div className={styles.cardGrid3}>
          {RUNS_CARDS.map((card, i) => (
            <Reveal key={card.title} className={styles.runsCard} delay={i * 100}>
              <div className={styles.runsIlloWell}>{card.illo}</div>
              <div className={styles.featureCopy}>
                <h3>{card.title}</h3>
                <p>{card.body}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ============================================================
   POINT YOUR TOOLS AT LOCALHOST — dark terminal section
   ============================================================ */
const LOCALHOST_POINTS = [
  {icon: 'pt-tools', text: 'Keep your tools. Swap the providers underneath.'},
  {icon: 'pt-shield', text: 'Fallback the moment a provider is slow, expensive, or down.'},
  {icon: 'pt-route', text: 'Route by price, speed, reputation, or privacy.'},
  {icon: 'pt-wallet', text: 'Pay per request, straight to the provider. No subscription.'},
];

type TToken = {text: string; cls?: keyof typeof styles};

type TBlock = {comment: string; tokens: TToken[]};

const TERMINAL_BLOCKS: TBlock[] = [
  {
    comment: '# Route Claude Code through AntSeed',
    tokens: [
      {text: '$ ', cls: 'tGreen'},
      {text: 'antseed', cls: 'tPurple'},
      {text: ' '},
      {text: 'claude', cls: 'tBlue'},
    ],
  },
  {
    comment: '# Codex pinned to the best provider',
    tokens: [
      {text: '$ ', cls: 'tGreen'},
      {text: 'antseed', cls: 'tPurple'},
      {text: ' '},
      {text: 'codex', cls: 'tBlue'},
      {text: ' '},
      {text: '--model', cls: 'tYellow'},
      {text: ' '},
      {text: 'deepseek-v3', cls: 'tOrange'},
    ],
  },
  {
    comment: '# Or call any compatible client',
    tokens: [
      {text: '$ ', cls: 'tGreen'},
      {text: 'curl', cls: 'tPurple'},
      {text: ' '},
      {text: '-X', cls: 'tYellow'},
      {text: ' '},
      {text: 'POST', cls: 'tBlue'},
      {text: ' '},
      {text: 'http://localhost:8377/v1/chat/completions', cls: 'tBlue'},
      {text: ' \\\n  '},
      {text: '-H', cls: 'tYellow'},
      {text: ' '},
      {text: '"Content-Type: application/json"', cls: 'tGreen'},
      {text: ' \\\n  '},
      {text: '-d', cls: 'tYellow'},
      {text: " '{"},
      {text: '"model"', cls: 'tBlue'},
      {text: ': '},
      {text: '"deepseek-v3"', cls: 'tOrange'},
      {text: ',\n    '},
      {text: '"messages"', cls: 'tBlue'},
      {text: ': [{'},
      {text: '"role"', cls: 'tBlue'},
      {text: ': '},
      {text: '"user"', cls: 'tGreen'},
      {text: ','},
      {text: '"content"', cls: 'tBlue'},
      {text: ': '},
      {text: '"hi"', cls: 'tGreen'},
      {text: "}]}'"},
    ],
  },
];

/** Random per-character delay — fast, with the odd human-like hesitation. */
function keystrokeDelay(ch: string) {
  if (ch === '\n') return 100;
  if (ch === ' ') return 10 + Math.random() * 10;
  const jitter = Math.random();
  if (jitter > 0.94) return 35 + Math.random() * 50; // rare pause
  return 5 + Math.random() * 10;
}

function Cursor({style}: {style?: CSSProperties} = {}) {
  return <span className={styles.tCursor} style={style} aria-hidden="true" />;
}

/**
 * Renders every token in full so the block's box never resizes as it types —
 * characters not yet "typed" are kept in the layout via visibility:hidden.
 */
function renderTokens(tokens: TToken[], typed: number, cursor: ReactNode) {
  const nodes: ReactNode[] = [];
  let remaining = typed;
  let cursorPlaced = false;
  for (let i = 0; i < tokens.length; i++) {
    const {text, cls} = tokens[i];
    const visibleLen = Math.max(0, Math.min(text.length, remaining));
    const visible = text.slice(0, visibleLen);
    const hidden = text.slice(visibleLen);
    const placeCursorHere = !cursorPlaced && visibleLen < text.length;
    if (placeCursorHere) cursorPlaced = true;
    nodes.push(
      <span key={i} className={cls ? styles[cls] : undefined}>
        {visible}
        {placeCursorHere && cursor}
        {hidden && <span style={{visibility: 'hidden'}}>{hidden}</span>}
      </span>
    );
    remaining -= text.length;
  }
  if (!cursorPlaced) nodes.push(cursor);
  return nodes;
}

function TerminalCard() {
  const ref = useRef<HTMLDivElement>(null);
  const [blockIndex, setBlockIndex] = useState(0);
  const [phase, setPhase] = useState<'comment' | 'command' | 'done'>('comment');
  const [typed, setTyped] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced || typeof IntersectionObserver === 'undefined') {
      setBlockIndex(TERMINAL_BLOCKS.length - 1);
      setPhase('done');
      setTyped(TERMINAL_BLOCKS[TERMINAL_BLOCKS.length - 1].tokens.reduce((n, t) => n + t.text.length, 0));
      return undefined;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    async function sleep(ms: number) {
      return new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      });
    }

    async function typeOut(length: number, onTick: (n: number) => void, text: (i: number) => string) {
      for (let i = 1; i <= length; i++) {
        if (cancelled) return;
        await sleep(keystrokeDelay(text(i - 1)));
        if (cancelled) return;
        onTick(i);
      }
    }

    async function run() {
      for (let b = 0; b < TERMINAL_BLOCKS.length; b++) {
        if (cancelled) return;
        setBlockIndex(b);
        setPhase('comment');
        setTyped(0);
        const {comment, tokens} = TERMINAL_BLOCKS[b];
        await typeOut(comment.length, setTyped, (i) => comment[i]);
        if (cancelled) return;
        await sleep(60);
        setPhase('command');
        setTyped(0);
        const commandText = tokens.map((t) => t.text).join('');
        await typeOut(commandText.length, setTyped, (i) => commandText[i]);
        if (cancelled) return;
        await sleep(150);
      }
      if (!cancelled) setPhase('done');
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          observer.disconnect();
          run();
        }
      },
      {threshold: 0.35}
    );
    observer.observe(el);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      observer.disconnect();
    };
  }, []);

  return (
    <div className={styles.terminal} ref={ref}>
      <div className={styles.terminalBar}>
        <span className={styles.tDots}>
          <i style={{background: '#EF4444'}} />
          <i style={{background: '#F59E0B'}} />
          <i style={{background: '#676663'}} />
        </span>
        <span className={styles.terminalStatus}>
          <span className={styles.statusDot} aria-hidden="true" />
          Connected Localhost:8377
        </span>
        <span className={styles.terminalTagline}>ONE ENDPOINT · EVERY TOOL</span>
      </div>
      {TERMINAL_BLOCKS.map((block, i) => {
        const commandLen = block.tokens.reduce((n, t) => n + t.text.length, 0);
        const isCurrent = i === blockIndex && phase !== 'done';
        const commentDone = i < blockIndex || phase === 'done' || (i === blockIndex && phase === 'command');
        const commandDone = i < blockIndex || phase === 'done';
        const commentTyped = commentDone ? block.comment.length : isCurrent && phase === 'comment' ? typed : 0;
        const commandTyped = commandDone ? commandLen : isCurrent && phase === 'command' ? typed : 0;
        const showCommentCursor = isCurrent && phase === 'comment';
        const showCommandCursor = isCurrent && phase === 'command';
        const commentHidden = block.comment.slice(commentTyped);
        return (
          <div className={styles.terminalBlock} key={i}>
            <span className={styles.tComment}>
              {block.comment.slice(0, commentTyped)}
              {showCommentCursor && <Cursor />}
              {commentHidden && <span style={{visibility: 'hidden'}}>{commentHidden}</span>}
            </span>
            <span>
              {renderTokens(block.tokens, commandTyped, showCommandCursor ? <Cursor /> : null)}
            </span>
          </div>
        );
      })}
      <Cursor
        style={{visibility: phase === 'done' && blockIndex === TERMINAL_BLOCKS.length - 1 ? 'visible' : 'hidden'}}
      />
    </div>
  );
}

const FLOW_CHIPS = [
  {icon: 'flow-flash', label: 'REQUEST'},
  {icon: 'flow-internet', label: 'ANTSEED NETWORK'},
  {icon: 'flow-user', label: 'BEST PROVIDER'},
  {icon: 'flow-check', label: 'RESPONSE'},
];

function FlowChips() {
  return (
    <div className={styles.flowRow}>
      <span className={styles.flowLine} aria-hidden="true" />
      {FLOW_CHIPS.map((chip) => (
        <span key={chip.label} className={styles.flowChip}>
          <img src={`/img/home/${chip.icon}.svg`} alt="" width="20" height="20" />
          {chip.label}
        </span>
      ))}
    </div>
  );
}

function LocalhostSection() {
  return (
    <section className={styles.darkSection}>
      <img className={styles.darkAnt} src="/img/home/antdots-green.png" alt="" aria-hidden="true" />
      <div className={styles.sectionInner}>
        <div className={styles.localhostGrid}>
          <Reveal className={styles.localhostCopy}>
            <h2 className={styles.darkTitle}>Point your tools<br />at localhost.</h2>
            <p className={styles.darkLead}>
              AntSeed exposes OpenAI and Anthropic compatible APIs at{' '}
              <code className={styles.inlineCode}>localhost:8377</code>, then routes each request
              across the open provider market by price, latency, reputation, capability, or privacy.
              The router runs on your computer, not on a hosted service, so your requests never pass
              through anyone else&apos;s servers.
            </p>
            <ul className={styles.pointList}>
              {LOCALHOST_POINTS.map((p) => (
                <li key={p.icon}>
                  <span className={styles.pointIcon}>
                    <img src={`/img/home/${p.icon}.svg`} alt="" width="24" height="24" />
                  </span>
                  {p.text}
                </li>
              ))}
            </ul>
            <Button to="/integrations" variant="light" arrow>Explore integrations</Button>
          </Reveal>
          <Reveal delay={140}>
            <TerminalCard />
            <FlowChips />
          </Reveal>
        </div>
      </div>
    </section>
  );
}

/* ============================================================
   3 STEPS
   ============================================================ */
/* The provider count streams from Antscan via useNetworkStats, same source as
   the hero stat, so step 2 tracks the network instead of drifting. */
const buildSteps = (providers: string) => [
  {
    num: '1',
    title: 'Pick your model',
    body: "Top tier names, fresh releases, and unique models you won't find anywhere else, all routed on the AntSeed P2P network.",
  },
  {
    num: '2',
    title: 'Set your route',
    body: `${providers} independent providers, routed automatically by reputation and price, so you can pick the one that works for you.`,
  },
  {
    num: '3',
    title: 'Keep your favorite app',
    body: "Point any tool you already use at one local address. Same projects, same chats, same context you've built up.",
  },
];

function StepsSection() {
  const stats = useNetworkStats();
  const steps = buildSteps(stats.providers);
  return (
    <section className={styles.stepsSection}>
      <div className={styles.sectionInner}>
        <Reveal>
          <h2 className={styles.stepsTitle}>
            You&apos;re <span className={styles.titleAccent}>3 steps</span> from the open market.
          </h2>
        </Reveal>
        <div className={styles.stepsGrid}>
          {steps.map((step, i) => (
            <Reveal key={step.num} className={styles.stepCard} delay={i * 100}>
              <div className={styles.stepHead}>
                <span className={styles.stepNum}>{step.num}</span>
                <h3>{step.title}</h3>
              </div>
              <p>{step.body}</p>
            </Reveal>
          ))}
        </div>
        <Reveal className={styles.stepsCta} delay={140}>
          <DownloadCta size="md" />
        </Reveal>
      </div>
    </section>
  );
}

/* ============================================================
   ANYONE CAN SELL INTELLIGENCE
   ============================================================ */
const SELLABLES = [
  'OpenSource models running on GPU',
  'API capacity',
  'A router you developed',
  'A specialised inference',
];

function SellSection() {
  const stats = useNetworkStats();
  return (
    <section className={styles.sellSection}>
      <div className={styles.sectionInner}>
        <div className={styles.sellCardWrap}>
        <img className={styles.sellAntMobile} src="/img/home/ant-v-dots.png" alt="" aria-hidden="true" />
        <Reveal className={styles.sellCard}>
          <div className={styles.sellGrid}>
            <div className={styles.sellCopy}>
              <h2 className={styles.sellTitle}>Anyone can<br />sell intelligence.</h2>
              <p className={styles.sellLead}>
                Setup takes minutes. No application, no approval queue. Serve a request, get paid,
                automatically, every time.
              </p>
              <p className={styles.sellListTitle}>You can sell:</p>
              <ul className={styles.sellList}>
                {SELLABLES.map((item) => (
                  <li key={item}>
                    <img className={styles.sellLine} src="/img/home/greendots.svg" alt="" aria-hidden="true" />
                    {item}
                  </li>
                ))}
              </ul>
              <div className={styles.buttonRowLeft}>
                <Button to="/providers" className={styles.sellDarkBtn}>Become a provider</Button>
                <Button to="/docs/guides/become-a-provider" variant="ghost" arrow className={styles.sellGhostBtn}>
                  Read the provider guide
                </Button>
              </div>
            </div>
            <div className={styles.earningsCol}>
              <div className={styles.earningsHead}>
                <span>Live provider earnings</span>
                <span className={styles.liveTag}>
                  <span className={styles.signalDots} aria-hidden="true"><i /><i /><i /></span>
                  Live
                </span>
              </div>
              <div className={styles.earningsBig}>
                <strong><CountUp value={stats.revenueShort} duration={1400} /></strong>
                <span>Settled to providers on the network</span>
              </div>
              <div className={styles.earningsSmallRow}>
                <div className={styles.earningsSmall}>
                  <strong><CountUp value={stats.providersCount} /></strong>
                  <span>Sellers earning</span>
                </div>
                <div className={styles.earningsSmall}>
                  <strong><CountUp value={stats.settlementsPerEpoch} /></strong>
                  <span>Settlements · epoch</span>
                </div>
              </div>
              <p className={styles.earningsNote}>
                Live figure pulled from{' '}
                <a href="https://antscan.co" target="_blank" rel="noopener noreferrer">
                  antscan.co
                </a>
              </p>
            </div>
          </div>
        </Reveal>
        </div>
      </div>
    </section>
  );
}

/* ============================================================
   FAQ — fair questions
   ============================================================ */
const FAQ_DATA = [
  {
    q: 'How is this different from OpenRouter?',
    a: "OpenRouter is a centralized aggregator: it decides which models are listed, routes every request through its own servers, and holds provider payouts until withdrawal. AntSeed removes the aggregator from routing. Requests go peer-to-peer, payments settle on-chain directly to the provider's wallet, and anyone can provide - no approval needed. <a href=\"/vs/openrouter\">Read the full comparison →</a>",
  },
  {
    q: 'What happens when LLMs become so good that anyone can do anything?',
    a: 'That is exactly what we want. When LLMs become dramatically more capable, costs collapse and more people can run their own capable LLMs on their own hardware. Those people become AntSeed providers - the supply side grows, not shrinks. But "anyone can do anything" does not mean everyone delivers the same result. The value is in what you build on top: the skills, the workflows, the domain expertise, the agent orchestration. A more capable base model raises the ceiling for every provider.',
  },
  {
    q: "Isn't this just like P2P file sharing? Netflix killed that.",
    a: "Netflix and Spotify won because humans are happy to pay a simple subscription for a clean UI. That logic only applies to humans who care about experience. Agents don't - in a world of agents, UI is not a moat. An agent has no preference for a polished interface, no reason to care about a brand, no inertia keeping it on a familiar platform. It just needs the service, the price, and the reliability - and on those axes, an open P2P network with no middleman and no markup wins every time.",
  },
  {
    q: 'Is AntSeed built for agents specifically?',
    a: 'It works for humans today and is being used by humans now. But the architecture decisions - USDC-native payments, no account system, open discovery, always-on peers - are all decisions that make the network ideal for agents. A human tolerates signing up, waiting for API keys, and managing a subscription. An agent cannot. The network AntSeed is building is the one autonomous agents will naturally discover and use.',
  },
  {
    q: 'Why would a provider use AntSeed instead of just building their own API?',
    a: 'Because distribution is the hard part. On AntSeed a provider plugs into existing demand - buyers, discovery, reputation, and on-chain settlement come with the network. No billing stack to build, no customers to acquire, no payment risk to carry. Serve a request, get paid, automatically.',
  },
];

function FAQSection() {
  return (
    <section className={`${styles.section} ${styles.sectionTinted}`}>
      <div className={styles.sectionInner}>
        <Reveal>
          <h2 className={styles.faqTitle}>Fair questions.</h2>
        </Reveal>
        <Reveal delay={90}>
          <Faq items={FAQ_DATA} />
        </Reveal>
      </div>
    </section>
  );
}

/* ============================================================
   FINAL CTA
   ============================================================ */
function FinalCta() {
  return (
    <section className={styles.finalCta}>
      <Reveal className={styles.finalCtaInner}>
        <h2 className={styles.finalTitle}>Your AI should work for you</h2>
        <p className={styles.finalSub}>Every Model, No Middleman. Anonymous and Always On.</p>
        <div className={styles.ctaBlock}>
          <FinalCtaButton />
          <span className={styles.ctaCaptionLight}>No account needed. Just start.</span>
        </div>
      </Reveal>
    </section>
  );
}

function FinalCtaButton() {
  const download = useLatestDesktopDownload();
  const onGetStarted = useMobileGetStarted();
  return (
    <Button href={download.href} variant="white" size="lg" osIcons className="vprBtn" onClick={onGetStarted}>
      <span className="vprLabelDesktop">Download VPR</span>
      <span className="vprLabelMobile">Get Started<ArrowRight /></span>
    </Button>
  );
}

/* ============================================================
   PAGE
   ============================================================ */
export default function Home(): JSX.Element {
  const {siteConfig} = useDocusaurusContext();

  const faqLd = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: FAQ_DATA.map(({q, a}) => ({
      '@type': 'Question',
      name: q,
      acceptedAnswer: {
        '@type': 'Answer',
        text: a.replace(/<[^>]*>/g, '').trim(),
      },
    })),
  };

  // Standalone Organization entity. The SoftwareApplication block in
  // docusaurus.config.ts references the org as `creator`; this declares it in
  // its own right so the brand resolves as an entity.
  const orgLd = {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: 'AntSeed',
    url: 'https://antseed.com/',
    logo: 'https://antseed.com/logo.svg',
    description:
      'AntSeed is a decentralized peer-to-peer marketplace for AI inference. Providers compete on price to run any AI model, with no central account.',
    sameAs: [
      'https://github.com/AntSeed/antseed',
      'https://x.com/antseedai',
      'https://t.me/antseed',
    ],
  };

  return (
    <Layout
      title={siteConfig.tagline}
      description="The open market for AI inference. Every model, no middleman. Anonymous, best price, works with the tools you already use. Owned by no one."
      wrapperClassName="homepage-wrapper">
      <Head>
        {/*
          Docusaurus derives og:title / og:description from the Layout title and
          description props above, which override the sitewide values in
          themeConfig.metadata. Declaring them here — after Layout's own tags —
          is what makes the share card copy actually take effect. X falls back
          to these when twitter:title / twitter:description are absent, which is
          why those are not declared anywhere.

          rel=canonical and og:url need no declaration — Docusaurus already
          emits correct per-page values for both.
        */}
        <meta property="og:title" content="Every AI model, best price, no middleman" />
        <meta
          property="og:description"
          content="AntSeed is the open market for AI inference. Every model, no middleman. Anonymous. Best price. Works with the tools you already use. Owned by no one. Available to everyone."
        />
        <script type="application/ld+json">{JSON.stringify(orgLd)}</script>
        <script type="application/ld+json">{JSON.stringify(faqLd)}</script>
      </Head>

      <Hero />
      <LogoMarquee />
      <PricingSection />
      <PrivateByDesign />
      <OwnedByNoOne />
      <RunsOnYourComputer />
      <LocalhostSection />
      <div className={styles.stepsSellWrap}>
        <img className={styles.stepsAnt} src="/img/home/ant-v-dots.png" alt="" aria-hidden="true" />
        <StepsSection />
        <SellSection />
      </div>
      <FAQSection />
      <FinalCta />
    </Layout>
  );
}
