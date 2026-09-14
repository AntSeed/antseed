import type {JSX} from 'react';
import Head from '@docusaurus/Head';
import Layout from '@theme/Layout';
import styles from './agents.module.css';
import {Button, Faq, FinalCta, Reveal, Section, ArrowRight} from '../components/ui';
import {PrivacyHeroArt} from '../components/PrivacyHeroArt';
import {useLatestDesktopDownload} from '../lib/useLatestDesktopDownload';
import {useMobileGetStarted} from '../lib/useMobileGetStarted';
import {LocalhostSection, type TBlock} from '../components/LocalhostSection';
import {StepsBlock, type Step} from '../components/StepsBlock';
import {PickModelArt} from '../components/StepArt';
import {CommandChip} from '../components/CommandChip';
import {PrivacyPanel} from '../components/PrivacyPanel';
import {WhoItsFor} from '../components/WhoItsFor';
import {PricingBlock} from '../components/PricingBlock';

const TITLE = 'Private AI: no account, no email, no one in the middle | Antseed';
const DESCRIPTION =
  'Use AI without giving up who you are. No account, no email, requests route peer-to-peer, and a TEE-verified provider keeps even your prompt sealed.';

function DownloadButton({size = 'lg'}: {size?: 'md' | 'lg'}) {
  const download = useLatestDesktopDownload();
  const onGetStarted = useMobileGetStarted();
  return (
    <Button href={download.href} size={size} className="vprBtn" onClick={onGetStarted}>
      <span className="vprLabelDesktop">Download the AI VPN</span>
      <span className="vprLabelMobile">Get Started<ArrowRight /></span>
    </Button>
  );
}

function PrivacyHero() {
  return (
    <header className={styles.hero}>
      <div className={styles.heroInner}>
        <div className={styles.heroCopy}>
          <h1 className={styles.heroTitle}>
            So private, we have no idea who you are.
          </h1>
          <p className={styles.heroSub}>
            No account. No email. Your identity stays private and with a TEE-verified provider, so
            does your prompt.
          </p>
          <div className={styles.heroCtas}>
            <DownloadButton />
            <CommandChip command="npm install -g @antseed/cli" />
          </div>
          <p className={styles.heroNote}>Free models to start.</p>
        </div>
        <div className={styles.heroDemo}>
          <PrivacyHeroArt />
        </div>
      </div>
    </header>
  );
}

const PRIVACY_POINTS = [
  {icon: 'pt-shield', text: 'Anonymous by default: no account, no email, no platform key.'},
  {icon: 'pt-route', text: 'Route by privacy: set a minimum trust score, prefer TEE-verified providers.'},
  {icon: 'pt-tools', text: "Verify a provider's TEE on your own machine, against Intel's certificate chain. No special hardware needed."},
  {icon: 'pt-wallet', text: 'Pay per request in USDC. No subscription tied to your name.'},
];

/* Commands from the Verify a Provider's TEE guide */
const PRIVACY_TERMINAL_BLOCKS: TBlock[] = [
  {
    comment: '# Verification on, best-effort (the default)',
    tokens: [
      {text: '$ ', cls: 'tGreen'},
      {text: 'antseed', cls: 'tPurple'},
      {text: ' '},
      {text: 'buyer', cls: 'tBlue'},
      {text: ' '},
      {text: 'start', cls: 'tBlue'},
    ],
  },
  {
    comment: '# Strict: refuse to route unless the provider passes',
    tokens: [
      {text: '$ ', cls: 'tGreen'},
      {text: 'antseed', cls: 'tPurple'},
      {text: ' '},
      {text: 'buyer', cls: 'tBlue'},
      {text: ' '},
      {text: 'start', cls: 'tBlue'},
      {text: ' '},
      {text: '--verifiers', cls: 'tYellow'},
      {text: ' '},
      {text: 'antseed-verifier', cls: 'tOrange'},
      {text: ' '},
      {text: '--require-verifier', cls: 'tYellow'},
    ],
  },
  {
    comment: '# Find providers that advertise a TEE verifier',
    tokens: [
      {text: '$ ', cls: 'tGreen'},
      {text: 'antseed', cls: 'tPurple'},
      {text: ' '},
      {text: 'network', cls: 'tBlue'},
      {text: ' '},
      {text: 'browse', cls: 'tBlue'},
    ],
  },
  {
    comment: "# Inspect a provider's verifier before you trust it",
    tokens: [
      {text: '$ ', cls: 'tGreen'},
      {text: 'antseed', cls: 'tPurple'},
      {text: ' '},
      {text: 'network', cls: 'tBlue'},
      {text: ' '},
      {text: 'peer', cls: 'tBlue'},
      {text: ' '},
      {text: '<peer-id>', cls: 'tOrange'},
    ],
  },
];

function StaysOnYourMachine() {
  return (
    <LocalhostSection
      title={<>Everything stays<br />on your machine.</>}
      lead={
        <>
          The AI VPN runs on your computer. Your configuration, signing identity, connected-app
          setup, and routing decisions never leave your device. Each request goes peer-to-peer over
          an encrypted channel to the provider your policy picks, with no company in the middle.
        </>
      }
      points={PRIVACY_POINTS}
      blocks={PRIVACY_TERMINAL_BLOCKS}
      ctaLabel="Verify a provider's TEE"
      ctaTo="/docs/guides/verify-tee"
    />
  );
}

const PRIVACY_STEPS: Step[] = [
  {
    num: '1',
    title: 'Download the AI VPN',
    body: 'Open the AI VPN or run Antseed CLI. Your local proxy starts instantly – no account needed.',
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

function PrivacyPricing() {
  return (
    <PricingBlock
      title="The top AI models,"
      accent="at a fraction of the cost."
      lead="Antseed is a peer-to-peer open market, so competition between providers always pushes the cost down."
      downloadLabel="Download the AI VPN"
      dropTrail={false}
      osIcons={false}
    />
  );
}

function PrivacySteps() {
  return (
    <StepsBlock
      title="Think of it as a VPN for AI."
      lead={
        <>
          You install it, point your tools at it, and from then on you&apos;ve got full access to the
          open market.
        </>
      }
      steps={PRIVACY_STEPS}
      cta={
        <div className={styles.stepsCtaRow}>
          <DownloadButton size="md" />
          <CommandChip command="npm install -g @antseed/cli" size="md" />
        </div>
      }
    />
  );
}

/* FAQ — answers follow the docs FAQ and the AI VPN guide, caveats included. */
const PRIVACY_FAQ = [
  {
    q: 'Is my data private on Antseed?',
    a: 'Antseed is designed for anonymous access: no central account, no platform-issued API key, no centralized chat database. Requests route peer-to-peer, so a provider generally sees a peer or wallet rather than an identity, and TEE providers add hardware-backed confidentiality where available. It is not a promise that every piece of data is hidden from every participant: independent providers and supporting infrastructure may process the data needed to serve and settle a request, and public-chain activity is visible onchain.',
  },
  {
    q: 'Can providers see my prompts?',
    a: 'Standard providers can. TEE-verified providers cannot, because the hardware prevents it even if the operator wanted to look. When you pay for a TEE-verified request you receive a cryptographic attestation proving the enclave was genuine. <a href="/docs/guides/verify-tee">How verification works →</a>',
  },
  {
    q: 'What does a provider learn about me?',
    a: 'A pseudonymous peer or wallet identity, and the request it serves. Not your name, your email, or your account on the tool you connected. Antseed does not tell the provider who you are; who you are and what you asked are handled separately.',
  },
  {
    q: 'Does Antseed log my requests?',
    a: 'The protocol creates no central request log. Independent providers, nodes, RPC providers, analytics tools, or other infrastructure may still log or observe data, and each provider has its own data handling practices. Prefer TEE-verified providers where stronger confidentiality matters.',
  },
  {
    q: "How do I verify a provider's TEE?",
    a: 'Your buyer node checks it on your machine, against Intel’s own certificate chain, with no third party in between and no special hardware on your side. The check happens after a provider is picked and before any payment, so attestation is free. Verification is on by default and best-effort; run <code>antseed buyer start --verifiers antseed-verifier --require-verifier</code> to refuse any provider that does not pass, and the request then fails with a 502 naming the failed claims instead of being quietly routed elsewhere. <code>antseed network browse</code> shows which providers advertise a verifier. <a href="/docs/guides/verify-tee">Verify a provider’s TEE →</a>',
  },
  {
    q: 'What does a passing TEE check prove, and what does it not?',
    a: 'It proves the provider node runs inside a genuine Intel TDX enclave, that the quote was minted fresh for your request and is bound to the exact peer you are paying, so replayed or borrowed quotes fail, and it can report whether the provider’s GPUs run NVIDIA Confidential Computing. It proves the environment, not the model: whether the model is what the provider claims is a separate check, done by fingerprinting. <a href="/blog/model-verification-fingerprint-swarm">How model verification works →</a>',
  },
  {
    q: 'Is paying anonymous too?',
    a: 'There is no account to pay from. You can top up by card or Apple Pay in the AI VPN, or with USDC from the CLI. Settlement happens in USDC on Base, so payments are tied to a wallet, not to your name, and like any public chain that activity is visible onchain.',
  },
];

function PrivacyFaq() {
  return (
    <Section tone="tinted">
      <Reveal>
        <h2 className={styles.faqTitle}>Frequently asked questions</h2>
      </Reveal>
      <Reveal delay={90}>
        <Faq items={PRIVACY_FAQ} />
      </Reveal>
    </Section>
  );
}

export default function PrivacyPage(): JSX.Element {
  return (
    <Layout title="For privacy" description={DESCRIPTION}>
      <Head>
        <title>{TITLE}</title>
        <meta name="description" content={DESCRIPTION} />
        <meta property="og:title" content={TITLE} />
        <meta property="og:description" content={DESCRIPTION} />
        <link rel="canonical" href="https://antseed.com/privacy/" />
        <script type="application/ld+json">
          {JSON.stringify({
            '@context': 'https://schema.org',
            '@type': 'FAQPage',
            mainEntity: PRIVACY_FAQ.map(({q, a}) => ({
              '@type': 'Question',
              name: q,
              acceptedAnswer: {'@type': 'Answer', text: a.replace(/<[^>]+>/g, '')},
            })),
          })}
        </script>
      </Head>
      <PrivacyHero />
      <PrivacyPanel title="Privacy by design" />
      <PrivacyPricing />
      <PrivacySteps />
      <StaysOnYourMachine />
      <WhoItsFor />
      <PrivacyFaq />
      <FinalCta title="Privacy on your terms." note="Free models to start. No account, ever.">
        <DownloadButton />
      </FinalCta>
    </Layout>
  );
}
