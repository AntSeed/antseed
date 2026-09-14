import type {JSX} from 'react';
import Head from '@docusaurus/Head';
import Link from '@docusaurus/Link';
import Layout from '@theme/Layout';
import styles from './index.module.css';
import own from './network.module.css';
import {ArrowRight, Button, Faq, Reveal, Section, SectionHeader} from '../components/ui';
import {StackedHero} from '../components/HomeHero';
import {LogoMarquee} from '../components/LogoMarquee';
import {OwnedByNoOne} from '../components/NetworkPanel';
import {PricingBlock} from '../components/PricingBlock';
import {SellSection} from '../components/SellSection';
import {HOME_FAQ} from '../components/homeFaq';
import {FinalCtaBand} from '../components/FinalCtaBand';
import {PrivacyPanel} from '../components/PrivacyPanel';
import {useAntsSupply} from '../lib/useAntsSupply';
import {INITIAL_EMISSION, MAX_SUPPLY, useEpochCountdown} from '../lib/useEpochCountdown';

const TITLE = 'The Open Market for AI Inference | Antseed';
const DESCRIPTION =
  'Antseed is a peer-to-peer network for AI inference. Providers set their own prices, buyers route to the best one, and payments settle onchain with no company in the middle.';

/* The original homepage hero lines */
const HERO_PHRASES = ['Every Model, No Middleman.', 'Anonymous and Always On.', 'Self hosted.'];

/* Network-side questions from the shared homepage FAQ */
const NETWORK_FAQ = HOME_FAQ.filter((item) =>
  [
    'How is this different from OpenRouter?',
    'Are the models offered the "real" models?',
    'What happens when LLMs become so good that anyone can do anything?',
    "Isn't this just like P2P file sharing? Netflix killed that.",
    'Is Antseed built for agents specifically?',
    'How can a provider offer AI models below lab price?',
    'Why would a provider use Antseed instead of just building their own API?',
  ].includes(item.q),
);

function NetworkPricing() {
  return (
    <PricingBlock
      title="The top AI models,"
      accent="at a fraction of the cost."
      lead="Antseed is a peer-to-peer open market, so competition between providers always pushes the cost down."
    />
  );
}

/* Token — copy from the ANTS token page (supply, seller pools). */
const TOKEN_POINTS = [
  {
    title: 'Payment-backed',
    body: 'Only settled, buyer-authorized volume counts toward a provider’s reputation, never self-reported claims.',
  },
  {
    title: 'Stake-weighted',
    body: 'ANTS locked behind a provider’s identity is durable backing that routers and buyers can inspect before they route.',
  },
  {
    title: 'Capped rewards',
    body: 'Emissions follow recognized usage inside capped ranges, and unused budget can be burned.',
  },
];

const fmtM = (n: number) => `${(n / 1e6).toLocaleString('en-US', {maximumFractionDigits: 1})}M`;

/* Live supply strip: totalSupply() from the ANTS contract on Base, with the
   emission schedule as the fallback until the read lands. */
function SupplyStrip() {
  const {epoch, timeLeft, started} = useEpochCountdown();
  const live = useAntsSupply();
  const total = live ? live.total : epoch * INITIAL_EMISSION;
  const ready = started || live !== null;
  const pct = (total / MAX_SUPPLY) * 100;
  return (
    <Reveal className={own.supply} delay={200}>
      <div className={own.supplyTop}>
        <span>
          <strong>{ready ? fmtM(total) : '–'}</strong> {live ? 'minted' : 'scheduled'}
          {live && <i className={own.liveDot} aria-hidden="true" />}
        </span>
        <span>
          <strong>{ready ? `${pct.toFixed(1)}%` : '–'}</strong> of the 1.04B hard cap
        </span>
        <span>
          Epoch <strong>{started ? epoch : '–'}</strong> · next in <strong>{timeLeft}</strong>
        </span>
      </div>
      <div className={own.supplyTrack} aria-hidden="true">
        <div className={own.supplyFill} style={{width: `${Math.max(pct, 0.3)}%`}} />
      </div>
      <p className={own.supplyNote}>No minting beyond emissions. No admin mint function. Supply read live from the token contract on Base.</p>
    </Reveal>
  );
}

function TokenSection() {
  return (
    <Section tone="tinted">
      <Reveal>
        <SectionHeader
          kicker="$ANTS"
          title="The token behind the trust layer."
          lead="ANTS is the native token of Antseed and its reputation layer: real, payment-backed usage and locked ANTS behind provider identities turn open participation into reputation buyers can verify."
        />
      </Reveal>
      <div className={own.tokenGrid}>
        {TOKEN_POINTS.map((t, i) => (
          <Reveal key={t.title} className={own.tokenCard} delay={i * 80}>
            <Link to="/ants-token" className={own.tokenCardLink}>
              <h3>{t.title}</h3>
              <p>{t.body}</p>
              <span className={own.tokenCardMore}>
                About the token
                <ArrowRight size={16} />
              </span>
            </Link>
          </Reveal>
        ))}
      </div>
      <SupplyStrip />
      <Reveal className={own.tokenCtas} delay={240}>
        <Button to="/ants-token" arrow>About the ANTS token</Button>
        <Button to="/docs/lightpaper" variant="ghost">Lightpaper</Button>
      </Reveal>
    </Section>
  );
}

function NetworkFaq() {
  return (
    <section className={`${styles.section} ${styles.sectionTinted}`}>
      <div className={styles.sectionInner}>
        <Reveal>
          <h2 className={styles.faqTitle}>Frequently asked questions</h2>
        </Reveal>
        <Reveal delay={90}>
          <Faq items={NETWORK_FAQ} />
        </Reveal>
      </div>
    </section>
  );
}

export default function NetworkPage(): JSX.Element {
  return (
    <Layout title="The network" description={DESCRIPTION}>
      <Head>
        <title>{TITLE}</title>
        <meta name="description" content={DESCRIPTION} />
        <meta property="og:title" content={TITLE} />
        <meta property="og:description" content={DESCRIPTION} />
        <link rel="canonical" href="https://antseed.com/network/" />
        <script type="application/ld+json">
          {JSON.stringify({
            '@context': 'https://schema.org',
            '@type': 'FAQPage',
            mainEntity: NETWORK_FAQ.map(({q, a}) => ({
              '@type': 'Question',
              name: q,
              acceptedAnswer: {'@type': 'Answer', text: a.replace(/<[^>]+>/g, '')},
            })),
          })}
        </script>
      </Head>
      <StackedHero
        title="The Open Market for AI Inference"
        phrases={HERO_PHRASES}
        caption="Start for free. Keep using your tools."
      />
      <LogoMarquee />
      <NetworkPricing />
      <OwnedByNoOne />
      <PrivacyPanel title="So private, we have no idea who you are." />
      <TokenSection />
      <SellSection />
      <NetworkFaq />
      <FinalCtaBand
        title="Buy, sell, or build on the open market."
        sub="Use it for your own AI work, or become a provider and get paid for every request you serve."
        caption="No account needed. No approval to sell."
        versionsLink={false}
        secondary={
          <Button to="/providers" variant="light" size="lg" arrow>
            Become a provider
          </Button>
        }
      />
    </Layout>
  );
}
