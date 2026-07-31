import {useEffect, useRef, useState} from 'react';
import Head from '@docusaurus/Head';
import Link from '@docusaurus/Link';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import Layout from '@theme/Layout';
import styles from './index.module.css';
import {useLatestDesktopDownload, RELEASES_URL} from '../lib/useLatestDesktopDownload';
import {DesktopDownloadIcon} from '../lib/DesktopDownloadIcon';

/* ============================================================
   LIVE NETWORK STATS
   ============================================================ */
const STATS_URL = 'https://network.antseed.com/stats';

function useNetworkStats() {
  const [peerCount, setPeerCount] = useState<number | null>(null);
  const [serviceCount, setServiceCount] = useState<number | null>(null);

  useEffect(() => {
    const refresh = async () => {
      try {
        const res = await fetch(STATS_URL, {signal: AbortSignal.timeout(5000)});
        if (!res.ok) return;
        const data = await res.json();
        const peers = data.peers ?? [];
        const services: string[] = [];
        for (const p of peers) for (const pr of p.providers ?? []) for (const m of pr.services ?? []) services.push(m);
        setPeerCount(peers.length);
        setServiceCount(services.length);
      } catch { /* stats unavailable — leave counters hidden */ }
    };
    refresh();
    const interval = setInterval(refresh, 30_000);
    return () => clearInterval(interval);
  }, []);

  return {peerCount, serviceCount};
}

function LiveBar() {
  const {peerCount, serviceCount} = useNetworkStats();
  return (
    <a href="https://antseedstats.com/network" target="_blank" rel="noopener noreferrer" className={styles.lbar}>
      <span className={styles.litem}><span className={styles.ldot} /> network live</span>
      <span className={styles.litem}>
        <strong className={peerCount == null ? styles.lcountPending : undefined}>
          {peerCount ?? '--'}
        </strong>{' '}
        active peers
      </span>
      <span className={styles.litem}>
        <strong className={serviceCount == null ? styles.lcountPending : undefined}>
          {serviceCount ?? '--'}
        </strong>{' '}
        services
      </span>
      <span className={styles.liveArrow}>→</span>
    </a>
  );
}

/* ============================================================
   ANT GLYPH — shared SVG ant (head up, 24×32 viewBox)
   ============================================================ */
function AntGlyph({className}: {className?: string}) {
  return (
    <svg className={className} viewBox="0 0 24 32" fill="none" aria-hidden="true">
      <g stroke="currentColor" strokeWidth="1.2" strokeLinecap="round">
        <path d="M10.6 12.2 L4 8.4" /><path d="M13.4 12.2 L20 8.4" />
        <path d="M10.4 15 L3 15.6" /><path d="M13.6 15 L21 15.6" />
        <path d="M10.6 17.8 L4.4 23.4" /><path d="M13.4 17.8 L19.6 23.4" />
        <path d="M10.9 6.4 L8.2 2.4" /><path d="M13.1 6.4 L15.8 2.4" />
      </g>
      <g fill="currentColor">
        <circle cx="3.6" cy="8.2" r=".9" /><circle cx="20.4" cy="8.2" r=".9" />
        <circle cx="2.6" cy="15.6" r=".9" /><circle cx="21.4" cy="15.6" r=".9" />
        <circle cx="4.1" cy="23.7" r=".9" /><circle cx="19.9" cy="23.7" r=".9" />
        <circle cx="8" cy="2.1" r=".9" /><circle cx="16" cy="2.1" r=".9" />
        <ellipse cx="12" cy="8.2" rx="2.5" ry="3" />
        <ellipse cx="12" cy="13.6" rx="2.1" ry="2.8" />
        <ellipse cx="12" cy="21.4" rx="3.3" ry="5" />
      </g>
    </svg>
  );
}

/* ============================================================
   MARCHING-ANTS BORDER — animated dashed stroke overlay
   ============================================================ */
function MarchBorder() {
  return (
    <svg className={styles.marchBorder} aria-hidden="true">
      <rect x="0.5" y="0.5" rx="17.5" ry="17.5" />
    </svg>
  );
}

/* ============================================================
   PHEROMONE FIELD (hero)
   A colony of drawn ants wanders the field, leaving pheromone
   trails that link into a mesh — stigmergy, the coordination
   mechanism ant colonies and P2P networks share. The cursor
   lays pheromone; clicking drops a burst the colony swarms to.
   Two canvases: a fading trail layer and a crisp ant layer.
   ============================================================ */
function PheromoneField() {
  const trailRef = useRef<HTMLCanvasElement>(null);
  const antsRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const trail = trailRef.current;
    const crisp = antsRef.current;
    if (!trail || !crisp) return;
    const tctx = trail.getContext('2d');
    const actx = crisp.getContext('2d');
    if (!tctx || !actx) return;

    let w = 0;
    let h = 0;
    let raf = 0;
    let running = false;

    type Ant = {x: number; y: number; a: number; v: number; wob: number; ph: number; s: number};
    type Pheromone = {x: number; y: number; life: number; max: number; r: number; pull: number; ring: boolean};
    type Seed = {x: number; y: number; life: number; max: number; size: number; eaten: number};
    let ants: Ant[] = [];
    let pheromones: Pheromone[] = [];
    let clickSeeds: Seed[] = [];

    const isLightTheme = () => document.documentElement.getAttribute('data-theme') === 'light';
    const trailFade = () => isLightTheme() ? 'rgba(245, 245, 240, 0.05)' : 'rgba(7, 11, 9, 0.038)';
    const trailBase = () => isLightTheme() ? '#f5f5f0' : '#070b09';
    const antLeg = () => isLightTheme() ? 'rgba(10, 14, 20, 0.72)' : 'rgba(140, 255, 196, 0.5)';
    const antAntenna = () => isLightTheme() ? 'rgba(10, 14, 20, 0.82)' : 'rgba(140, 255, 196, 0.65)';
    const antBody = () => isLightTheme() ? 'rgba(10, 14, 20, 0.94)' : 'rgba(160, 255, 205, 0.92)';
    const pheromoneDot = () => isLightTheme() ? 'rgba(19, 146, 86, 0.38)' : 'rgba(31, 216, 122, 0.5)';
    const pheromoneLink = (alpha: number) => isLightTheme() ? `rgba(19, 146, 86, ${Math.min(0.34, alpha * 1.8).toFixed(3)})` : `rgba(31, 216, 122, ${alpha.toFixed(3)})`;
    const pheromoneRing = (alpha: number) => isLightTheme() ? `rgba(11, 92, 56, ${Math.min(0.5, alpha * 1.7).toFixed(3)})` : `rgba(31, 216, 122, ${alpha.toFixed(3)})`;

    const seed = () => {
      // Colony size reduced ~15% — calmer field, same stigmergy.
      const count = Math.max(10, Math.min(25, Math.round(w / 61)));
      ants = Array.from({length: count}, () => ({
        x: Math.random() * w,
        y: Math.random() * h,
        a: Math.random() * Math.PI * 2,
        v: 0.5 + Math.random() * 0.45,
        wob: 0.5 + Math.random(),
        ph: Math.random() * 10,
        s: 0.75 + Math.random() * 0.4,
      }));
    };

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = trail.offsetWidth;
      h = trail.offsetHeight;
      for (const [cv, cx] of [[trail, tctx], [crisp, actx]] as const) {
        cv.width = Math.round(w * dpr);
        cv.height = Math.round(h * dpr);
        cx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
      tctx.fillStyle = trailBase();
      tctx.fillRect(0, 0, w, h);
      seed();
    };

    // Shortest signed angle from `from` to `to`.
    const angTo = (from: number, to: number) => {
      let d = (to - from) % (Math.PI * 2);
      if (d > Math.PI) d -= Math.PI * 2;
      if (d < -Math.PI) d += Math.PI * 2;
      return d;
    };

    const drawAnt = (ctx: CanvasRenderingContext2D, ant: Ant) => {
      ctx.save();
      ctx.translate(ant.x, ant.y);
      ctx.rotate(ant.a + Math.PI / 2); // body drawn pointing up; -y = forward
      ctx.scale(ant.s, ant.s);
      // Legs — three pairs in an alternating tripod swing.
      ctx.strokeStyle = antLeg();
      ctx.lineWidth = 0.9;
      for (let side = -1; side <= 1; side += 2) {
        for (let i = 0; i < 3; i++) {
          const sw = Math.sin(ant.ph * 2.2 + i * 2.1 + (side > 0 ? Math.PI : 0)) * 2.2;
          const ly = -2.5 + i * 2.6;
          ctx.beginPath();
          ctx.moveTo(side * 1.4, ly);
          ctx.lineTo(side * 5.2, ly + sw + (i - 1) * 1.4);
          ctx.stroke();
        }
      }
      // Antennae.
      ctx.strokeStyle = antAntenna();
      ctx.lineWidth = 0.8;
      ctx.beginPath(); ctx.moveTo(-0.8, -4.6); ctx.lineTo(-2.8, -7.6); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0.8, -4.6); ctx.lineTo(2.8, -7.6); ctx.stroke();
      // Body — head, thorax, abdomen.
      ctx.fillStyle = antBody();
      ctx.beginPath(); ctx.ellipse(0, -3.6, 1.4, 1.8, 0, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.ellipse(0, -0.4, 1.2, 1.7, 0, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.ellipse(0, 3.4, 1.9, 2.9, 0, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    };

    const LINK = 110;

    const step = () => {
      // Trail layer fades slowly — this is what leaves the pheromone smear.
      tctx.fillStyle = trailFade();
      tctx.fillRect(0, 0, w, h);

      pheromones = pheromones.filter((p) => --p.life > 0);
      clickSeeds = clickSeeds.filter((s) => --s.life > 0 && s.eaten < 1);

      for (const ant of ants) {
        // Steer toward live pheromone within reach.
        for (const p of pheromones) {
          const dx = p.x - ant.x;
          const dy = p.y - ant.y;
          const d2 = dx * dx + dy * dy;
          if (d2 < p.r * p.r && d2 > 100) {
            ant.a += angTo(ant.a, Math.atan2(dy, dx)) * p.pull * (p.life / p.max);
          }
        }
        // Clicks drop edible seeds; nearby ants swarm, then consume them.
        for (const s of clickSeeds) {
          const dx = s.x - ant.x;
          const dy = s.y - ant.y;
          const d2 = dx * dx + dy * dy;
          if (d2 < 290 * 290 && d2 > 16) {
            ant.a += angTo(ant.a, Math.atan2(dy, dx)) * 0.18 * (s.life / s.max) * (1 - s.eaten);
          }
          if (d2 < 42) {
            s.eaten = Math.min(1, s.eaten + 0.08);
            s.life = Math.min(s.life, 34);
          }
        }
        ant.a += (Math.random() - 0.5) * 0.26 * ant.wob;
        ant.x += Math.cos(ant.a) * ant.v;
        ant.y += Math.sin(ant.a) * ant.v;
        ant.ph += ant.v * 0.5;
        if (ant.x < -12) ant.x = w + 12;
        if (ant.x > w + 12) ant.x = -12;
        if (ant.y < -12) ant.y = h + 12;
        if (ant.y > h + 12) ant.y = -12;
        // Pheromone dot left behind.
        tctx.fillStyle = pheromoneDot();
        tctx.beginPath();
        tctx.arc(ant.x, ant.y, 1.1, 0, Math.PI * 2);
        tctx.fill();
      }

      // Mesh links between nearby ants, smearing gently into the trail layer.
      for (let i = 0; i < ants.length; i++) {
        for (let j = i + 1; j < ants.length; j++) {
          const dx = ants[i].x - ants[j].x;
          const dy = ants[i].y - ants[j].y;
          const d2 = dx * dx + dy * dy;
          if (d2 < LINK * LINK) {
            const t = 1 - Math.sqrt(d2) / LINK;
            tctx.strokeStyle = pheromoneLink(t * 0.18);
            tctx.lineWidth = 1;
            tctx.beginPath();
            tctx.moveTo(ants[i].x, ants[i].y);
            tctx.lineTo(ants[j].x, ants[j].y);
            tctx.stroke();
          }
        }
      }

      // Crisp layer: edible click seeds, click rings + the ants themselves.
      actx.clearRect(0, 0, w, h);
      for (const s of clickSeeds) {
        const age = 1 - s.life / s.max;
        const r = s.size * (1 - s.eaten * 0.65) * (0.9 + Math.sin(age * Math.PI * 6) * 0.12);
        const alpha = Math.max(0, (s.life / s.max) * (1 - s.eaten));
        actx.fillStyle = `rgba(232, 163, 61, ${(0.9 * alpha).toFixed(3)})`;
        actx.shadowColor = 'rgba(232, 163, 61, 0.75)';
        actx.shadowBlur = 12 * alpha;
        actx.beginPath();
        actx.ellipse(s.x, s.y, r * 1.15, r * 0.85, age * Math.PI, 0, Math.PI * 2);
        actx.fill();
        actx.shadowBlur = 0;
      }
      for (const p of pheromones) {
        if (!p.ring) continue;
        const k = 1 - p.life / p.max;
        actx.strokeStyle = pheromoneRing(0.32 * (1 - k));
        actx.lineWidth = 1;
        actx.beginPath();
        actx.arc(p.x, p.y, 14 + k * p.r, 0, Math.PI * 2);
        actx.stroke();
      }
      for (const ant of ants) drawAnt(actx, ant);
    };

    const loop = () => {
      step();
      raf = requestAnimationFrame(loop);
    };
    const start = () => {
      if (running) return;
      running = true;
      raf = requestAnimationFrame(loop);
    };
    const stop = () => {
      running = false;
      cancelAnimationFrame(raf);
    };

    resize();

    // Pheromone input — the hero element hosts the canvases.
    const host = trail.parentElement;
    let lastMove = 0;
    const localXY = (e: MouseEvent) => {
      const r = trail.getBoundingClientRect();
      return {x: e.clientX - r.left, y: e.clientY - r.top};
    };
    const onMove = (e: MouseEvent) => {
      const now = performance.now();
      if (now - lastMove < 90) return;
      lastMove = now;
      const {x, y} = localXY(e);
      pheromones.push({x, y, life: 70, max: 70, r: 130, pull: 0.05, ring: false});
      if (pheromones.length > 40) pheromones.splice(0, pheromones.length - 40);
    };
    const onClick = (e: MouseEvent) => {
      const {x, y} = localXY(e);
      pheromones.push({x, y, life: 220, max: 220, r: 300, pull: 0.12, ring: true});
      for (let i = 0; i < 8; i++) {
        const a = Math.random() * Math.PI * 2;
        const d = 4 + Math.random() * 22;
        clickSeeds.push({
          x: x + Math.cos(a) * d,
          y: y + Math.sin(a) * d,
          life: 260 + Math.random() * 80,
          max: 320,
          size: 2.1 + Math.random() * 1.8,
          eaten: 0,
        });
      }
      if (clickSeeds.length > 52) clickSeeds.splice(0, clickSeeds.length - 52);
    };

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) {
      // Render a settled static colony instead of animating.
      for (let i = 0; i < 420; i++) step();
      return () => stop();
    }
    host?.addEventListener('mousemove', onMove);
    host?.addEventListener('click', onClick);
    const vis = new IntersectionObserver(
      (entries) => (entries[0].isIntersecting ? start() : stop()),
      {threshold: 0},
    );
    vis.observe(trail);
    window.addEventListener('resize', resize);
    return () => {
      stop();
      vis.disconnect();
      window.removeEventListener('resize', resize);
      host?.removeEventListener('mousemove', onMove);
      host?.removeEventListener('click', onClick);
    };
  }, []);

  return (
    <>
      <canvas ref={trailRef} className={styles.heroField} aria-hidden="true" />
      <canvas ref={antsRef} className={styles.heroFieldTop} aria-hidden="true" />
    </>
  );
}

/* ============================================================
   REQUEST TRACE (hero terminal)
   The real buyer flow: browse the network, pin a peer, the
   local proxy serves requests with per-request settlement.
   ============================================================ */
const TRACE_CMD = 'antseed network browse --service minimax';
const TRACE_LINES: {t: string; c: 'dim' | 'ok' | 'pay' | 'cmd'}[] = [
  {t: '✔ found 23 peers · sorted by reputation', c: 'dim'},
  {t: '0x7f3a…c2e1   score 4.9   $2.41/Mtok   tee', c: 'ok'},
  {t: '0x91d4…08aa   score 4.8   $2.95/Mtok', c: 'dim'},
  {t: '0x3c5e…f102   score 4.6   $3.10/Mtok', c: 'dim'},
  {t: '$ antseed buyer connection set --peer 0x7f3a…c2e1', c: 'cmd'},
  {t: '✔ pinned — proxy live at localhost:8377', c: 'ok'},
  {t: '$ payments settle per request · usdc → seller', c: 'pay'},
];

function RequestTrace() {
  const [frame, setFrame] = useState({
    chars: TRACE_CMD.length,
    lines: TRACE_LINES.length,
    cursor: false,
  });
  const lineCls = {dim: styles.trDim, ok: styles.trOk, pay: styles.trPay, cmd: styles.trCmd};

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const typeMs = TRACE_CMD.length * 34;
    const revealDelayMs = 360;
    const lineMs = 440;
    const holdMs = 4600;
    const resetMs = 700;
    const revealStartMs = typeMs + revealDelayMs;
    const revealEndMs = revealStartMs + TRACE_LINES.length * lineMs;
    const cycleMs = revealEndMs + holdMs + resetMs;
    const startedAt = performance.now() + 450;
    let raf = 0;

    const tick = (now: number) => {
      const elapsed = Math.max(0, now - startedAt) % cycleMs;
      let next = {
        chars: TRACE_CMD.length,
        lines: TRACE_LINES.length,
        cursor: false,
      };

      if (elapsed < typeMs) {
        next = {
          chars: Math.max(1, Math.floor((elapsed / typeMs) * TRACE_CMD.length)),
          lines: 0,
          cursor: true,
        };
      } else if (elapsed < revealStartMs) {
        next = {chars: TRACE_CMD.length, lines: 0, cursor: true};
      } else if (elapsed < revealEndMs) {
        next = {
          chars: TRACE_CMD.length,
          lines: Math.min(TRACE_LINES.length, Math.floor((elapsed - revealStartMs) / lineMs) + 1),
          cursor: false,
        };
      }

      setFrame((prev) => (
        prev.chars === next.chars && prev.lines === next.lines && prev.cursor === next.cursor
          ? prev
          : next
      ));
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className={styles.trace} aria-hidden="true">
      <MarchBorder />
      <div className={styles.traceBar}>
        <span /><span /><span />
        <b>antseed · buyer proxy</b>
      </div>
      <div className={styles.traceBody}>
        <div className={styles.traceCmd}>
          <i>$</i> {TRACE_CMD.slice(0, frame.chars)}
          {frame.cursor && <span className={styles.traceCaret} />}
        </div>
        {TRACE_LINES.map((l, i) => (
          <div key={i} className={`${styles.traceLine} ${lineCls[l.c]} ${i < frame.lines ? styles.traceShow : ''}`}>
            {l.t}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ============================================================
   DEPTH RAIL — the page is a descent into the colony.
   A fixed gauge on the right edge tracks how deep you've
   scrolled into the nest, an ant marking your position.
   ============================================================ */
function DepthRail() {
  const [p, setP] = useState(0);
  useEffect(() => {
    let raf = 0;
    const update = () => {
      raf = 0;
      const d = document.documentElement;
      const max = d.scrollHeight - window.innerHeight;
      setP(max > 0 ? Math.min(1, window.scrollY / max) : 0);
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    update();
    window.addEventListener('scroll', onScroll, {passive: true});
    return () => {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener('scroll', onScroll);
    };
  }, []);
  return (
    <div className={styles.depthRail} aria-hidden="true">
      <span className={styles.depthLabel}>surface</span>
      <div className={styles.depthTrack}>
        <div className={styles.depthFill} style={{transform: `scaleY(${p})`}} />
        <span className={styles.depthAnt} style={{top: `${p * 100}%`}}><AntGlyph /></span>
      </div>
      <span className={styles.depthLabel}>{(p * 14).toFixed(1)}m ↓</span>
    </div>
  );
}

/* ============================================================
   PHEROMONE TRAIL — brand divider between sections.
   A marching dotted line led by a single worker ant.
   ============================================================ */
function Trail() {
  return (
    <div className={styles.trail} aria-hidden="true">
      <span className={styles.trailNode} />
      <span className={styles.trailNode} />
      <span className={styles.trailNode} />
      <span className={styles.trailNode} />
    </div>
  );
}

/* ============================================================
   TELEMETRY BAND (marquee)
   ============================================================ */
const BAND_MODELS: [string, string][] = [
  ['anthropic.png', 'Anthropic'], ['openai.png', 'OpenAI'], ['google.png', 'Google'],
  ['deepseek.png', 'DeepSeek'], ['meta.png', 'Meta'], ['qwen.png', 'Qwen'],
  ['mistral.png', 'Mistral'], ['moonshot.png', 'Moonshot'], ['zhipu.png', 'Zhipu'],
  ['minimax.png', 'MiniMax'], ['cohere.png', 'Cohere'], ['nousresearch.svg', 'Nous Research'],
];

function TelemetryBand() {
  const items = (
    <>
      {BAND_MODELS.map(([logo, name], i) => (
        <span className={styles.bandModel} key={`${name}-${i}`} title={name}>
          <img src={`/logos/${logo}`} alt={name} loading="lazy" />
          <span className={styles.bandName}>{name}</span>
        </span>
      ))}
    </>
  );
  return (
    <div className={styles.band} aria-label="Models available on the network">
      <div className={styles.bandTrack}>
        {items}{items}
      </div>
    </div>
  );
}

/* ============================================================
   PROTOCOL JOURNEY
   ============================================================ */
const JOURNEY = [
  {n: '01', t: 'Discover', m: 'open dht', d: 'Your node finds providers on the open DHT. No signup, no API key, no waitlist — the network is the catalog.'},
  {n: '02', t: 'Route', m: 'price · latency · reputation · privacy', d: 'Pick the peer that fits the job: cheapest, fastest, best track record, or TEE-attested for hardware privacy.'},
  {n: '03', t: 'Infer', m: 'direct p2p transport', d: 'The request travels straight to the provider. There is no platform in the middle to read it, queue it, or mark it up.'},
  {n: '04', t: 'Settle', m: 'usdc · on-chain · per request', d: 'USDC settles to the provider’s wallet per request. No custody, no payout threshold, no withdrawal queue.'},
];

/* ============================================================
   NO GATEKEEPERS LEDGER
   ============================================================ */
const LEDGER = [
  {k: 'Listings', a: 'A platform decides which models are listed.', b: 'Anyone can provide. No approval, no listing fee.'},
  {k: 'Requests', a: 'A platform reads every request you send.', b: 'Requests travel peer-to-peer. Choose TEE providers for hardware privacy.'},
  {k: 'Payments', a: 'A platform holds payouts until withdrawal.', b: 'USDC settles on-chain, straight to the provider’s wallet.'},
  {k: 'Identity', a: 'A platform requires an account and a card.', b: 'No central account. Anonymous by design.'},
];

/* ============================================================
   SUPPLY SIDE
   ============================================================ */
const SUPPLY = [
  {n: '01', t: 'Raw inference', m: 'gpus · apis · local models', d: 'Serve models from your hardware or upstream API capacity, priced however you like.'},
  {n: '02', t: 'Specialist agents', m: 'skills · fine-tunes · domain expertise', d: 'Sell what you know: a legal agent, a code auditor, a research assistant — your edge, on the network.'},
  {n: '03', t: 'Routing', m: 'tee · price · latency · result quality', d: 'Run a router that picks the best peer for every request and earns on every hop.'},
];

/* ============================================================
   FAQ
   ============================================================ */
const FAQ_DATA = [
  {q: 'How is this different from OpenRouter?', a: "OpenRouter is a centralized aggregator: it decides which models are listed, reads every request, and holds provider payouts until withdrawal. AntSeed removes the aggregator from routing. Requests go peer-to-peer. Payments settle on-chain directly to the provider's wallet. Anyone can provide — no approval needed. Because AntSeed is open peer-to-peer software, independent nodes may continue operating without reliance on a single hosted service. <a href=\"/vs/openrouter\" style=\"color:var(--as-green);font-weight:500;\">Read the full comparison →</a>"},
  {q: 'What happens when LLMs become so good that anyone can do anything?', a: "That is exactly what we want. When LLMs become dramatically more capable, costs collapse and more people can run their own capable LLMs on their own hardware. Those people become AntSeed providers. The supply side grows, not shrinks. But \"anyone can do anything\" does not mean everyone delivers the same result. The value is in what you build on top: the skills, the workflows, the domain expertise, the agent orchestration. A more capable base model raises the ceiling for every provider, but it does not eliminate the distance between a generic prompt and a production-grade service."},
  {q: "Isn't this just like P2P file sharing? Netflix killed that.", a: "Netflix and Spotify won because humans are happy to pay a simple subscription for a clean UI. But that logic only applies to humans who care about experience. Agents don't. An agent has no preference for a polished interface, no reason to care about a brand, no inertia keeping it on a familiar platform. It just needs the service, the price, and the reliability. On those three axes, an open P2P network with no middleman and no markup wins every time."},
  {q: 'Is AntSeed built for agents specifically?', a: "It works for humans today and is being used by humans now. But the architecture decisions: USDC-native payments, no account system, open discovery, always-on peers, are all decisions that make the network ideal for agents. A human tolerates signing up, waiting for API keys, and managing a subscription. An agent cannot. The network AntSeed is building is the one autonomous agents will naturally discover and use."},
  {q: 'Why would a provider use AntSeed instead of just building their own API?', a: "Building your own API means building billing infrastructure, handling support, managing uptime, acquiring customers, and maintaining a reputation system from scratch. That is a startup, not a service. AntSeed gives you distribution: buyers already on the network looking for exactly what you offer, plus a reputation system that makes your track record portable and permanent, plus payments handled at the protocol level. You focus on the thing you're good at. The network handles the rest."},
];

function FAQSection() {
  const [openIdx, setOpenIdx] = useState<number | null>(null);
  return (
    <section className={styles.section} data-reveal>
      <header className={styles.sectionHead}>
        <span className={styles.ghostNum} aria-hidden="true">06</span>
        <h2 className={styles.sectionTitle}>Fair questions.</h2>
      </header>
      <div className={styles.faqList}>
        {FAQ_DATA.map((item, i) => (
          <div key={i} className={`${styles.faqItem} ${i === 0 ? styles.faqItemFirst : ''}`}>
            <div className={styles.faqSummary} onClick={() => setOpenIdx(openIdx === i ? null : i)}>
              <span>{item.q}</span>
              <span className={`${styles.faqChevron} ${openIdx === i ? styles.faqChevronOpen : ''}`}>+</span>
            </div>
            <div className={`${styles.faqCollapse} ${openIdx === i ? styles.faqCollapseOpen : ''}`}>
              <div className={styles.faqCollapseInner}>
                <p className={styles.faqAnswer} dangerouslySetInnerHTML={{__html: item.a}} />
              </div>
            </div>
          </div>
        ))}
      </div>
      <div className={styles.faqMore}>
        <Link to="/docs/faq" className={styles.faqMoreLink}>See all FAQs →</Link>
      </div>
    </section>
  );
}

/* ============================================================
   PAGE
   ============================================================ */
export default function Home(): JSX.Element {
  const {siteConfig} = useDocusaurusContext();
  const download = useLatestDesktopDownload();

  // Stagger sections in as they enter the viewport.
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const els = Array.from(document.querySelectorAll('[data-reveal]'));
    const obs = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          e.target.classList.add('reveal-in');
          obs.unobserve(e.target);
        }
      }
    }, {threshold: 0.08, rootMargin: '0px 0px -60px'});
    for (const el of els) {
      el.classList.add('reveal-prep');
      obs.observe(el);
    }
    return () => obs.disconnect();
  }, []);

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
      description="The open market for AI inference. Serve or consume AI peer-to-peer. Onchain payments. Verifiable reputation. Anonymous by design, with independent providers and no central account."
      wrapperClassName="homepage-wrapper">
      <Head>
        <link rel="canonical" href="https://antseed.com/" />
        <script type="application/ld+json">{JSON.stringify(orgLd)}</script>
        <script type="application/ld+json">{JSON.stringify(faqLd)}</script>
      </Head>

      <DepthRail />

      {/* ===== HERO ===== */}
      <header className={styles.hero}>
        <PheromoneField />
        <div className={styles.heroGrid}>
          <div className={styles.heroCopy}>
            <h1 className={styles.heroTitle}>The <em>open market</em> for AI&nbsp;inference.</h1>
            <p className={styles.heroSub}>
              Anyone can sell intelligence. Anyone can buy it. Requests travel
              peer-to-peer, payments settle on-chain in <span className={styles.clay}>USDC</span>, and reputation is
              verifiable. No gatekeepers. No accounts. No one in the middle.
            </p>
            <div className={styles.heroCtas}>
              <a href={download.href} target="_blank" rel="noopener noreferrer" className={styles.btnSolid}>
                <DesktopDownloadIcon platform={download.platform} />
                Download AntStation
              </a>
              <Link to="/integrations" className={styles.btnGhost}>Connect your tools →</Link>
            </div>
            <div className={styles.heroLive}><LiveBar /></div>
          </div>
          <div className={styles.heroSide}>
            <RequestTrace />
            <p className={styles.heroHint}>⌖ click the field — drop seeds, the colony responds</p>
          </div>
        </div>
      </header>

      <TelemetryBand />

      {/* ===== 01 / PROTOCOL ===== */}
      <section className={styles.section} data-reveal>
        <header className={styles.sectionHead}>
          <span className={styles.ghostNum} aria-hidden="true">01</span>
          <h2 className={styles.sectionTitle}>How a request travels.</h2>
          <p className={styles.sectionLead}>
            The colony doesn&apos;t have a manager. Neither does the network. Four
            steps, none of them owned by anyone.
          </p>
        </header>
        <div className={styles.journey}>
          <div className={styles.journeyRail} aria-hidden="true">
            <span className={styles.journeyNode} />
            <span className={styles.journeyNode} />
            <span className={styles.journeyNode} />
            <span className={styles.journeyNode} />
            <span className={styles.journeyWalker}>
              <AntGlyph className={styles.journeyAnt} />
              <span className={styles.journeySeed} />
            </span>
          </div>
          <div className={styles.journeyGrid}>
            {JOURNEY.map((s) => (
              <article className={styles.journeyStep} key={s.n}>
                <span className={styles.journeyNum}>{s.n}</span>
                <h3>{s.t}</h3>
                <span className={styles.journeyMeta}>{s.m}</span>
                <p>{s.d}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <Trail />

      {/* ===== 02 / CHAT ===== */}
      <section className={`${styles.section} ${styles.split}`} data-reveal>
        <div className={styles.splitCopy}>
          <h2 className={styles.sectionTitle}>Open the app. Skip&nbsp;the&nbsp;account.</h2>
          <p className={styles.sectionLead}>
            AntStation is the desktop app for the open model market. Pick a
            model, route through the peer-to-peer network, pay providers in
            USDC. Designed for anonymous access — no central account, while
            users remain responsible for what they send to independent providers.
          </p>
          <ul className={styles.factList}>
            <li><b>Anonymous access</b><span>No account wall before you can ask.</span></li>
            <li><b>Open market</b><span>Providers choose their models and policies; users are responsible for lawful use.</span></li>
            <li><b>Frontier + open source</b><span>The best model for the job, not the one your subscription picked.</span></li>
            <li><b>Private providers</b><span>Prefer TEE attestation and direct P2P transport.</span></li>
          </ul>
          <div className={styles.ctaRow}>
            <a href={download.href} target="_blank" rel="noopener noreferrer" className={styles.btnSolid}>
              <DesktopDownloadIcon platform={download.platform} />
              {download.platform === 'win' ? 'Download for Windows' : 'Download for Mac'}
            </a>
            <a href={RELEASES_URL} target="_blank" rel="noopener noreferrer" className={styles.btnGhost}>
              <DesktopDownloadIcon platform={download.platform === 'win' ? 'mac' : 'win'} />
              {download.platform === 'win' ? 'Mac' : 'Windows'}
            </a>
            <a href="https://antseedstats.com/network" target="_blank" rel="noopener noreferrer" className={styles.btnText}>See live providers →</a>
          </div>
        </div>
        <div className={styles.splitMedia}>
          <video
            src="/videos/desktop-app-v2.mp4"
            autoPlay
            loop
            muted
            playsInline
            className={styles.mediaVideo}
          />
        </div>
      </section>

      {/* ===== 03 / BUILD ===== */}
      <section className={`${styles.section} ${styles.split} ${styles.splitReverse}`} data-reveal>
        <div className={styles.splitCopy}>
          <h2 className={styles.sectionTitle}>Point your tools at&nbsp;localhost.</h2>
          <p className={styles.sectionLead}>
            AntSeed exposes OpenAI and Anthropic-compatible APIs at{' '}
            <code className={styles.inlineCode}>localhost:8377</code>, then routes
            each request across the open provider market by price, latency,
            reputation, capability, or privacy.
          </p>
          <ul className={styles.tickList}>
            <li>Keep your tools — swap the providers underneath</li>
            <li>Fallback when a provider is slow, expensive, or down</li>
            <li>Route by price, latency, reputation, or TEE privacy</li>
            <li>Settle directly with providers in USDC, no custody</li>
          </ul>
          <div className={styles.linkRow}>
            <Link to="/integrations">Coding agents</Link>
            <Link to="/integrations">CLI clients</Link>
            <Link to="/integrations">Frameworks</Link>
            <Link to="/integrations">Agent platforms</Link>
          </div>
          <div className={styles.ctaRow}>
            <Link to="/integrations" className={styles.btnSolid}>Explore integrations →</Link>
          </div>
        </div>
        <div className={styles.splitMedia}>
          <div className={styles.codeCard}>
            <MarchBorder />
            <div className={styles.codeCardBar}>
              <span /><span /><span />
              <b>one endpoint · every tool</b>
            </div>
            <pre className={styles.codeCardBody}>
              <span className={styles.cdC}># Claude Code, routed through the network</span>{'\n'}
              <span className={styles.cdP}>$</span> antseed claude{'\n\n'}
              <span className={styles.cdC}># Codex, pinned to a peer for this model</span>{'\n'}
              <span className={styles.cdP}>$</span> antseed codex --model 0x7f3a…c2e1@deepseek-v3{'\n\n'}
              <span className={styles.cdC}># or pin a peer in any compatible client</span>{'\n'}
              <span className={styles.cdP}>$</span> curl localhost:8377/v1/chat/completions {'\\'}{'\n'}
              <span className={styles.cdO}>
                {`  -H 'content-type: application/json' \\`}{'\n'}
                {`  -d '{"model":"0x7f3a…c2e1@deepseek-v3",`}{'\n'}
                {`       "messages":[{"role":"user","content":"hi"}]}'`}
              </span>
            </pre>
            <div className={styles.codeCardFoot}>request → best peer → usdc settlement</div>
          </div>
        </div>
      </section>

      <Trail />

      {/* ===== 04 / SUPPLY ===== */}
      <section className={styles.section} data-reveal>
        <header className={styles.sectionHead}>
          <span className={styles.ghostNum} aria-hidden="true">04</span>
          <h2 className={styles.sectionTitle}>Anyone can sell intelligence.</h2>
          <p className={styles.sectionLead}>
            GPUs, an API, a router, or a specialist agent — stake your claim,
            get discovered, and build a reputation that belongs to you.
          </p>
        </header>
        <div className={styles.supplyGrid}>
          {SUPPLY.map((s) => (
            <article className={styles.supplyCard} key={s.n}>
              <span className={styles.supplyNum}>{s.n}</span>
              <h3>{s.t}</h3>
              <span className={styles.supplyMeta}>{s.m}</span>
              <p>{s.d}</p>
            </article>
          ))}
        </div>
        <div className={styles.supplyCta}>
          <Link to="/providers" className={styles.btnSolid}>Become a provider →</Link>
          <Link to="/docs/lightpaper" className={styles.btnText}>Read the light paper</Link>
        </div>
      </section>

      {/* ===== 05 / STANCE ===== */}
      <section className={styles.section} data-reveal>
        <header className={styles.sectionHead}>
          <span className={styles.ghostNum} aria-hidden="true">05</span>
          <h2 className={styles.sectionTitle}>No gatekeepers. <em>Structurally.</em></h2>
          <p className={styles.sectionLead}>
            Not a policy promise — an architecture. There is no position in the
            network from which to gatekeep.
          </p>
        </header>
        <div className={styles.ledger}>
          <span className={styles.ledgerAnt} aria-hidden="true"><AntGlyph /></span>
          {LEDGER.map((row) => (
            <div className={styles.ledgerRow} key={row.k}>
              <span className={styles.ledgerKey}>{row.k}</span>
              <span className={styles.ledgerA}>{row.a}</span>
              <span className={styles.ledgerB}>{row.b}</span>
            </div>
          ))}
        </div>
        <div className={styles.ledgerFoot}>
          <Link to="/vs/openrouter" className={styles.btnText}>AntSeed vs OpenRouter, in full →</Link>
        </div>
      </section>

      <Trail />

      {/* ===== ANTS BAND ===== */}
      <section className={styles.antsBand} data-reveal>
        <div className={styles.antsOrb}>
          <img src="/logos/antseed-mark-clay.svg" alt="ANTS" />
          <span className={styles.orbAnt} aria-hidden="true"><AntGlyph /></span>
          <span className={`${styles.orbAnt} ${styles.orbAntTwo}`} aria-hidden="true"><AntGlyph /></span>
        </div>
        <div className={styles.antsCopy}>
          <h2><span className={styles.clayWord}>$ANTS</span> will power reputation and much more. All fees go to <span className={styles.clayWord}>buy and burn</span>.</h2>
          <p>
            As AntSeed grows from individual requests to recurring agent
            workloads, ANTS becomes the coordination layer for access,
            incentives, and reputation — with network fees flowing
            into buy and burn.
          </p>
        </div>
        <Link to="/ants-token" className={styles.btnClay}>Explore ANTS →</Link>
      </section>

      {/* ===== FAQ ===== */}
      <FAQSection />
    </Layout>
  );
}
