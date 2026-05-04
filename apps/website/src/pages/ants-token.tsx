import {useState, useEffect} from 'react';
import Link from '@docusaurus/Link';
import Layout from '@theme/Layout';
import styles from './ants-token.module.css';
import {useLatestDesktopDownload} from '../lib/useLatestDesktopDownload';

const DUNE_URL = 'https://dune.com/antseed_com/antseed';
const ANTS_TOKEN_ADDRESS = '0xa87EE81b2C0Bc659307ca2D9ffdC38514DD85263';
const ANTS_BASESCAN_URL = `https://basescan.org/token/${ANTS_TOKEN_ADDRESS}`;

/* ── Epoch countdown ───────────────────────────────────────────── */
const EPOCH_DURATION = 604_800; // 1 week in seconds

// Genesis timestamp from AntseedEmissions contract on Base mainnet (block 44469557)
// Read via: eth_call genesis() on 0x36877fBa8Fa333aa46a1c57b66D132E4995C86b5
const GENESIS: number = 1775728461; // 2026-04-09T09:54:21Z

function useEpochCountdown() {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);

  if (GENESIS === 0) {
    return { epoch: 0, timeLeft: 'Not started', started: false };
  }

  const elapsed = now - GENESIS;
  const epoch = Math.floor(elapsed / EPOCH_DURATION);
  const epochEnd = GENESIS + (epoch + 1) * EPOCH_DURATION;
  const remaining = Math.max(0, epochEnd - now);

  const d = Math.floor(remaining / 86400);
  const h = Math.floor((remaining % 86400) / 3600);
  const m = Math.floor((remaining % 3600) / 60);
  const s = remaining % 60;

  const timeLeft = d > 0
    ? `${d}d ${h}h ${m}m`
    : h > 0
      ? `${h}h ${m}m ${s}s`
      : `${m}m ${s}s`;

  return { epoch, timeLeft, started: true };
}

/* ── Token constants ───────────────────────────────────────────── */
const MAX_SUPPLY = 1_040_000_000;
const INITIAL_EMISSION = 5_000_000;
const HALVING_INTERVAL = 104;

/* ── SUPPLY BAR ────────────────────────────────────────────────── */
function SupplyBar({totalSupply}: {totalSupply: number}) {
  const ratio = (totalSupply / MAX_SUPPLY) * 100;
  return (
    <div className={styles.supplyBar}>
      <div className={styles.supplyBarTrack}>
        <div className={styles.supplyBarFill} style={{width: `${Math.max(ratio, 0.3)}%`}} />
      </div>
      <div className={styles.supplyBarLabels}>
        <span>{totalSupply === 0 ? '0' : `${(totalSupply / 1e6).toFixed(1)}M`} current supply</span>
        <span>{(MAX_SUPPLY / 1e6).toFixed(0)}M max</span>
      </div>
    </div>
  );
}

/* ── HALVING TIMELINE ──────────────────────────────────────────── */
const TOTAL_EPOCHS = 624;
const YEARS_TOTAL = 12;

function HalvingCurve({currentEpoch, currentBudget}: {currentEpoch: number; currentBudget: number}) {
  const W = 800;
  const H = 210;
  const padL = 16;
  const padR = 16;
  const padT = 56;
  const padB = 44;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const xFor = (e: number) => padL + (e / TOTAL_EPOCHS) * plotW;
  const yFor = (em: number) => padT + plotH - (em / INITIAL_EMISSION) * plotH;

  // Build step-style curve (sharp halving drops)
  const segs: string[] = [];
  let em = INITIAL_EMISSION;
  segs.push(`M${xFor(0)},${yFor(em)}`);
  for (let i = 1; i <= 6; i++) {
    const epochAtHalving = i * HALVING_INTERVAL;
    segs.push(`L${xFor(epochAtHalving)},${yFor(em)}`);
    em = em / 2;
    segs.push(`L${xFor(epochAtHalving)},${yFor(em)}`);
  }
  segs.push(`L${xFor(TOTAL_EPOCHS)},${yFor(em)}`);
  const pathD = segs.join(' ');
  const areaD = `${pathD} L${xFor(TOTAL_EPOCHS)},${padT + plotH} L${xFor(0)},${padT + plotH} Z`;

  // Clamp current position visually so the marker is always visible
  const visibleEpoch = Math.max(currentEpoch, 1);
  const curX = xFor(visibleEpoch);
  const curY = yFor(Math.max(currentBudget, INITIAL_EMISSION * 0.03));

  const cliffs = [1, 2, 3, 4, 5].map(i => i * HALVING_INTERVAL);
  const yearTicks = [0, 2, 4, 6, 8, 10, 12];

  // Label pill position (keep within chart horizontally)
  const pillW = 96;
  const pillX = Math.min(Math.max(curX - pillW / 2, padL), W - padR - pillW);
  const pillY = curY - 38;

  return (
    <div className={styles.halvingChart}>
      <svg viewBox={`0 0 ${W} ${H}`} className={styles.halvingSvg}>
        <defs>
          <linearGradient id="curveFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#1FD87A" stopOpacity="0.18" />
            <stop offset="100%" stopColor="#1FD87A" stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* Baseline axis */}
        <line
          x1={padL}
          y1={padT + plotH}
          x2={padL + plotW}
          y2={padT + plotH}
          className={styles.halvingAxis}
        />

        {/* Halving cliff markers */}
        {cliffs.map(e => (
          <g key={e}>
            <line
              x1={xFor(e)}
              y1={padT}
              x2={xFor(e)}
              y2={padT + plotH}
              className={styles.halvingCliff}
            />
            <line
              x1={xFor(e)}
              y1={padT + plotH}
              x2={xFor(e)}
              y2={padT + plotH + 5}
              className={styles.halvingTick}
            />
          </g>
        ))}

        {/* Area under curve */}
        <path d={areaD} fill="url(#curveFill)" />

        {/* Main curve */}
        <path d={pathD} fill="none" stroke="#1FD87A" strokeWidth="2" strokeLinejoin="round" />

        {/* Vertical "now" line */}
        <line
          x1={curX}
          y1={curY}
          x2={curX}
          y2={padT + plotH}
          className={styles.halvingNow}
        />

        {/* Pulse + core dot */}
        <circle cx={curX} cy={curY} r="10" className={styles.halvingPulse} />
        <circle cx={curX} cy={curY} r="5" fill="#1FD87A" stroke="#fff" strokeWidth="2" />

        {/* "You are here" pill */}
        <g>
          <rect x={pillX} y={pillY} width={pillW} height="26" rx="13" className={styles.halvingPill} />
          <text
            x={pillX + pillW / 2}
            y={pillY + 17}
            textAnchor="middle"
            className={styles.halvingPillText}
          >
            You · Epoch {currentEpoch}
          </text>
          <path
            d={`M${curX - 4},${pillY + 26} L${curX + 4},${pillY + 26} L${curX},${pillY + 32} Z`}
            fill="#1a1a1a"
          />
        </g>

        {/* X-axis year labels */}
        {yearTicks.map(yr => {
          const epoch = (yr / YEARS_TOTAL) * TOTAL_EPOCHS;
          return (
            <text
              key={yr}
              x={xFor(epoch)}
              y={padT + plotH + 22}
              textAnchor={yr === 0 ? 'start' : yr === YEARS_TOTAL ? 'end' : 'middle'}
              className={styles.halvingXLabel}
            >
              {yr === 0 ? 'Genesis' : `Yr ${yr}`}
            </text>
          );
        })}
      </svg>
    </div>
  );
}

/* ── EARN FLOW (animated) ──────────────────────────────────────── */
function EarnFlow(): JSX.Element {
  return (
    <div className={styles.flowCard}>
      <svg
        viewBox="0 0 800 220"
        preserveAspectRatio="xMidYMid meet"
        className={styles.flowSvg}
        aria-hidden="true"
      >
        <defs>
          <path id="pBuyerSeller" d="M200,70 L320,70" />
          <path id="pSellerMint"  d="M480,70 L600,70" />
          <path id="pMintSeller"  d="M680,110 Q680,170 540,170 Q400,170 400,110" />
          <path id="pMintBuyer"   d="M680,110 Q680,200 400,200 Q120,200 120,110" />
        </defs>

        {/* Paths (dashed guides) */}
        <use href="#pBuyerSeller" className={styles.flowLine} />
        <use href="#pSellerMint"  className={styles.flowLine} />
        <use href="#pMintSeller"  className={styles.flowLineGreen} fill="none" />
        <use href="#pMintBuyer"   className={styles.flowLineGreen} fill="none" />

        {/* Buyer */}
        <g>
          <rect x="40" y="30" width="160" height="80" rx="14" className={styles.flowBox} />
          <text x="120" y="63" textAnchor="middle" className={styles.flowBoxTitle}>Buyer</text>
          <text x="120" y="88" textAnchor="middle" className={styles.flowBoxSub}>deposits USDC</text>
        </g>

        {/* Seller */}
        <g>
          <rect x="320" y="30" width="160" height="80" rx="14" className={styles.flowBox} />
          <text x="400" y="63" textAnchor="middle" className={styles.flowBoxTitle}>Seller</text>
          <text x="400" y="88" textAnchor="middle" className={styles.flowBoxSub}>stakes · serves</text>
        </g>

        {/* $ANTS Mint */}
        <g>
          <rect x="600" y="30" width="160" height="80" rx="14" className={styles.flowBoxMint} />
          <text x="680" y="63" textAnchor="middle" className={styles.flowBoxTitleMint}>$ANTS Mint</text>
          <text x="680" y="88" textAnchor="middle" className={styles.flowBoxSubMint}>epoch settle</text>
        </g>

        {/* Forward labels */}
        <text x="260" y="58" textAnchor="middle" className={styles.flowLineLabel}>USDC</text>
        <text x="540" y="58" textAnchor="middle" className={styles.flowLineLabel}>volume reported</text>
        <text x="400" y="216" textAnchor="middle" className={styles.flowLineLabelGreen}>ANTS minted at epoch end</text>

        {/* USDC pellets: Buyer → Seller */}
        <circle r="5" className={styles.flowPellet}>
          <animateMotion dur="2.4s" repeatCount="indefinite">
            <mpath href="#pBuyerSeller" />
          </animateMotion>
        </circle>
        <circle r="5" className={styles.flowPellet}>
          <animateMotion dur="2.4s" repeatCount="indefinite" begin="1.2s">
            <mpath href="#pBuyerSeller" />
          </animateMotion>
        </circle>

        {/* ANTS return: Mint → Seller and Mint → Buyer */}
        <circle r="6" className={styles.flowPelletGreen}>
          <animateMotion dur="4.8s" repeatCount="indefinite" begin="1.5s">
            <mpath href="#pMintSeller" />
          </animateMotion>
        </circle>
        <circle r="6" className={styles.flowPelletGreen}>
          <animateMotion dur="4.8s" repeatCount="indefinite" begin="2s">
            <mpath href="#pMintBuyer" />
          </animateMotion>
        </circle>
      </svg>

      <div className={styles.flowLegend}>
        <span className={styles.flowLegendItem}>
          <span className={styles.flowLegendDot} /> USDC payment
        </span>
        <span className={styles.flowLegendItem}>
          <span className={styles.flowLegendDotGreen} /> ANTS emission
        </span>
      </div>
    </div>
  );
}

/* ── MAIN PAGE ─────────────────────────────────────────────────── */
export default function AntsToken(): JSX.Element {
  const download = useLatestDesktopDownload();
  const {epoch, timeLeft, started} = useEpochCountdown();

  const totalSupply = epoch * INITIAL_EMISSION;

  const epochBudget = started
    ? INITIAL_EMISSION / Math.pow(2, Math.floor(epoch / HALVING_INTERVAL))
    : INITIAL_EMISSION;

  const emissionRate = started ? epochBudget / EPOCH_DURATION : 0;
  const nextHalvingIn = HALVING_INTERVAL - (epoch % HALVING_INTERVAL);

  return (
    <Layout
      title="ANTS Token | AntSeed"
      description="ANTS is earned by the people who build and use the network. Hard-capped at 1.04B with automatic halvings."
    >

      {/* ── HERO ── */}
      <section className={styles.hero}>
        <a href={ANTS_BASESCAN_URL} target="_blank" rel="noopener noreferrer" className={styles.heroKicker}>$ANTS</a>
        <h1 className={styles.heroTitle}>
          A network owned by<br />
          <em>the people who use it.</em>
        </h1>
        <div className={styles.heroStatus}>
          <span className={styles.statusDot} />
          <span className={styles.statusText}>Tokens Restricted</span>
        </div>
        <p className={styles.heroSub}>
          ANTS is earned, not bought. No pre-mine, no insider allocation — sellers and buyers who
          create real economic activity on the network receive ANTS proportional to their
          contribution. Hard-capped at 1.04B with automatic halvings.
        </p>
        <div className={styles.heroCtas}>
          <a href={download.href} target="_blank" rel="noopener noreferrer" className={styles.ctaPrimary}>
            Download AntStation →
          </a>
          <Link to="/docs/lightpaper" className={styles.ctaSecondary}>Lightpaper</Link>
        </div>
      </section>

      {/* ── TOKEN OVERVIEW ── */}
      <section className={styles.overview}>
        <div className={styles.overviewHeader}>
          <h2>Token supply</h2>
          <p>1.04 billion hard cap. No minting beyond emissions. No admin mint function.</p>
        </div>

        <SupplyBar totalSupply={totalSupply} />

        <div className={styles.statsGrid}>
          <div className={styles.statCard}>
            <div className={styles.statValue}>{totalSupply / 1e6}M</div>
            <div className={styles.statLabel}>Current Supply</div>
          </div>
          <div className={styles.statCard}>
            <div className={styles.statValue}>{Math.round(totalSupply / MAX_SUPPLY * 10000) / 100}%</div>
            <div className={styles.statLabel}>Available</div>
          </div>
          <div className={styles.statCard}>
            <div className={styles.statValue}>Epoch {epoch}</div>
            <div className={styles.statLabel}>Current Epoch</div>
          </div>
          <div className={styles.statCard}>
            <div className={styles.statValue}>{timeLeft}</div>
            <div className={styles.statLabel}>Until Next Epoch</div>
          </div>
        </div>
      </section>

      {/* ── HOW TO EARN ── */}
      <section className={styles.earn}>
        <div className={styles.earnHeader}>
          <h2>How you earn ANTS</h2>
          <p>
            Every USDC dollar settled on-chain mints ANTS at epoch end.
            No pre mining, no ANTS staking — your share tracks real activity.
          </p>
        </div>

        <EarnFlow />

        <div className={styles.earnGrid}>
          <div className={styles.earnCard}>
            <div className={styles.earnStep}>01</div>
            <h3>As a seller</h3>
            <p>Stake USDC, serve requests, settle on-chain. Your share of the 50% seller pool is proportional to your USDC volume that epoch. Capped at 50% of seller pool per seller.</p>
          </div>
          <div className={styles.earnCard}>
            <div className={styles.earnStep}>02</div>
            <h3>As a buyer</h3>
            <p>Deposit USDC, use the network, pay for AI services. Your share of the 20% buyer pool is proportional to your USDC spend that epoch. Diversity bonus for using multiple sellers.</p>
          </div>
          <div className={styles.earnCard}>
            <div className={styles.earnStep}>03</div>
            <h3>Claim each epoch</h3>
            <p>At epoch end, call claim with the epoch numbers you participated in. ANTS are minted directly to your wallet. Unclaimed emissions remain claimable.</p>
          </div>
        </div>
      </section>

      {/* ── EMISSIONS ── */}
      <section className={styles.emissions}>
        <div className={styles.emissionsHeader}>
          <h2>Emission schedule</h2>
          <p>
            Each epoch (1 week) distributes a fixed ANTS budget. Every 104 epochs (~2 years),
            the budget halves. Six halvings reduce emissions to near-zero.
          </p>
        </div>

        <HalvingCurve currentEpoch={epoch} currentBudget={epochBudget} />

        <div className={styles.emissionsCurrentCard}>
          <div className={styles.emissionsCurrentTitle}>
            {started ? 'Current epoch budget' : 'First epoch budget'}
          </div>
          <div className={styles.emissionsCurrentValue}>
            {(epochBudget / 1e6).toFixed(0)}M ANTS
          </div>
          <div className={styles.emissionsCurrentSub}>
            {started
              ? `${emissionRate.toFixed(3)} ANTS/sec · next halving in ${nextHalvingIn} epochs`
              : 'Emissions begin when the contract is deployed on Base'
            }
          </div>
        </div>

        <div className={styles.splitGrid}>
          {[
            {pct: '50%', label: 'Sellers', desc: 'Pro-rata by USDC volume settled. Capped at 50% of seller pool per seller per epoch.', accent: true},
            {pct: '20%', label: 'Buyers', desc: 'Pro-rata by USDC spent. Rewards active usage and seller diversity.', accent: false},
            {pct: '15%', label: 'Protocol Reserve', desc: 'The protocol reserve allocation and seller cap overages flow here. Funds ecosystem growth.', accent: false},
            {pct: '15%', label: 'Team', desc: 'Vested to core contributors. Aligned with long-term network health.', accent: false},
          ].map(s => (
            <div key={s.label} className={`${styles.splitCard} ${s.accent ? styles.splitCardAccent : ''}`}>
              <div className={styles.splitPct}>{s.pct}</div>
              <div className={styles.splitLabel}>{s.label}</div>
              <p className={styles.splitDesc}>{s.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── NETWORK ACTIVITY (Dune) ── */}
      <section className={styles.activity}>
        <div className={styles.activityHeader}>
          <h2>Network activity</h2>
          <p>Real economic activity backing the token. All settlement happens on Base.</p>
        </div>

        <a href={DUNE_URL} target="_blank" rel="noopener noreferrer" className={styles.duneBanner}>
          <div className={styles.duneBannerContent}>
            <div className={styles.duneBannerIcon}>
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 3v18h18"/>
                <path d="M7 16l4-8 4 4 5-9"/>
              </svg>
            </div>
            <div className={styles.duneBannerText}>
              <div className={styles.duneBannerTitle}>Live on Dune Analytics</div>
              <div className={styles.duneBannerSub}>
                Volume, channels, fees, staking, and deposits, all from on-chain data.
                Open dashboard →
              </div>
            </div>
          </div>
        </a>
      </section>

      {/* ── CONTRACT DETAILS ── */}
      <section className={styles.contracts}>
        <div className={styles.contractsHeader}>
          <h2>On-chain details</h2>
        </div>
        <div className={styles.contractsTable}>
          <div className={styles.contractsRow}>
            <span className={styles.contractsLabel}>Token contract</span>
            <span className={styles.contractsValue}>
              <a href={ANTS_BASESCAN_URL} target="_blank" rel="noopener noreferrer" className={styles.contractsLink}>
                {ANTS_TOKEN_ADDRESS.slice(0, 6)}...{ANTS_TOKEN_ADDRESS.slice(-4)} on Base
              </a>
            </span>
          </div>
          {[
            {label: 'Token standard', value: 'ERC-20'},
            {label: 'Max supply', value: '1,040,000,000 ANTS'},
            {label: 'Epoch duration', value: '1 week (604,800 seconds)'},
            {label: 'Halving interval', value: 'Every 104 epochs (~2 years)'},
            {label: 'Network fee', value: '2% of settlement (200 bps), collected to community reserve pool'},
            {label: 'Transfers', value: 'Currently restricted'},
          ].map(r => (
            <div key={r.label} className={styles.contractsRow}>
              <span className={styles.contractsLabel}>{r.label}</span>
              <span className={styles.contractsValue}>{r.value}</span>
            </div>
          ))}
        </div>
      </section>

      {/* ── BOTTOM CTA ── */}
      <section className={styles.bottomCta}>
        <h2>Start earning ANTS</h2>
        <p>Download AntStation, join the network as a provider or buyer, and start accumulating.</p>
        <div className={styles.bottomCtaBtns}>
          <a href={download.href} target="_blank" rel="noopener noreferrer" className={styles.ctaPrimary}>
            Download AntStation →
          </a>
          <Link to="/providers" className={styles.ctaSecondary}>Become a provider</Link>
        </div>
        <div className={styles.bottomLinks}>
          <Link to="/docs/lightpaper">Lightpaper</Link>
          <span>·</span>
          <Link to="/docs/payments">Payment protocol</Link>
          <span>·</span>
          <a href={DUNE_URL} target="_blank" rel="noopener noreferrer">Network dashboard</a>
        </div>
      </section>

    </Layout>
  );
}
