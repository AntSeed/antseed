import {useEffect, useRef, useState, type MutableRefObject, type RefObject} from 'react';
import Head from '@docusaurus/Head';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import Layout from '@theme/Layout';
import styles from './index.module.css';
import {useLatestDesktopDownload} from '../lib/useLatestDesktopDownload';
import {Button, Faq, Reveal, SectionHeader, ArrowRight} from '../components/ui';
import {HeroDemo, DEMO_BEATS, DEMO_TOTAL_FRAMES} from '../components/HeroDemo';

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
const SAMPLE_OFFSETS = [-4, 0, 4];

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
}

function HeroDotCanvas({
  frameRef,
  originRef,
}: {
  frameRef: MutableRefObject<number>;
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
      for (let y = 0; y <= height + 9; y += 9) {
        for (let x = 0; x <= width + 9; x += 9) {
          const dist = Math.hypot(x - originX, y - originY);
          const coverage = antAlpha ? antCoverage(x - antLeft, y - antTop, antAlpha) : 0;
          const isAnt = coverage > 0;
          const sizeFactor = isAnt ? (0.4 + 0.6 * coverage) * (0.85 + 0.3 * Math.random()) : 1;
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

    const drawFrame = (frame: number) => {
      ctx.clearRect(0, 0, width, height);
      for (const dot of dots) {
        const alpha = dot.isAnt
          ? antAlphaAt(frame, dot.appearAt, dot.dissolveAt)
          : rippleAlphaAt(frame - dot.arrival);
        if (alpha <= 0.01) continue;
        const radius = 2.6 * dot.sizeFactor * (0.5 + 0.5 * alpha);
        ctx.beginPath();
        ctx.fillStyle = `rgba(${color},${0.75 * alpha})`;
        ctx.arc(dot.x, dot.y, radius, 0, 2 * Math.PI);
        ctx.fill();
      }
    };

    const drawStatic = () => {
      ctx.clearRect(0, 0, width, height);
      for (const dot of dots) {
        ctx.beginPath();
        ctx.fillStyle = `rgba(${color},${dot.isAnt ? 0.4 : 0.16})`;
        ctx.arc(dot.x, dot.y, 2.6 * dot.sizeFactor, 0, 2 * Math.PI);
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
      drawFrame(frameRef.current % DEMO_TOTAL_FRAMES);
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
  }, [frameRef, originRef]);

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
function DownloadCta({caption, size = 'lg'}: {caption?: string; size?: 'md' | 'lg'}) {
  const download = useLatestDesktopDownload();
  return (
    <div className={styles.ctaBlock}>
      <Button href={download.href} osIcons size={size}>Download VPR</Button>
      {caption && <span className={styles.ctaCaption}>{caption}</span>}
    </div>
  );
}

const HERO_STATS: {value: string; label: string; accent?: boolean}[] = [
  {value: '82B+', label: 'Tokens Processed'},
  {value: '$143K+', label: 'Network Revenue'},
  {value: '158+', label: 'Providers'},
  {value: '610+', label: 'Models', accent: true},
];

function Hero() {
  const demoRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef(0);

  return (
    <header className={styles.hero}>
      <HeroDotCanvas frameRef={frameRef} originRef={demoRef} />
      <div className={styles.heroInner}>
        <h1 className={styles.heroTitle}>The Open Market for AI Inference</h1>
        <RotatingSub />
        <DownloadCta caption="Start for free. Keep using your tools." />
        <div className={styles.demoFrame} ref={demoRef}>
          <HeroDemo frameRef={frameRef} />
        </div>
        <dl className={styles.statsRow}>
          {HERO_STATS.map((s) => (
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
const MARQUEE_LOCKUPS: [string, string][] = [
  ['anthropic.svg', 'Anthropic'],
  ['cohere.svg', 'Cohere'],
  ['deepseek.svg', 'DeepSeek'],
  ['gemini.svg', 'Gemini'],
  ['grok.svg', 'Grok'],
  ['meta.svg', 'Meta AI'],
  ['mistral.svg', 'Mistral AI'],
  ['qwen.svg', 'Qwen'],
  ['openai.svg', 'OpenAI'],
];

function LogoMarquee() {
  const run = MARQUEE_LOCKUPS.map(([file, name]) => (
    <span className={styles.marqueeItem} key={name}>
      <img src={`/logos/lockups/${file}`} alt={name} loading="lazy" />
    </span>
  ));
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
const PRICING_ROWS = [
  {logo: 'logo-anthropic.svg', model: 'Claude Opus 4.8', vendor: 'by Anthropic', official: '$5.00', best: '$0.88', provider: 'Open Bird', save: '82%'},
  {logo: 'logo-openai.svg', model: 'GPT-5.5', vendor: 'by OpenAI', official: '$5.00', best: '$0.73', provider: 'GPU-Garden', save: '85%'},
  {logo: 'logo-google.svg', model: 'Gemini 3.5 Flash', vendor: 'by Google', official: '$0.30', best: '$0.08', provider: 'Apex Ant', save: '73%'},
  {logo: 'logo-anthropic.svg', model: 'Claude Sonnet 5', vendor: 'by Anthropic', official: '$3.00', best: '$0.42', provider: 'Dark Signal', save: '86%'},
];

/* hugeicons:checkmark (12) */
function CheckIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.25 6.93002L3.6747 8.35472C4.07982 8.75985 4.74183 8.74244 5.1251 8.31658L10 2.90002" />
    </svg>
  );
}

/* hugeicons:user-02 (16) */
function PersonIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8.00004 7.33333C9.4728 7.33333 10.6667 6.13943 10.6667 4.66667C10.6667 3.19391 9.4728 2 8.00004 2C6.52728 2 5.33337 3.19391 5.33337 4.66667C5.33337 6.13943 6.52728 7.33333 8.00004 7.33333Z" />
      <path d="M8.00002 9.33337C4.66669 9.33337 2.66669 11 2.66669 12.6667C2.66669 13.0203 2.80716 13.3595 3.05721 13.6095C3.30726 13.8596 3.6464 14 4.00002 14H12C12.3536 14 12.6928 13.8596 12.9428 13.6095C13.1929 13.3595 13.3334 13.0203 13.3334 12.6667C13.3334 11 11.3334 9.33337 8.00002 9.33337Z" />
    </svg>
  );
}

function PricingSection() {
  const download = useLatestDesktopDownload();
  return (
    <section className={styles.pricingSection}>
      <div className={styles.dropTrail} aria-hidden="true" />
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
            lead="Providers set their own prices on the open market, and you always see the cost before a request is sent."
          />
        </Reveal>
        <Reveal className={styles.buttonRow} delay={60}>
          <Button href={download.href} osIcons>Download VPR</Button>
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
            {PRICING_ROWS.map((row) => (
              <div key={row.model} className={styles.priceRow}>
                <span className={styles.priceLogo}><img src={`/img/home/${row.logo}`} alt="" loading="lazy" /></span>
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
                    <span className={styles.providerChip}><PersonIcon /> {row.provider}</span>
                  </span>
                </span>
                <span className={styles.priceSave}>
                  <strong>{row.save}</strong>
                  <em>Save</em>
                </span>
              </div>
            ))}
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
        <img className={styles.privacyDotsLeft} src="/img/home/antdots-b.png" alt="" aria-hidden="true" />
        <img className={styles.privacyDotsRight} src="/img/home/antdots-b.png" alt="" aria-hidden="true" />
        <Reveal>
          <h2 className={styles.privacyGhostTitle}>Private by design</h2>
        </Reveal>
        <div className={styles.privacyGrid}>
          <Reveal className={styles.privacyCardDark}>
            <img className={styles.privacySpy} src="/img/home/spy-dots.png" alt="" aria-hidden="true" />
            <div className={styles.privacyCopy}>
              <h3>Anonymous</h3>
              <p>No account, no email, like using AI with VPN.</p>
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
function SellersIllo() {
  return (
    <div className={styles.sellersIllo} aria-hidden="true">
      <img className={styles.sellers1} src="/img/home/sellers-1.png" alt="" />
      <img className={styles.sellers3} src="/img/home/sellers-3.png" alt="" />
      <img className={styles.sellers0} src="/img/home/sellers-0.png" alt="" />
      <img className={styles.sellers2} src="/img/home/sellers-2.png" alt="" />
    </div>
  );
}

const OWNED_CARDS = [
  {
    title: 'Best prices',
    body: 'Set by open market competition between providers, not a rate one company decided to charge.',
    illo: <SellersIllo />,
  },
  {
    title: 'Private by design',
    body: 'No account, no email, nothing tying your requests back to you. Choose TEE verified providers for hardware level privacy.',
    illo: <img className={styles.peerFlowIllo} src="/img/home/peer-flow.svg" alt="" aria-hidden="true" />,
  },
  {
    title: 'Distributed and always on',
    body: "The routing layer that can't go down, can't lock your account, and can't read your prompts.",
    illo: (
      <div className={styles.powerIllo} aria-hidden="true">
        <img className={styles.isoRings} src="/img/home/iso-rings.svg" alt="" />
        <img className={styles.powerBtn} src="/img/home/power-button.svg" alt="" />
      </div>
    ),
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
function EasySetupIllo() {
  return (
    <div className={styles.illoWell} aria-hidden="true">
      <div className={styles.setupMenuBar}>
        <img src="/img/home/menubar-icons.svg" alt="" height="30" />
      </div>
      <div className={styles.setupWindow}>
        <img src="/img/home/vpr-on.png" alt="" />
      </div>
      <img className={styles.setupAntBadge} src="/img/home/ant-badge.svg" alt="" />
    </div>
  );
}

function ToolsRouteIllo() {
  return (
    <div className={styles.illoWell} aria-hidden="true">
      <svg className={styles.routeArcs} viewBox="0 0 317 200" fill="none">
        <path d="M68 46 C 100 46, 100 99, 132 99" stroke="#A4A5A4" strokeWidth="1.5" />
        <path d="M68 99 H 132" stroke="#A4A5A4" strokeWidth="1.5" />
        <path d="M68 153 C 100 153, 100 99, 132 99" stroke="#A4A5A4" strokeWidth="1.5" />
        <defs>
          <linearGradient id="routeFade" x1="244" y1="99" x2="318" y2="99" gradientUnits="userSpaceOnUse">
            <stop stopColor="#10B981" />
            <stop offset="1" stopColor="#10B981" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d="M244 99 H 318" stroke="url(#routeFade)" strokeWidth="4" strokeDasharray="4 6" strokeLinecap="round" />
      </svg>
      <div className={styles.routeTools}>
        <img src="/img/home/tool-opencode.svg" alt="" />
        <img src="/img/home/tool-codex.svg" alt="" />
        <img src="/img/home/tool-custom.svg" alt="" />
      </div>
      <span className={styles.routePill}>Localhost:8377</span>
    </div>
  );
}

function PaymentsIllo() {
  return (
    <div className={`${styles.illoWell} ${styles.payWell}`} aria-hidden="true">
      <div className={styles.payRow}>
        <img src="/img/home/pay-visa.svg" alt="Visa" />
        <img src="/img/home/pay-mastercard.svg" alt="Mastercard" />
        <img src="/img/home/pay-applepay.svg" alt="Apple Pay" />
        <span className={styles.paySep} />
        <img src="/img/home/pay-metamask.svg" alt="MetaMask" />
        <img src="/img/home/pay-walletconnect.svg" alt="WalletConnect" />
      </div>
    </div>
  );
}

const RUNS_CARDS = [
  {
    title: 'Easy setup.',
    body: 'Download, run, done. No config, no migration.',
    illo: <EasySetupIllo />,
  },
  {
    title: 'Your tools, unchanged.',
    body: 'Point to your own agents and AI apps at one local address.',
    illo: <ToolsRouteIllo />,
  },
  {
    title: 'Pay how you want.',
    body: 'Top up by card or crypto, whichever you prefer.',
    illo: <PaymentsIllo />,
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
              {card.illo}
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

function TerminalCard() {
  return (
    <div className={styles.terminal}>
      <div className={styles.terminalBar}>
        <span className={styles.tDots}>
          <i style={{background: '#EF4444'}} />
          <i style={{background: '#F59E0B'}} />
          <i style={{background: '#676663'}} />
        </span>
        <span className={styles.terminalStatus}>● Connected Localhost:8377</span>
        <span className={styles.terminalTagline}>ONE ENDPOINT · EVERY TOOL</span>
      </div>
      <div className={styles.terminalBlock}>
        <span className={styles.tComment}># Route Claude Code through AntSeed</span>
        <span className={styles.tWhite}>$ antseed claude</span>
      </div>
      <div className={styles.terminalBlock}>
        <span className={styles.tComment}># Codex pinned to the best provider</span>
        <span className={styles.tGreen}>$ antseed codex --model deepseek-v3</span>
      </div>
      <div className={styles.terminalBlock}>
        <span className={styles.tComment}># Or call any compatible client</span>
        <span className={styles.tGreen}>
          $ curl -X POST http://localhost:8377/v1/chat/completions \{'\n'}
          {'  '}-H &quot;Content-Type: application/json&quot; \{'\n'}
          {'  '}-d &apos;{'{'}&quot;model&quot;: &quot;deepseek-v3&quot;,{'\n'}
          {'    '}&quot;messages&quot;: [{'{'}&quot;role&quot;: &quot;user&quot;,&quot;content&quot;: &quot;hi&quot;{'}'}]{'}'}&apos;
        </span>
      </div>
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
      <img className={styles.darkAnt} src="/img/home/antdots-w.png" alt="" aria-hidden="true" />
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
const STEPS = [
  {
    num: '1',
    title: 'Pick your model',
    body: 'Set by open market competition between providers, not a rate one company decided to charge.',
  },
  {
    num: '2',
    title: 'Set your route',
    body: 'No account, no email, nothing tying your requests back to you. Choose TEE verified providers for hardware level privacy.',
  },
  {
    num: '3',
    title: 'Keep your favorite app',
    body: "The routing layer that can't go down, can't lock your account, and can't read your prompts.",
  },
];

function StepsSection() {
  return (
    <section className={styles.stepsSection}>
      <img className={styles.stepsAnt} src="/img/home/ant-v-dots.png" alt="" aria-hidden="true" />
      <div className={styles.sectionInner}>
        <Reveal>
          <h2 className={styles.stepsTitle}>
            You&apos;re <span className={styles.titleAccent}>3 steps</span> from the open market.
          </h2>
        </Reveal>
        <div className={styles.stepsGrid}>
          {STEPS.map((step, i) => (
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
  'Your GPU',
  'Resold API capacity / Spare API capacity',
  'A router',
  'A specialist inference',
];

function SellSection() {
  return (
    <section className={styles.sellSection}>
      <div className={styles.sectionInner}>
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
                    <span className={styles.sellLine} aria-hidden="true" />
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
                <span className={styles.liveTag}><span className={styles.liveDot} /> Live</span>
              </div>
              <div className={styles.earningsBig}>
                <strong><CountUp value="$143K" duration={1400} /></strong>
                <span>Settled to providers on the network</span>
              </div>
              <div className={styles.earningsSmallRow}>
                <div className={styles.earningsSmall}>
                  <strong><CountUp value="162" /></strong>
                  <span>Sellers earning</span>
                </div>
                <div className={styles.earningsSmall}>
                  <strong><CountUp value="18,440" /></strong>
                  <span>Settlements · epoch</span>
                </div>
              </div>
              <p className={styles.earningsNote}>
                Live figure pulled from{' '}
                <a href="https://antseedstats.com" target="_blank" rel="noopener noreferrer">
                  antseedstats.com
                </a>
              </p>
            </div>
          </div>
        </Reveal>
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
    a: "OpenRouter is a centralized aggregator: it decides which models are listed, reads every request, and holds provider payouts until withdrawal. AntSeed removes the aggregator from routing. Requests go peer-to-peer, payments settle on-chain directly to the provider's wallet, and anyone can provide — no approval needed. <a href=\"/vs/openrouter\">Read the full comparison →</a>",
  },
  {
    q: 'What happens when LLMs become so good that anyone can do anything?',
    a: "Then inference becomes a commodity — and commodities belong on open markets, not behind one company's pricing page. The more capable and interchangeable models get, the more the winner is whoever routes each request to the cheapest, fastest, most private provider. That routing layer should be neutral infrastructure you run yourself, which is exactly what AntSeed is.",
  },
  {
    q: "Isn't this just like P2P file sharing? Netflix killed that.",
    a: "File sharing died because nobody got paid, so supply dried up the moment a convenient legal option appeared. AntSeed is the opposite: providers earn on every request, settled directly and on-chain. It's a market with working payments, not free copying — the incentives point toward more supply, not less.",
  },
  {
    q: 'Is AntSeed built for agents specifically?',
    a: 'It works with anything that speaks the OpenAI or Anthropic API — chat apps, IDEs, scripts — but agents benefit the most. Agents burn tokens continuously, so open-market pricing compounds, and a local endpoint with automatic fallback means long-running loops never stall because one provider throttled you.',
  },
  {
    q: 'Why would a provider use AntSeed instead of just building their own API?',
    a: 'Because distribution is the hard part. On AntSeed a provider plugs into existing demand — buyers, discovery, reputation, and on-chain settlement come with the network. No billing stack to build, no customers to acquire, no payment risk to carry. Serve a request, get paid, automatically.',
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
      <img className={styles.finalCtaAnt} src="/img/home/antdots-w.png" alt="" aria-hidden="true" />
      <div className={styles.finalCtaGlow} aria-hidden="true" />
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
  return (
    <Button href={download.href} variant="white" size="lg" osIcons>Download VPR</Button>
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

  return (
    <Layout
      title={siteConfig.tagline}
      description="The open market for AI inference. Every model, no middleman. Anonymous and always on. Pay per request — no account, no subscription."
      wrapperClassName="homepage-wrapper">
      <Head>
        <script type="application/ld+json">{JSON.stringify(faqLd)}</script>
      </Head>

      <Hero />
      <LogoMarquee />
      <PricingSection />
      <PrivateByDesign />
      <OwnedByNoOne />
      <RunsOnYourComputer />
      <LocalhostSection />
      <StepsSection />
      <SellSection />
      <FAQSection />
      <FinalCta />
    </Layout>
  );
}
