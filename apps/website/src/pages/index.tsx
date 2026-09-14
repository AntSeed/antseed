import {useEffect, useRef, useState, type MutableRefObject, type RefObject, type ReactNode, type CSSProperties, type JSX} from 'react';
import Head from '@docusaurus/Head';
import Link from '@docusaurus/Link';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import Layout from '@theme/Layout';
import styles from './index.module.css';
import {useLatestDesktopDownload} from '../lib/useLatestDesktopDownload';
import {AllVersionsLink} from '../lib/AllVersionsLink';
import {useMobileGetStarted} from '../lib/useMobileGetStarted';
import {useNetworkStats} from '../lib/useNetworkStats';
import {PickModelArt} from '../components/StepArt';
import {PricingBlock} from '../components/PricingBlock';
import {LocalhostSection, type TBlock} from '../components/LocalhostSection';
import {StepsBlock} from '../components/StepsBlock';
import {PrivacyPanel} from '../components/PrivacyPanel';
import {WhoItsFor} from '../components/WhoItsFor';
import {Button, Faq, Reveal, SectionHeader, ArrowRight} from '../components/ui';
import {HeroDemo} from '../components/HeroDemo';
import {HeroDotCanvas, DownloadCta, HeroStatsRow, StackedHero} from '../components/HomeHero';
import {LogoMarquee} from '../components/LogoMarquee';
import {OwnedByNoOne} from '../components/NetworkPanel';
import {SellSection} from '../components/SellSection';
import {HOME_FAQ} from '../components/homeFaq';
import {FinalCtaBand} from '../components/FinalCtaBand';


/* Layout experiment: 'stacked' is the shipped centred hero; 'split' puts the
   copy on the left and the AI VPN demo (compact scene) on the right on wide
   viewports, collapsing back to stacked under 997px. */
const HERO_LAYOUT: 'stacked' | 'split' = 'split';

function Hero() {
  const demoRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef(0);
  const shutdownRef = useRef(0);

  if (HERO_LAYOUT !== 'split') {
    return <StackedHero title="Run your agents on your terms" caption="Start for free. Keep using your tools." />;
  }

  return (
    <header className={`${styles.hero} ${styles.heroSplit}`}>
      <HeroDotCanvas frameRef={frameRef} shutdownRef={shutdownRef} originRef={demoRef} compact />
      <div className={`${styles.heroInner} ${styles.heroSplitInner}`}>
        <div className={styles.heroCopy}>
          <h1 className={styles.heroTitle}>
            Run your agents
            <br className={styles.heroTitleBreak} />
            {' '}on your terms
          </h1>
          <p className={styles.heroSubStatic}>
            Save on every AI model. No usage limits, no middleman, always anonymous.
          </p>
          <DownloadCta versionsLink={false} />
        </div>
        <div className={`${styles.demoFrame} ${styles.demoFrameSplit}`} ref={demoRef}>
          <HeroDemo frameRef={frameRef} shutdownRef={shutdownRef} compact />
        </div>
        <HeroStatsRow />
      </div>
    </header>
  );
}


/* ============================================================
   PRICING — the same models, a fraction of the price
   ============================================================ */
/* Drop-trail dots — spaced to match the dashed line asset's 8px pitch
   (dots at y=3..91), each lighting up in sequence top-to-bottom. */
function PricingSection() {
  return (
    <PricingBlock
      title="The top AI models,"
      accent="at a fraction of the cost."
      lead="Antseed is a peer-to-peer open market, so competition between providers always pushes the cost down."
    />
  );
}

/* ============================================================
   PRIVATE BY DESIGN
   ============================================================ */
function PrivateByDesign() {
  return <PrivacyPanel title="So private, we have no idea who you are." />;
}

/* ============================================================
   WHO IT'S FOR — three personas, their problem in their words,
   and what changes. Model count reuses the hero stat so the two
   never drift apart.
   ============================================================ */

/* ============================================================
   OWNED BY NO ONE — decentralization cards
   ============================================================ */



/* ============================================================
   POINT YOUR TOOLS AT LOCALHOST — dark terminal section
   ============================================================ */
const HOME_POINTS = [
  {icon: 'pt-tools', text: 'Keep your tools. Swap the providers underneath.'},
  {icon: 'pt-shield', text: 'Fallback the moment a provider is slow, expensive, or down.'},
  {icon: 'pt-route', text: 'Route by price, speed, reputation, or privacy.'},
  {icon: 'pt-wallet', text: 'Pay per request, straight to the provider. No subscription.'},
];

const HOME_TERMINAL_BLOCKS: TBlock[] = [
  {
    comment: '# Route Claude Code through Antseed',
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

/* ============================================================
   3 STEPS
   ============================================================ */
/* The provider count streams from Antscan via useNetworkStats, same source as
   the hero stat, so step 2 tracks the network instead of drifting. */
const STEPS = [
  {
    num: '1',
    title: 'Download the AI VPN',
    body: 'Run it on Mac, Windows, or Linux. No account needed.',
    illo: <img src="/img/home/illo-easy-setup.svg" alt="" aria-hidden="true" />,
  },
  {
    num: '2',
    title: 'Connect your favorite app',
    body: 'Point Claude Code, Codex, Hermes, OpenClaw or any tool you already use at one local address.',
    illo: <img src="/img/home/illo-tools-unchanged.svg" alt="" aria-hidden="true" />,
  },
  {
    num: '3',
    title: 'Pick your model',
    body: 'Choose free or frontier models, from more than 700 models. Route to the cheapest verified provider or pin the one you want.',
    illo: <PickModelArt />,
  },
];

function StepsSection() {
  return (
    <StepsBlock
      title="Think of it as a VPN for AI."
      lead={
        <>
          You install it, point your tools at it, and from then on you&apos;ve got full access to the
          open market.
        </>
      }
      steps={STEPS}
      cta={<DownloadCta size="md" versionsLink={false} />}
    />
  );
}

/* ============================================================
   ANYONE CAN SELL INTELLIGENCE
   ============================================================ */


/* ============================================================
   FAQ — fair questions
   ============================================================ */

function FAQSection() {
  return (
    <section className={`${styles.section} ${styles.sectionTinted}`}>
      <div className={styles.sectionInner}>
        <Reveal>
          <h2 className={styles.faqTitle}>Frequently asked questions</h2>
        </Reveal>
        <Reveal delay={90}>
          <Faq items={HOME_FAQ} />
        </Reveal>
      </div>
    </section>
  );
}

/* ============================================================
   FINAL CTA
   ============================================================ */


/* ============================================================
   PAGE
   ============================================================ */
export default function Home(): JSX.Element {
  const {siteConfig} = useDocusaurusContext();

  const faqLd = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: HOME_FAQ.map(({q, a}) => ({
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
    name: 'Antseed',
    url: 'https://antseed.com/',
    logo: 'https://antseed.com/logo.svg',
    description:
      'Antseed is a decentralized peer-to-peer marketplace for AI inference. Providers compete on price to run any AI model, with no central account.',
    sameAs: [
      'https://github.com/AntSeed/antseed',
      'https://x.com/antseed',
      'https://t.me/antseed',
    ],
  };

  return (
    <Layout
      title={siteConfig.tagline}
      description="Run your agents on your terms. Every model, no middleman. Anonymous, best price, works with the tools you already use. Owned by no one."
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
        <meta property="og:title" content="Run your agents on your terms" />
        <meta
          property="og:description"
          content="Antseed lets you run your agents on your terms. Every model, no middleman. Anonymous. Best price. Works with the tools you already use. Owned by no one. Available to everyone."
        />
        <script type="application/ld+json">{JSON.stringify(orgLd)}</script>
        <script type="application/ld+json">{JSON.stringify(faqLd)}</script>
      </Head>

      <Hero />
      <LogoMarquee />
      <PricingSection />
      <StepsSection />
      <PrivateByDesign />
      <WhoItsFor />
      <OwnedByNoOne />
      <LocalhostSection
        title={<>Point your tools<br />at localhost.</>}
        lead={
          <>
            Antseed exposes OpenAI and Anthropic compatible APIs at{' '}
            <code className={styles.inlineCode}>localhost:8377</code>, then routes each request
            across the open provider market by price, latency, reputation, capability, or privacy.
            The router runs on your computer, not on a hosted service, so your requests never pass
            through anyone else&apos;s servers.
          </>
        }
        points={HOME_POINTS}
        blocks={HOME_TERMINAL_BLOCKS}
        ctaLabel="Explore integrations"
        ctaTo="/integrations"
      />
      <div className={styles.stepsSellWrap}>
        <SellSection />
      </div>
      <FAQSection />
      <FinalCtaBand />
    </Layout>
  );
}
