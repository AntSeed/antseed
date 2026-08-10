import {useState, useEffect, useRef} from 'react';
import Layout from '@theme/Layout';
import styles from './ants-token.module.css';
import {useLatestDesktopDownload} from '../lib/useLatestDesktopDownload';
import {
  Button,
  FinalCta,
  PageHero,
  Reveal,
  Section,
  SectionHeader,
  StatTile,
} from '../components/ui';

const STATS_URL = 'https://antseedstats.com/network';
const ANTS_TOKEN_ADDRESS = '0xa87EE81b2C0Bc659307ca2D9ffdC38514DD85263';
const ANTS_BASESCAN_URL = `https://basescan.org/token/${ANTS_TOKEN_ADDRESS}`;

/* ── Epoch countdown ───────────────────────────────────────────── */
const EPOCH_DURATION = 604_800; // 1 week in seconds

// Genesis timestamp from AntseedEmissions contract on Base mainnet (block 44469557)
// Read via: eth_call genesis() on 0xF13bE52c4A3afC6AE29536f073588d01A0564088
const GENESIS: number = 1775728461; // 2026-04-09T09:54:21Z

function useEpochCountdown() {
  // Start with a deterministic value so SSR and the first client render match.
  // The real `now` is filled in after mount to avoid React hydration mismatches.
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    setNow(Math.floor(Date.now() / 1000));
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);

  if (now === null) {
    // Pre-hydration / SSR: render a stable placeholder identical on server and client.
    return { epoch: 0, timeLeft: '-', started: false };
  }

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

/* ── in-view trigger for the section visuals ───────────────────── */
function useInView(threshold = 0.35) {
  const ref = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced || typeof IntersectionObserver === 'undefined') {
      setInView(true);
      return undefined;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          observer.disconnect();
          setInView(true);
        }
      },
      {threshold}
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [threshold]);

  return {ref, inView};
}

/* ── SELLER POOLS — how recognition is weighted ────────────────── */
function PoolWeightCard() {
  return (
    <div className={styles.poolCard}>
      <img className={styles.poolAnt} src="/img/home/antdots-b.png" alt="" aria-hidden="true" />
      <div className={styles.poolHead}>
        <span>Recognized usage</span>
        <span className={styles.poolTag}>Stake-weighted</span>
      </div>
      <div className={styles.poolEq}>
        <div className={styles.poolTerm}>
          <strong>Settled volume</strong>
          <em>buyer-authorized payments through channels</em>
        </div>
        <span className={styles.poolOp} aria-hidden="true">×</span>
        <div className={styles.poolTerm}>
          <strong>Stake weight</strong>
          <em>ANTS locked behind the seller&apos;s identity</em>
        </div>
        <span className={styles.poolOp} aria-hidden="true">=</span>
        <div className={`${styles.poolTerm} ${styles.poolTermResult}`}>
          <strong>Recognized usage</strong>
          <em>what reputation and rewards follow</em>
        </div>
      </div>
    </div>
  );
}

/* ── VERIFICATIONS — ResponseAuth receipt visual ───────────────── */
const RECEIPT_CHECKS = [
  {label: 'signature', value: 'seller key'},
  {label: 'request hash', value: 'committed'},
  {label: 'response hash', value: 'committed'},
  {label: 'fingerprint', value: 'matches label'},
];

function VerifyReceipt() {
  const {ref, inView} = useInView();
  return (
    <div className={`${styles.receipt} ${inView ? styles.receiptIn : ''}`} ref={ref}>
      <div className={styles.receiptBar}>
        <span className={styles.receiptDots}>
          <i style={{background: '#EF4444'}} />
          <i style={{background: '#F59E0B'}} />
          <i style={{background: '#676663'}} />
        </span>
        <span className={styles.receiptTitle}>ResponseAuth</span>
        <span className={styles.receiptTagline}>EVIDENCE · PER RESPONSE</span>
      </div>
      <div className={styles.receiptMeta}>
        <span>seller</span>
        <span>0x3fA4…9c2b</span>
      </div>
      <div className={styles.receiptMeta}>
        <span>response</span>
        <span>#48219 · deepseek-v3</span>
      </div>
      {RECEIPT_CHECKS.map((row, i) => (
        <div
          key={row.label}
          className={styles.receiptCheck}
          style={{transitionDelay: `${250 + i * 180}ms`}}>
          <span className={styles.receiptLabel}>{row.label}</span>
          <span className={styles.receiptValue}>{row.value}</span>
          <span className={styles.receiptOk} aria-hidden="true">✓</span>
        </div>
      ))}
      <div className={styles.receiptResult} style={{transitionDelay: '1000ms'}}>
        <span>recognized usage</span>
        <span className={styles.receiptResultValue}>weighted by verification</span>
      </div>
    </div>
  );
}

/* ── MAIN PAGE ─────────────────────────────────────────────────── */
export default function AntsToken(): JSX.Element {
  const download = useLatestDesktopDownload();
  const {epoch, timeLeft} = useEpochCountdown();

  const totalSupply = epoch * INITIAL_EMISSION;

  return (
    <Layout
      title="ANTS Token"
      description="ANTS is the native token of the AntSeed network and its trust and reputation layer."
    >
      <PageHero
        accent="clay"
        kicker={
          <a href={ANTS_BASESCAN_URL} target="_blank" rel="noopener noreferrer" className={styles.heroKicker}>
            $ANTS
          </a>
        }
        title={
          <>
            The native token of<br />
            <em>the AntSeed network.</em>
          </>
        }
        badge={
          <span className={styles.statusPill}>
            <span className={styles.statusDot} aria-hidden="true" />
            Tokens restricted
          </span>
        }
        lead="ANTS is the native token of AntSeed and the trust and reputation layer of the network: real, payment-backed usage and locked ANTS behind seller identities turn open participation into reputation buyers can verify.">
        <Button href={download.href} variant="clay" arrow>Download VPR</Button>
        <Button to="/docs/lightpaper" variant="ghost">Lightpaper</Button>
      </PageHero>

      {/* ── TOKEN OVERVIEW ── */}
      <Section tone="tinted">
        <Reveal>
          <SectionHeader
            title="Token supply"
            lead="1.04 billion hard cap. No minting beyond emissions. No admin mint function."
          />
        </Reveal>

        <Reveal>
          <SupplyBar totalSupply={totalSupply} />
        </Reveal>

        <Reveal className={styles.statsGrid} delay={80}>
          <StatTile value={`${totalSupply / 1e6}M`} label="Current supply" />
          <StatTile
            value={`${Math.round((totalSupply / MAX_SUPPLY) * 10000) / 100}%`}
            label="Available"
          />
          <StatTile value={`Epoch ${epoch}`} label="Current epoch" />
          <StatTile value={timeLeft} label="Until next epoch" />
        </Reveal>
      </Section>

      {/* ── SELLER POOLS ── */}
      <Section>
        <div className={styles.poolGrid}>
          <Reveal className={styles.splitCopy}>
            <p className={styles.splitKicker}>Seller pools</p>
            <h2 className={styles.splitTitle}>
              Not all volume<br />
              <em>counts the same.</em>
            </h2>
            <p className={styles.splitLead}>
              Seller pools are the reputation layer of the network. Settled, buyer-authorized
              volume becomes recognized usage - and how much of it is recognized depends on the
              ANTS locked behind the seller&apos;s identity.
            </p>
            <ul className={styles.splitPoints}>
              <li>
                <span className={styles.splitMark} aria-hidden="true" />
                <span><strong>Payment-backed.</strong> Only settled, buyer-authorized volume counts, never self-reported claims.</span>
              </li>
              <li>
                <span className={styles.splitMark} aria-hidden="true" />
                <span><strong>Stake-weighted.</strong> Locked ANTS is durable backing that routers and buyers can inspect.</span>
              </li>
              <li>
                <span className={styles.splitMark} aria-hidden="true" />
                <span><strong>Capped rewards.</strong> Emissions follow recognized usage inside capped ranges; unused budget can be burned.</span>
              </li>
            </ul>
            <div className={styles.splitCta}>
              <Button to="/blog/seller-pools-reputation-tokenomics" variant="ghost" arrow>
                How seller pools work
              </Button>
            </div>
          </Reveal>
          <Reveal delay={140}>
            <PoolWeightCard />
          </Reveal>
        </div>
      </Section>

      {/* ── VERIFICATIONS ── */}
      <Section tone="ink" className={styles.verifySection}>
        <div className={styles.verifyGrid}>
          <Reveal className={`${styles.splitCopy} ${styles.verifyCopy}`}>
            <p className={styles.splitKicker}>Verifications</p>
            <h2 className={`${styles.splitTitle} ${styles.verifyTitle}`}>
              Evidence,<br />not labels.
            </h2>
            <p className={`${styles.splitLead} ${styles.verifyLead}`}>
              A model name on an endpoint proves nothing. On AntSeed, evidence travels with every
              response - and verification decides how much a seller&apos;s usage is worth.
            </p>
            <ul className={`${styles.splitPoints} ${styles.verifyPoints}`}>
              <li>
                <span className={styles.verifyMark} aria-hidden="true">✓</span>
                <span><strong>Signed responses</strong> prove who served which bytes - no trust in a brand required.</span>
              </li>
              <li>
                <span className={styles.verifyMark} aria-hidden="true">✓</span>
                <span><strong>Model fingerprints</strong>, shared in a public torrent-style swarm, check the model behind an endpoint against its label.</span>
              </li>
              <li>
                <span className={styles.verifyMark} aria-hidden="true">✓</span>
                <span><strong>Verification feeds policy:</strong> how much of a seller&apos;s settled volume is recognized can depend on how it verifies.</span>
              </li>
            </ul>
            <div className={styles.splitCta}>
              <Button to="/blog/model-verification-fingerprint-swarm" variant="light" arrow>
                How verification works
              </Button>
            </div>
          </Reveal>
          <Reveal className={styles.verifyCardCol} delay={140}>
            <VerifyReceipt />
          </Reveal>
        </div>
      </Section>

      {/* ── CLOSING CTA ── */}
      <FinalCta
        title="Help build the network"
        sub="Download the VPR, use the network for real AI work, run a provider, and help improve the open-source protocol."
        note={
          <>
            <a href="/docs/lightpaper">Lightpaper</a>
            <a href="/docs/payments">Payment protocol</a>
            <a href={STATS_URL} target="_blank" rel="noopener noreferrer">Network dashboard</a>
          </>
        }>
        <Button href={download.href} variant="white" size="lg" arrow>Download VPR</Button>
        <Button to="/providers" variant="light" size="lg">Become a provider</Button>
      </FinalCta>
    </Layout>
  );
}
