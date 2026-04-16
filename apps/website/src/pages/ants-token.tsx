import {useState, useEffect, useMemo} from 'react';
import Link from '@docusaurus/Link';
import Layout from '@theme/Layout';
import styles from './ants-token.module.css';

const RELEASES_URL = 'https://github.com/AntSeed/antseed/releases/latest';
const GH_API_LATEST = 'https://api.github.com/repos/AntSeed/antseed/releases/latest';
const DUNE_URL = 'https://dune.com/antseed_com/antseed';
const ANTS_TOKEN_ADDRESS = '0xa87EE81b2C0Bc659307ca2D9ffdC38514DD85263';
const ANTS_BASESCAN_URL = `https://basescan.org/token/${ANTS_TOKEN_ADDRESS}`;

/* ── Download helpers (same as homepage) ───────────────────────── */
function buildDmgUrl(tag: string, arch: 'arm64' | 'x64'): string {
  const version = tag.replace(/^v/, '');
  const suffix = arch === 'arm64' ? '-arm64' : '';
  return `https://github.com/AntSeed/antseed/releases/download/${tag}/AntSeed-Desktop-${version}${suffix}.dmg`;
}

function isMac(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Macintosh|Mac OS X/.test(navigator.userAgent);
}

function useLatestRelease() {
  const [tag, setTag] = useState<string | null>(null);
  const [arch, setArch] = useState<'arm64' | 'x64'>('arm64');
  const mac = useMemo(isMac, []);

  useEffect(() => {
    if (!mac) return;
    const nav = navigator as Navigator & { userAgentData?: { getHighEntropyValues(hints: string[]): Promise<{ architecture?: string }> } };
    if (nav.userAgentData?.getHighEntropyValues) {
      nav.userAgentData.getHighEntropyValues(['architecture'])
        .then(data => { if (data.architecture === 'x86') setArch('x64'); })
        .catch(() => {});
    }
    fetch(GH_API_LATEST)
      .then(r => r.json())
      .then(data => { if (data?.tag_name) setTag(data.tag_name as string); })
      .catch(() => {});
  }, [mac]);

  const dmgUrl = mac && tag ? buildDmgUrl(tag, arch) : null;
  return { dmgUrl };
}

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

/* ── HALVING CHART ─────────────────────────────────────────────── */
function HalvingCurve({currentEpoch}: {currentEpoch: number}) {
  const points: {epoch: number; emission: number}[] = [];
  let em = INITIAL_EMISSION;
  for (let e = 0; e <= 624; e++) {
    if (e > 0 && e % HALVING_INTERVAL === 0) em = em / 2;
    if (e % 8 === 0) points.push({epoch: e, emission: em});
  }
  const w = 100;
  const h = 40;
  const pathD = points.map((p, i) => {
    const x = (p.epoch / 624) * w;
    const y = h - (p.emission / INITIAL_EMISSION) * h;
    return `${i === 0 ? 'M' : 'L'}${x},${y}`;
  }).join(' ');

  return (
    <div className={styles.halvingChart}>
      <svg viewBox={`0 0 ${w} ${h + 4}`} preserveAspectRatio="none" className={styles.halvingSvg}>
        <path d={pathD} fill="none" stroke="#1FD87A" strokeWidth="1.5" />
        <circle cx={Math.max((currentEpoch / 624) * w, 1)} cy={0} r="2.5" fill="#1FD87A" />
      </svg>
      <div className={styles.halvingLabels}>
        <span>Epoch 0</span>
        <span>You are here - Epoch {currentEpoch}</span>
        <span>Epoch 624</span>
      </div>
    </div>
  );
}

/* ── MAIN PAGE ─────────────────────────────────────────────────── */
export default function AntsToken(): JSX.Element {
  const {dmgUrl} = useLatestRelease();
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
          <a href={dmgUrl ?? RELEASES_URL} target="_blank" rel="noopener noreferrer" className={styles.ctaPrimary}>
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

      {/* ── EMISSIONS ── */}
      <section className={styles.emissions}>
        <div className={styles.emissionsHeader}>
          <h2>Emission schedule</h2>
          <p>
            Each epoch (1 week) distributes a fixed ANTS budget. Every 104 epochs (~2 years),
            the budget halves. Six halvings reduce emissions to near-zero.
          </p>
        </div>

        <HalvingCurve currentEpoch={epoch} />

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
            {pct: '15%', label: 'Protocol Reserve', desc: 'Unclaimed allocations and seller cap overages flow here. Funds ecosystem growth.', accent: false},
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

      {/* ── HOW TO EARN ── */}
      <section className={styles.earn}>
        <div className={styles.earnHeader}>
          <h2>How to earn ANTS</h2>
          <p>No mining. No staking ANTS. Just use the network.</p>
        </div>

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
            <p>At epoch end, call claim with the epoch numbers you participated in. ANTS are minted directly to your wallet. Unclaimed emissions flow to the protocol reserve.</p>
          </div>
        </div>
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
          <a href={dmgUrl ?? RELEASES_URL} target="_blank" rel="noopener noreferrer" className={styles.ctaPrimary}>
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
