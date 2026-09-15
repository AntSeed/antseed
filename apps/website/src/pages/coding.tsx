import type {JSX, ReactNode} from 'react';
import Head from '@docusaurus/Head';
import Link from '@docusaurus/Link';
import Layout from '@theme/Layout';
import styles from './agents.module.css';
import own from './coding.module.css';
import {Button, Faq, FinalCta, Reveal, Section, SectionHeader, ArrowRight} from '../components/ui';
import {CodingHeroArt} from '../components/CodingHeroArt';
import {useLatestDesktopDownload} from '../lib/useLatestDesktopDownload';
import {useMobileGetStarted} from '../lib/useMobileGetStarted';
import {PricingBlock} from '../components/PricingBlock';
import {LogoBar, SquareGlyph, PiGlyph, type LogoItem} from '../components/AgentsLogoBar';
import {LocalhostSection, type TBlock} from '../components/LocalhostSection';
import {StepsBlock, type Step} from '../components/StepsBlock';
import {PickModelArt} from '../components/StepArt';
import {CommandChip} from '../components/CommandChip';
import {ConnectSwitchArt} from '../components/ConnectSwitchArt';
import {Cursor} from '@lobehub/icons';

const TITLE = 'Coding apps without usage limits, at a fraction of the price | Antseed';
const DESCRIPTION =
  'Claude Code, Codex, Cursor, OpenCode, Pi. Keep the tool you like, point it at Antseed, and pay a fraction of what the same work costs on a plan. No five-hour window, no weekly cap, no sign-up.';

/* Logo band — the coding apps with an integration page */
const CODING_APPS: LogoItem[] = [
  {name: 'Claude Code', logo: '/logos/anthropic.png'},
  {name: 'Codex', logo: '/logos/openai.png'},
  {name: 'Cursor', glyph: <Cursor size={22} />},
  {name: 'OpenCode', glyph: SquareGlyph},
  {name: 'Pi', glyph: PiGlyph},
];

/* Connect cards — one per coding app, linking to its setup guide */
type ConnectCard = {name: string; logo?: string; glyph?: ReactNode; to: string};

const CONNECT_CARDS: ConnectCard[] = [
  {name: 'Claude Code', logo: '/logos/anthropic.png', to: '/integrations/claude-code'},
  {name: 'Codex', logo: '/logos/openai.png', to: '/integrations/codex'},
  {name: 'Cursor', glyph: <Cursor size={24} />, to: '/docs/guides/public-tunnels#use-it-with-cursor'},
  {name: 'OpenCode', glyph: SquareGlyph, to: '/integrations/opencode'},
  {name: 'Pi', glyph: PiGlyph, to: '/integrations/pi'},
];

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

function CodingHero() {
  return (
    <header className={styles.hero}>
      <div className={styles.heroInner}>
        <div className={styles.heroCopy}>
          <h1 className={styles.heroTitle}>
            Coding, without the usage limits.
          </h1>
          <p className={styles.heroSub}>
            Works with your favorite coding tools. Pay a fraction of the cost, with no hourly, weekly,
            or monthly limits.
          </p>
          <div className={styles.heroCtas}>
            <DownloadButton />
            <CommandChip command="npm install -g @antseed/cli" />
          </div>
          <p className={styles.heroNote}>Free models to start.</p>
        </div>
        <div className={styles.heroDemo}>
          <CodingHeroArt />
        </div>
      </div>
    </header>
  );
}

function CodingPricing() {
  return (
    <PricingBlock
      title="Frontier models,"
      accent="at a fraction of the plan price."
      lead="Pay per request at the lowest market price – no usage limits or subscription commitments."
      downloadLabel="Download the AI VPN"
      osIcons={false}
    />
  );
}

function ConnectApps() {
  return (
    <Section tone="tinted" id="connect">
      <Reveal>
        <SectionHeader
          title="Connect your favorite coding app."
          lead="One command wraps the tool with the right provider for that run. Everything else stays the way it was."
        />
      </Reveal>
      <div className={own.connectSplit}>
        <Reveal className={own.appList} delay={40}>
          {CONNECT_CARDS.map((c) => (
            <Link key={c.name} to={c.to} className={own.appRow} aria-label={`${c.name} setup guide`}>
              <span className={own.appMark}>
                {c.logo ? <img src={c.logo} alt="" aria-hidden="true" /> : c.glyph}
              </span>
              <span className={own.appName}>{c.name}</span>
              <span className={own.appLink}>
                Setup guide
                <ArrowRight size={16} />
              </span>
            </Link>
          ))}
        </Reveal>
        <Reveal className={own.artCol} delay={100}>
          <ConnectSwitchArt layout="stack" />
        </Reveal>
      </div>
    </Section>
  );
}

const CODING_POINTS = [
  {icon: 'pt-tools', text: 'Keep your tool. Swap the model and provider underneath.'},
  {icon: 'pt-shield', text: 'Fallback the moment a provider is slow, expensive, or down.'},
  {icon: 'pt-route', text: 'Route by price, speed, reputation, or privacy.'},
  {icon: 'pt-wallet', text: 'Pay per request, straight to the provider. No subscription.'},
];

/* Commands from the integration guides: antseed claude / codex / opencode */
const CODING_TERMINAL_BLOCKS: TBlock[] = [
  {
    comment: '# Run Claude Code through Antseed',
    tokens: [
      {text: '$ ', cls: 'tGreen'},
      {text: 'antseed', cls: 'tPurple'},
      {text: ' '},
      {text: 'claude', cls: 'tBlue'},
    ],
  },
  {
    comment: '# Codex, pinned to one model for this run',
    tokens: [
      {text: '$ ', cls: 'tGreen'},
      {text: 'antseed', cls: 'tPurple'},
      {text: ' '},
      {text: 'codex', cls: 'tBlue'},
      {text: ' '},
      {text: '--model', cls: 'tYellow'},
      {text: ' '},
      {text: 'deepseek-v4-flash', cls: 'tOrange'},
    ],
  },
  {
    comment: '# OpenCode on an open model',
    tokens: [
      {text: '$ ', cls: 'tGreen'},
      {text: 'antseed', cls: 'tPurple'},
      {text: ' '},
      {text: 'opencode', cls: 'tBlue'},
      {text: ' '},
      {text: '--model', cls: 'tYellow'},
      {text: ' '},
      {text: 'gpt-oss-120b', cls: 'tOrange'},
    ],
  },
];

function PointAtLocalhost() {
  return (
    <LocalhostSection
      title={<>Point your tools<br />at localhost.</>}
      lead={
        <>
          Antseed exposes an OpenAI- and Anthropic-compatible API on your computer at{' '}
          <code className={styles.inlineCode}>localhost:8377</code>, so Claude Code, Codex, or
          OpenCode connects with one command and keeps every project and chat. Each request routes
          peer-to-peer to the provider your policy picks, with no company in the middle.
        </>
      }
      points={CODING_POINTS}
      blocks={CODING_TERMINAL_BLOCKS}
      ctaLabel="Coding app guides"
      ctaTo="/integrations"
    />
  );
}

const CODING_STEPS: Step[] = [
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

function CodingSteps() {
  return (
    <StepsBlock
      title="Think of it as a VPN for AI."
      lead={
        <>
          You install it, point your tools at it, and from then on you&apos;ve got full access to the
          open market.
        </>
      }
      steps={CODING_STEPS}
      cta={
        <div className={styles.stepsCtaRow}>
          <DownloadButton size="md" />
          <CommandChip command="npm install -g @antseed/cli" size="md" />
        </div>
      }
    />
  );
}

/* FAQ — grounded in the integration guides, the docs FAQ, and the
   Claude Code pricing post. */
const CODING_FAQ = [
  {
    q: 'Do I have to cancel my Claude or ChatGPT plan?',
    a: 'No. Keep it if it earns its price. When the plan’s window runs out, launch the same tool through Antseed and keep working, then switch back whenever you like. Nothing about your projects or settings changes between the two.',
  },
  {
    q: 'Are there usage limits?',
    a: 'No five-hour window, no weekly or monthly cap. You pay per request from your credits and keep going as long as there are credits to spend. Top up in the AI VPN by card or Apple Pay, or with USDC from the CLI using <code>antseed buyer deposit</code>.',
  },
  {
    q: 'Is it the same model I get on the plan?',
    a: 'The live board lists what providers serve, including frontier models, each at the provider’s own price. Every response is signed by the provider and matched against the model’s fingerprint; providers who serve something else lose reputation and stop getting routed. <a href="/docs/guides/verify-tee">How verification works →</a>',
  },
  {
    q: 'Do I need the desktop app, or is the CLI enough?',
    a: 'The CLI is enough. <code>npm install -g @antseed/cli</code>, then <code>antseed buyer start</code> runs the proxy and <code>antseed claude</code>, <code>antseed codex</code>, or <code>antseed opencode</code> launch your tool through it. The AI VPN desktop app adds a model picker, an Apps view that launches installed tools, and card or Apple Pay top-ups. <a href="/docs/install#cli">Install the CLI →</a>',
  },
  {
    q: 'Does Cursor work?',
    a: "Yes, through a public endpoint. Some Cursor requests come from Cursor's own servers, which cannot reach your <code>localhost</code>, so publish an authenticated HTTPS endpoint from the AI VPN, then in Cursor's model settings paste the Antseed key as the OpenAI API key and the endpoint as the OpenAI base URL. <a href=\"/docs/guides/public-tunnels#use-it-with-cursor\">Cursor setup →</a>",
  },
  {
    q: 'Does my tool need an API key?',
    a: 'No account and no real key. The local endpoint does not validate one, but most tools want a non-empty value, so use a placeholder like <code>antseed</code>. The <code>antseed claude</code>, <code>codex</code>, and <code>opencode</code> wrappers set this for you.',
  },
  {
    q: 'How do I pick which model my tool uses?',
    a: 'Leave it on auto and every request goes to the cheapest verified provider for the model your tool asks for. To pin a model for one run, pass <code>--model &lt;id&gt;</code> to the wrapper, using an id from <code>curl http://localhost:8377/v1/models</code>. To pin a specific provider, use <code>&lt;peerId&gt;@&lt;model&gt;</code>.',
  },
  {
    q: 'Can a provider see my code?',
    a: 'Requests route peer-to-peer with no platform in the middle, so a provider sees a peer and a wallet, not an account. A standard provider can read the prompt it serves; a TEE-verified provider cannot, and you get an attestation to prove it. <a href="/docs/guides/verify-tee">Verify a provider’s TEE →</a>',
  },
];

function CodingFaq() {
  return (
    <Section tone="tinted">
      <Reveal>
        <h2 className={styles.faqTitle}>Frequently asked questions</h2>
      </Reveal>
      <Reveal delay={90}>
        <Faq items={CODING_FAQ} />
      </Reveal>
    </Section>
  );
}

export default function CodingPage(): JSX.Element {
  return (
    <Layout title="For coding apps" description={DESCRIPTION}>
      <Head>
        <title>{TITLE}</title>
        <meta name="description" content={DESCRIPTION} />
        <meta property="og:title" content={TITLE} />
        <meta property="og:description" content={DESCRIPTION} />
        <link rel="canonical" href="https://antseed.com/coding/" />
        <script type="application/ld+json">
          {JSON.stringify({
            '@context': 'https://schema.org',
            '@type': 'FAQPage',
            mainEntity: CODING_FAQ.map(({q, a}) => ({
              '@type': 'Question',
              name: q,
              acceptedAnswer: {'@type': 'Answer', text: a.replace(/<[^>]+>/g, '')},
            })),
          })}
        </script>
      </Head>
      <CodingHero />
      <LogoBar items={CODING_APPS} ariaLabel="Coding apps that work with Antseed" />
      <CodingPricing />
      <ConnectApps />
      <PointAtLocalhost />
      <CodingSteps />
      <CodingFaq />
      <FinalCta title="Code on your terms.">
        <DownloadButton />
      </FinalCta>
    </Layout>
  );
}
