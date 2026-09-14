import {useEffect, useRef, useState, type JSX} from 'react';
import Head from '@docusaurus/Head';
import Link from '@docusaurus/Link';
import Layout from '@theme/Layout';
import styles from './ants-token.module.css';
import home from './index.module.css';
import {Button, Faq, Reveal, Section, SectionHeader, StatTile, ArrowRight} from '../components/ui';
import {TokenHeroArt} from '../components/TokenHeroArt';
import {useAntsSupply} from '../lib/useAntsSupply';
import {FinalCtaBand} from '../components/FinalCtaBand';
import {
  ANTS_BASESCAN_URL,
  INITIAL_EMISSION,
  MAX_SUPPLY,
  useEpochCountdown,
} from '../lib/useEpochCountdown';

const TITLE = 'ANTS Token: The Trust Layer of Antseed | Antseed';
const DESCRIPTION =
  'ANTS is the native token of the Antseed network. Payment-backed usage and locked ANTS behind provider identities turn open participation into reputation buyers can verify.';

/* ── SUPPLY BAR ────────────────────────────────────────────────── */
const fmtM = (n: number) => `${(n / 1e6).toLocaleString('en-US', {maximumFractionDigits: 1})}M`;

function SupplyBar({totalSupply, live}: {totalSupply: number; live: boolean}) {
  const ratio = (totalSupply / MAX_SUPPLY) * 100;
  return (
    <div className={styles.supplyBar}>
      <div className={styles.supplyBarTrack}>
        <div className={styles.supplyBarFill} style={{width: `${Math.max(ratio, 0.3)}%`}} />
      </div>
      <div className={styles.supplyBarLabels}>
        <span>
          {totalSupply === 0 ? '0' : fmtM(totalSupply)} {live ? 'minted' : 'scheduled'} so far
          {live && <i className={styles.liveDot} aria-hidden="true" />}
        </span>
        <span>1.04B hard cap</span>
      </div>
    </div>
  );
}

/* ── HOW ANTS WORKS — the loop, three cards ────────────────────── */
function UsageArt() {
  return (
    <svg viewBox="0 0 300 130" width="100%" height="100%" aria-hidden="true" focusable="false">
      {[0, 1, 2, 3].map((i) => (
        <g key={i} transform={`translate(28 ${16 + i * 26})`}>
          <rect width="244" height="20" rx="6" fill="#fff" stroke="rgba(0,30,18,0.12)" />
          <rect x="10" y="7" width="54" height="6" rx="3" fill="rgba(0,30,18,0.18)" />
          <rect x="74" y="7" width={70 - i * 8} height="6" rx="3" fill="rgba(0,30,18,0.1)" />
          <rect x="176" y="6" width="34" height="8" rx="4" fill="rgba(0,30,18,0.12)" />
          <circle cx="228" cy="10" r="4" fill="#10B981" />
        </g>
      ))}
    </svg>
  );
}

function StakeArt() {
  return (
    <svg viewBox="0 0 300 130" width="100%" height="100%" aria-hidden="true" focusable="false">
      <circle cx="150" cy="60" r="30" fill="rgba(16,185,129,0.1)" />
      <circle cx="150" cy="60" r="27" fill="#fff" stroke="#10B981" strokeWidth="1.5" />
      <image href="/logo.svg" x="137" y="47" width="26" height="26" />
      {[[60, 30], [60, 90], [240, 30], [240, 90]].map(([x, y]) => (
        <g key={`${x}${y}`}>
          <rect x={x - 22} y={y - 10} width="44" height="20" rx="6" fill="#fff" stroke="rgba(0,30,18,0.12)" />
          <rect x={x - 5} y={y - 4} width="10" height="8" rx="2" fill="none" stroke="#001E12" strokeWidth="1.3" />
          <path d={`M${x - 3} ${y - 4} v-2.5a3 3 0 0 1 6 0v2.5`} fill="none" stroke="#001E12" strokeWidth="1.3" />
          <line
            x1={x < 150 ? x + 24 : x - 24}
            y1={y}
            x2={x < 150 ? 118 : 182}
            y2={60}
            stroke="#10B981"
            strokeWidth="2"
            strokeDasharray="0.1 6"
            strokeLinecap="round"
          />
        </g>
      ))}
      <text x="150" y="118" textAnchor="middle" fontSize="10" fontWeight="600" fill="#001E12" letterSpacing="1">
        LOCKED ANTS
      </text>
    </svg>
  );
}

function RewardsArt() {
  const bars = [
    {x: 40, h: 56, fill: '#10B981'},
    {x: 88, h: 34, fill: '#10B981'},
    {x: 136, h: 24, fill: 'rgba(0,30,18,0.28)'},
    {x: 184, h: 24, fill: 'rgba(0,30,18,0.28)'},
    {x: 232, h: 16, fill: 'rgba(0,30,18,0.28)'},
  ];
  return (
    <svg viewBox="0 0 300 130" width="100%" height="100%" aria-hidden="true" focusable="false">
      <line x1="24" y1="96" x2="276" y2="96" stroke="rgba(0,30,18,0.12)" />
      {bars.map((b) => (
        <rect key={b.x} x={b.x} y={96 - b.h} width="28" height={b.h} rx="5" fill={b.fill} />
      ))}
      <rect x="40" y="20" width="28" height="14" rx="5" fill="none" stroke="#10B981" strokeDasharray="3 3" />
      <text x="54" y="16" textAnchor="middle" fontSize="8" fill="#047857" fontWeight="600" letterSpacing="0.5">
        CAP
      </text>
      <text x="150" y="118" textAnchor="middle" fontSize="10" fontWeight="600" fill="#001E12" letterSpacing="1">
        WEEKLY EMISSIONS
      </text>
    </svg>
  );
}

const HOW_CARDS = [
  {
    title: 'Real usage creates reputation',
    body: 'When buyers pay providers through Antseed channels, that settled USDC volume becomes recognized usage. Only payment-backed volume counts, never self-reported claims.',
    link: {to: '/docs/recognized-usage', label: 'Recognized usage'},
    art: <UsageArt />,
  },
  {
    title: 'Good providers attract support',
    body: 'ANTS holders can lock tokens behind a provider identity. It is a public signal that the service has durable backing, and routers and buyers can inspect it before they route.',
    link: {to: '/blog/seller-pools-reputation-tokenomics', label: 'Tokenomics post'},
    art: <StakeArt />,
  },
  {
    title: 'Rewards follow useful participation',
    body: 'Providers, buyers, stakers, and verifiers earn from the weekly emissions budget, but only inside capped ranges. Unused budget does not become extra yield. It gets burned.',
    link: {to: '/docs/reward-policies', label: 'Reward policies'},
    art: <RewardsArt />,
  },
];

function HowItWorks() {
  return (
    <section className={home.section}>
      <div className={home.sectionInner}>
        <Reveal>
          <SectionHeader
            title="Usage in, trust out."
            lead="ANTS is not a payment token. USDC pays for service. ANTS turns what actually got paid for into reputation, and routes rewards to the people who made the network useful."
          />
        </Reveal>
        <div className={`${home.cardGrid3} ${home.whoGrid}`}>
          {HOW_CARDS.map((card, i) => (
            <Reveal key={card.title} className={home.whoCard} delay={i * 100}>
              <div className={home.whoArt}>{card.art}</div>
              <div className={home.featureCopy}>
                <h3>{card.title}</h3>
                <p>{card.body}</p>
                <Link to={card.link.to} className={home.featureLinkArrow}>
                  {card.link.label}
                  <ArrowRight />
                </Link>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ── PROVIDER POOLS — how recognition is weighted ──────────────── */
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
          <strong>Pool power</strong>
          <em>ANTS locked behind the provider&apos;s identity</em>
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

function ProviderPools() {
  return (
    <Section tone="tinted">
      <div className={styles.poolGrid}>
        <Reveal className={styles.splitCopy}>
          <p className={styles.splitKicker}>Provider pools</p>
          <h2 className={styles.splitTitle}>
            Not all volume<br />
            <em>counts the same.</em>
          </h2>
          <p className={styles.splitLead}>
            Provider pools are the reputation layer of the network. Settled, buyer-authorized volume
            becomes recognized usage, and how much of it is recognized depends on the ANTS locked
            behind the provider&apos;s identity.
          </p>
          <ul className={styles.splitPoints}>
            <li>
              <span className={styles.splitMark} aria-hidden="true" />
              <span><strong>Payment-backed.</strong> Only settled, buyer-authorized volume counts, never self-reported claims.</span>
            </li>
            <li>
              <span className={styles.splitMark} aria-hidden="true" />
              <span><strong>Stake-weighted.</strong> Locked ANTS is durable backing that routers and buyers can inspect. Power activates the epoch after you lock.</span>
            </li>
            <li>
              <span className={styles.splitMark} aria-hidden="true" />
              <span><strong>Policy-filtered.</strong> Proven wash trading zeros a provider&apos;s reward points without touching the USDC that was already settled.</span>
            </li>
          </ul>
          <div className={styles.splitCta}>
            <Button to="/blog/seller-pools-reputation-tokenomics" variant="ghost" arrow>
              How provider pools work
            </Button>
          </div>
        </Reveal>
        <Reveal delay={140}>
          <PoolWeightCard />
        </Reveal>
      </div>
    </Section>
  );
}

/* ── EMISSIONS — where each epoch goes ─────────────────────────── */
const ALLOCATION = [
  {label: 'Provider-pool rewards', pct: 40, cls: 'a1'},
  {label: 'Usage rewards', pct: 20, cls: 'a2'},
  {label: 'Team', pct: 15, cls: 'a3'},
  {label: 'Emissions reserve', pct: 15, cls: 'a4'},
  {label: 'Verification', pct: 10, cls: 'a5'},
] as const;

function Emissions({epoch, timeLeft}: {epoch: number; timeLeft: string}) {
  return (
    <Section>
      <Reveal>
        <SectionHeader
          kicker="Emissions"
          title="Where each epoch goes."
          lead="Emissions run in weekly epochs that halve every 104 epochs, starting at 5 million ANTS per epoch. From epoch 22, each epoch is split under these ceilings."
        />
      </Reveal>
      <Reveal className={styles.alloc} delay={80}>
        <div className={styles.allocBar} role="img" aria-label="Allocation ceilings per epoch">
          {ALLOCATION.map((a) => (
            <span key={a.label} className={`${styles.allocSeg} ${styles[a.cls]}`} style={{flex: a.pct}}>
              <span className={styles.allocPct}>{a.pct}%</span>
            </span>
          ))}
        </div>
        <ul className={styles.allocLegend}>
          {ALLOCATION.map((a) => (
            <li key={a.label}>
              <span className={`${styles.allocSwatch} ${styles[a.cls]}`} aria-hidden="true" />
              <span className={styles.allocLabel}>{a.label}</span>
              <span className={styles.allocValue}>{a.pct}%</span>
            </li>
          ))}
        </ul>
      </Reveal>
      <div className={styles.emitGrid}>
        <Reveal className={styles.emitCard} delay={120}>
          <h3>Rewards scale with participation</h3>
          <p>
            The provider-pool and usage buckets are ceilings, not payouts. Their effective share
            rises with active stake across the network and with recognized USDC volume in the epoch.
          </p>
        </Reveal>
        <Reveal className={styles.emitCard} delay={180}>
          <h3>Unused budget is burned</h3>
          <p>
            Whatever those buckets do not allocate is burned first, up to 30% of the epoch&apos;s
            scheduled emissions. Anything beyond that goes to the emissions reserve.
          </p>
        </Reveal>
        <Reveal className={styles.emitCard} delay={240}>
          <h3>Nothing outside the schedule</h3>
          <p>
            1.04 billion ANTS hard cap. No minting beyond emissions and no admin mint function.
            Epoch {epoch} ends in {timeLeft}.
          </p>
        </Reveal>
      </div>
      <Reveal className={styles.emitCtas} delay={280}>
        <Button to="/docs/recognized-usage" arrow>Recognized usage and rewards</Button>
        <Button to="/docs/lightpaper" variant="ghost">Lightpaper</Button>
        <Button to="/docs/legacy-emissions" variant="ghost">Pre-migration rewards</Button>
      </Reveal>
    </Section>
  );
}

/* ── VERIFICATIONS — ResponseAuth receipt visual ───────────────── */
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

const RECEIPT_CHECKS = [
  {label: 'signature', value: 'provider key'},
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
        <span>provider</span>
        <span>0x3fA4…9c2b</span>
      </div>
      <div className={styles.receiptMeta}>
        <span>response</span>
        <span>#48219 · deepseek-v4-flash</span>
      </div>
      {RECEIPT_CHECKS.map((row, i) => (
        <div key={row.label} className={styles.receiptCheck} style={{transitionDelay: `${250 + i * 180}ms`}}>
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

function Verifications() {
  return (
    <Section tone="ink" className={styles.verifySection}>
      <div className={styles.verifyGrid}>
        <Reveal className={`${styles.splitCopy} ${styles.verifyCopy}`}>
          <p className={`${styles.splitKicker} ${styles.verifyKicker}`}>Verification</p>
          <h2 className={`${styles.splitTitle} ${styles.verifyTitle}`}>
            Evidence,<br />not labels.
          </h2>
          <p className={`${styles.splitLead} ${styles.verifyLead}`}>
            A model name on an endpoint proves nothing. On Antseed, evidence travels with every
            response, and verification decides how much a provider&apos;s usage is worth.
          </p>
          <ul className={`${styles.splitPoints} ${styles.verifyPoints}`}>
            <li>
              <span className={styles.verifyMark} aria-hidden="true">✓</span>
              <span><strong>Signed responses</strong> prove who served which bytes. No trust in a brand required.</span>
            </li>
            <li>
              <span className={styles.verifyMark} aria-hidden="true">✓</span>
              <span><strong>Model fingerprints</strong>, shared in a public torrent-style swarm, check the model behind an endpoint against its label.</span>
            </li>
            <li>
              <span className={styles.verifyMark} aria-hidden="true">✓</span>
              <span><strong>10% of emissions</strong> are reserved for verification work, so checking providers is paid for by the protocol.</span>
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
  );
}

/* ── FAQ ───────────────────────────────────────────────────────── */
const TOKEN_FAQ = [
  {
    q: 'Do I need ANTS to use Antseed?',
    a: 'No. Buyers pay providers in USDC per request, and the desktop app also offers a card checkout in supported regions. ANTS is the reputation and reward layer on top. It is never required to buy or sell inference.',
  },
  {
    q: 'Can I buy or trade ANTS?',
    a: 'Not yet. ANTS transfers are disabled at the contract level in this phase. Enabling them is a separate, one-way action that cannot be reversed once taken. Rewards accrue to positions in the meantime.',
  },
  {
    q: 'How do providers earn ANTS?',
    a: 'By serving paid requests from a provider pool with enough epoch power. Settled, buyer-authorized USDC volume becomes recognized usage, the configured reward policies are applied, and rewards are distributed from the epoch\'s provider-pool and usage buckets. <a href="/docs/recognized-usage">How recognized usage works →</a>',
  },
  {
    q: 'What is a provider pool?',
    a: 'A pool of ANTS locked behind a provider\'s identity, represented by lANTS positions. The pool\'s power is what makes the provider eligible for recognized usage and weights its rewards. Power activates in the epoch after you lock, so lock before an epoch boundary.',
  },
  {
    q: 'What happens if I withdraw locked ANTS early?',
    a: 'Part of the principal is burned. The slash is 50% of the remaining lock fraction, floored at 5% and capped at 50%. Withdrawing 1,000 ANTS halfway through a lock returns 750. At or after lock expiry there is no slash. These are owner-configurable settings, so check the pool contract before withdrawing.',
  },
  {
    q: 'What happens to emissions nobody earns?',
    a: 'They do not become extra yield. Unallocated reward budget is burned first, up to 30% of the epoch\'s scheduled emissions, and anything beyond that goes to the emissions reserve. Anyone can call the settlement for a finished epoch.',
  },
  {
    q: 'Can paid usage earn nothing?',
    a: 'Yes. Payment and rewards answer different questions. A request can settle in USDC and still earn zero points if a reward policy excludes it. The deployed wash-trading policy zeros a provider whose proven wash volume reaches 25% of its historical total. <a href="/docs/reward-policies">Reward policies →</a>',
  },
  {
    q: 'What about rewards earned before September 10, 2026?',
    a: 'Pre-migration rewards are still claimable on the legacy contracts, and locked legacy rewards are released in steps. <a href="/docs/legacy-emissions">Legacy emissions and claims →</a>',
  },
];

function TokenFaq() {
  return (
    <section className={`${home.section} ${home.sectionTinted}`}>
      <div className={home.sectionInner}>
        <Reveal>
          <h2 className={home.faqTitle}>Frequently asked questions</h2>
        </Reveal>
        <Reveal delay={90}>
          <Faq items={TOKEN_FAQ} />
        </Reveal>
      </div>
    </section>
  );
}

/* ── PAGE ──────────────────────────────────────────────────────── */
export default function AntsToken(): JSX.Element {
  const {epoch, timeLeft, started} = useEpochCountdown();
  const live = useAntsSupply();
  // Real minted supply from the contract; the emission schedule until it loads.
  const totalSupply = live ? live.total : epoch * INITIAL_EMISSION;
  const supplyReady = started || live !== null;

  const faqLd = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: TOKEN_FAQ.map(({q, a}) => ({
      '@type': 'Question',
      name: q,
      acceptedAnswer: {'@type': 'Answer', text: a.replace(/<[^>]*>/g, '').trim()},
    })),
  };

  return (
    <Layout title="ANTS Token" description={DESCRIPTION}>
      <Head>
        <title>{TITLE}</title>
        <meta name="description" content={DESCRIPTION} />
        <meta property="og:title" content={TITLE} />
        <meta property="og:description" content={DESCRIPTION} />
        <link rel="canonical" href="https://antseed.com/ants-token/" />
        <script type="application/ld+json">{JSON.stringify(faqLd)}</script>
      </Head>

      <header className={styles.hero}>
        <div className={styles.heroInner}>
          <div className={styles.heroCopy}>
            <a href={ANTS_BASESCAN_URL} target="_blank" rel="noopener noreferrer" className={styles.heroKicker}>
              $ANTS · Base ↗
            </a>
            <h1 className={styles.heroTitle}>The token behind the trust layer.</h1>
            <p className={styles.heroSub}>
              ANTS is the native token of Antseed. Payment-backed usage and locked ANTS behind
              provider identities turn open participation into reputation buyers can verify.
            </p>
            <div className={styles.heroCtas}>
              <Button to="/providers" arrow>Become a provider</Button>
              <Button to="/blog/seller-pools-reputation-tokenomics" variant="ghost">Read the tokenomics</Button>
            </div>
            <p className={styles.heroNote}>
              <span className={styles.statusDot} aria-hidden="true" />
              Transfers not enabled yet. 1.04 billion hard cap.
            </p>
          </div>
          <div className={styles.heroDemo}>
            <TokenHeroArt />
          </div>
        </div>
      </header>

      <Section tone="tinted">
        <Reveal>
          <SectionHeader
            title="Token supply"
            lead="1.04 billion hard cap. No minting beyond emissions. No admin mint function. Supply is read live from the token contract on Base."
          />
        </Reveal>
        <Reveal>
          <SupplyBar totalSupply={totalSupply} live={live !== null} />
        </Reveal>
        <Reveal className={styles.statsGrid} delay={80}>
          <StatTile value={supplyReady ? fmtM(totalSupply) : '–'} label={live ? 'Total supply' : 'Scheduled so far'} />
          <StatTile value={supplyReady ? `${Math.round((totalSupply / MAX_SUPPLY) * 10000) / 100}%` : '–'} label="Of hard cap" />
          <StatTile value={started ? `Epoch ${epoch}` : '–'} label="Current epoch" />
          <StatTile value={timeLeft} label="Until next epoch" />
        </Reveal>
      </Section>

      <HowItWorks />
      <ProviderPools />
      <Emissions epoch={epoch} timeLeft={timeLeft} />
      <Verifications />
      <TokenFaq />

      <FinalCtaBand
        title="Help build the network."
        sub="Use the open market for real AI work, run a provider, or back one you trust with ANTS."
        caption="No account needed. No approval to sell."
        versionsLink={false}
        secondary={<Button to="/providers" variant="light" size="lg" arrow>Become a provider</Button>}
      />
    </Layout>
  );
}
