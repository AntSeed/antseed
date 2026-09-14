import type {JSX, ReactNode} from 'react';
import Head from '@docusaurus/Head';
import Link from '@docusaurus/Link';
import Layout from '@theme/Layout';
import styles from './agents.module.css';
import {Button, Faq, FinalCta, Reveal, Section, SectionHeader, ArrowRight} from '../components/ui';
import {AgentsHeroArt} from '../components/AgentsHeroArt';
import {useLatestDesktopDownload} from '../lib/useLatestDesktopDownload';
import {useMobileGetStarted} from '../lib/useMobileGetStarted';
import {PricingBlock} from '../components/PricingBlock';
import {AgentsLogoBar} from '../components/AgentsLogoBar';
import {LocalhostSection, type TBlock} from '../components/LocalhostSection';
import {StepsBlock, type Step} from '../components/StepsBlock';
import {PickModelArt} from '../components/StepArt';
import {CommandChip} from '../components/CommandChip';

const TITLE = 'Run AI agents for a fraction of the price | Antseed';
const DESCRIPTION =
  'Hermes, OpenClaw, Codex, OpenCode, your own. Every request goes to the cheapest verified provider. No usage caps, no sign-up, no one who can shut you off.';

/* Section 3 — what changes */
const SquareGlyph = (
  <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
    <path fillRule="evenodd" clipRule="evenodd" d="M13 7H7v6h6V7zm3 9H4V4h12v12z" />
  </svg>
);

const PiGlyph = (
  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <path d="M3.5 6h13" />
    <path d="M6.5 6v9" />
    <path d="M13.5 6v6.5c0 1.5.8 2.5 2 2.5" />
  </svg>
);

/* Section 3 — connect your favorite agent. One card per supported
   integration: logo, one line, link to the full setup guide. */
type ConnectCard = {name: string; logo?: string; glyph?: ReactNode; body: string; to: string};

const CONNECT_CARDS: ConnectCard[] = [
  {name: 'Claude Code', logo: '/logos/anthropic.png', body: "Point Anthropic's CLI at one local address. Same projects, same chats.", to: '/integrations/claude-code'},
  {name: 'Codex', logo: '/logos/openai.png', body: "Run OpenAI's Codex CLI through Antseed with a single command.", to: '/integrations/codex'},
  {name: 'Hermes', logo: '/logos/nousresearch.svg', body: 'Register Antseed as a custom provider in your Hermes config.', to: '/integrations/hermes'},
  {name: 'OpenClaw', logo: '/logos/openclaw.svg', body: "Add Antseed to OpenClaw's provider catalog and run any model.", to: '/integrations/openclaw'},
  {name: 'OpenCode', glyph: SquareGlyph, body: 'Launch OpenCode through Antseed and pick any model on the network.', to: '/integrations/opencode'},
  {name: 'Pi', glyph: PiGlyph, body: 'Use the Antseed buyer proxy as a model provider in Pi.', to: '/integrations/pi'},
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

function AgentsHero() {
  return (
    <header className={styles.hero}>
      <div className={styles.heroInner}>
        <div className={styles.heroCopy}>
          <h1 className={styles.heroTitle}>
            Run agents freely, for way less.
          </h1>
          <p className={styles.heroSub}>
            Hermes, OpenClaw, Codex, OpenCode, or your own – for a fraction of the cost.
          </p>
          <div className={styles.heroCtas}>
            <DownloadButton />
            <CommandChip command="npm install -g @antseed/cli" />
          </div>
          <p className={styles.heroNote}>Free models to start. Desktop app or CLI, no account either way.</p>
        </div>
        <div className={styles.heroDemo}>
          <AgentsHeroArt />
        </div>
      </div>
    </header>
  );
}

function WishAndBill() {
  return (
    <PricingBlock
      title="Run your agents all day,"
      accent="for a fraction of the cost."
      lead="Agents make hundreds of context-heavy calls. Antseed routes each one to the cheapest provider in real time."
      downloadLabel="Download the AI VPN"
      osIcons={false}
    />
  );
}

function ConnectAgents() {
  return (
    <Section tone="tinted" id="connect">
      <Reveal>
        <SectionHeader
          title="Connect your favorite agent."
          lead="Access the open market without changing how anything works."
        />
      </Reveal>
      <div className={styles.connectGrid}>
        {CONNECT_CARDS.map((c, i) => (
          <Reveal key={c.name} className={styles.connectCard} delay={i * 60}>
            <Link to={c.to} className={styles.connectCardLink} aria-label={`${c.name} setup guide`}>
              <span className={styles.connectLogo}>
                {c.logo ? <img src={c.logo} alt="" aria-hidden="true" /> : c.glyph}
              </span>
              <h3>{c.name}</h3>
              <p>{c.body}</p>
              <span className={styles.connectMore}>
                Setup guide
                <ArrowRight size={16} />
              </span>
            </Link>
          </Reveal>
        ))}
      </div>
      <Reveal className={styles.connectAny} delay={120}>
        <span>Any OpenAI-compatible agent works too. Point it at <code>http://localhost:8377/v1</code>.</span>
        <Link to="/docs/guides/agents" className={styles.setupLink}>
          Docs
          <ArrowRight size={16} />
        </Link>
      </Reveal>
    </Section>
  );
}

const AGENT_POINTS = [
  {icon: 'pt-tools', text: 'Keep your agent. Swap the providers underneath.'},
  {icon: 'pt-shield', text: 'Fallback the moment a provider is slow, expensive, or down.'},
  {icon: 'pt-route', text: 'Route every call by price, speed, reputation, or privacy.'},
  {icon: 'pt-wallet', text: 'Pay per request, straight to the provider. No subscription.'},
];

const AGENT_TERMINAL_BLOCKS: TBlock[] = [
  {
    comment: '# Point any agent at the local endpoint',
    tokens: [
      {text: '$ ', cls: 'tGreen'},
      {text: 'export', cls: 'tPurple'},
      {text: ' '},
      {text: 'ANTSEED_BASE_URL', cls: 'tYellow'},
      {text: '='},
      {text: '"http://127.0.0.1:8377/v1"', cls: 'tGreen'},
      {text: '\n'},
      {text: '$ ', cls: 'tGreen'},
      {text: 'export', cls: 'tPurple'},
      {text: ' '},
      {text: 'ANTSEED_API_KEY', cls: 'tYellow'},
      {text: '='},
      {text: '"antseed-p2p"', cls: 'tGreen'},
    ],
  },
  {
    comment: '# Point OpenClaw at Antseed',
    tokens: [
      {text: '$ ', cls: 'tGreen'},
      {text: 'openclaw', cls: 'tPurple'},
      {text: ' '},
      {text: 'models', cls: 'tBlue'},
      {text: ' '},
      {text: 'set', cls: 'tBlue'},
      {text: ' '},
      {text: '"antseed/kimi-k2.6"', cls: 'tOrange'},
    ],
  },
  {
    comment: '# List the models you can route to',
    tokens: [
      {text: '$ ', cls: 'tGreen'},
      {text: 'curl', cls: 'tPurple'},
      {text: ' '},
      {text: '"$ANTSEED_BASE_URL/models"', cls: 'tBlue'},
      {text: ' \\\n  '},
      {text: '-H', cls: 'tYellow'},
      {text: ' '},
      {text: '"Authorization: Bearer $ANTSEED_API_KEY"', cls: 'tGreen'},
    ],
  },
];

function PointAtLocalhost() {
  return (
    <LocalhostSection
      title={<>Point your agents<br />at localhost.</>}
      lead={
        <>
          Antseed exposes an OpenAI- and Anthropic-compatible API on your computer at{' '}
          <code className={styles.inlineCode}>127.0.0.1:8377/v1</code>, so Hermes, OpenClaw, or your
          own agent connects as a custom provider with no code changes. Each request routes
          peer-to-peer to the provider your policy picks, with no company in the middle.
        </>
      }
      points={AGENT_POINTS}
      blocks={AGENT_TERMINAL_BLOCKS}
      ctaLabel="Agent setup guides"
      ctaTo="/docs/guides/agents"
    />
  );
}


/* Steps — the homepage "3 steps" block, framed for an agent setup
   (mirrors the Connect Agents guide: start the router, add a provider, run). */
const AGENT_STEPS: Step[] = [
  {
    num: '1',
    title: 'Start the buyer proxy',
    body: 'Open the AI VPN or run Antseed CLI. Your local proxy starts instantly – no account needed.',
    illo: <img src="/img/home/illo-easy-setup.svg" alt="" aria-hidden="true" />,
  },
  {
    num: '2',
    title: 'Add Antseed as a provider',
    body: 'Point your agent to the local endpoint. One config change, and everything works as before.',
    illo: <img src="/img/home/illo-tools-unchanged.svg" alt="" aria-hidden="true" />,
  },
  {
    num: '3',
    title: 'Let it run',
    body: 'Use free or frontier models. Every call gets the best price.',
    illo: <PickModelArt />,
  },
];

function AgentSteps() {
  return (
    <StepsBlock
      title={
        <>
          <span className={styles.titleAccent}>3 steps</span> to run your agent on your terms.
        </>
      }
      lead="Keep your tools and setup. One local endpoint connects your agent to the entire market."
      steps={AGENT_STEPS}
      cta={
        <div className={styles.stepsCtaRow}>
          <DownloadButton size="md" />
          <CommandChip command="npm install -g @antseed/cli" size="md" />
        </div>
      }
    />
  );
}

/* FAQ — agent-specific questions, grounded in the Connect Agents guide and
   the docs FAQ. Answers may carry inline links. */
const AGENT_FAQ = [
  {
    q: 'Do I need the desktop app, or is the CLI enough?',
    a: 'The CLI is enough. <code>npm install -g @antseed/cli</code>, then <code>antseed buyer start</code> runs the proxy your agent talks to and <code>antseed buyer deposit</code> funds it with USDC, on any machine. The AI VPN desktop app adds a model picker, card and Apple Pay top-ups, and the Agents view for publishing an authenticated public endpoint. <a href="/docs/install#cli">Install the CLI →</a>',
  },
  {
    q: 'Does my agent need an account or API key?',
    a: 'No account, whether you run the AI VPN or <code>antseed buyer start</code>. The local endpoint does not validate a key, but most agent SDKs want a non-empty value, so use a placeholder like <code>antseed-p2p</code>. Only a public endpoint you publish from the Agents view uses a real, generated key.',
  },
  {
    q: 'Which agents work with Antseed?',
    a: 'Anything that speaks the OpenAI or Anthropic API: Hermes, OpenClaw, Claude Code, Codex, OpenCode, Pi, or your own. Hermes and OpenClaw have maintained setup skills; Claude Code, Codex, and OpenCode also have CLI wrappers (<code>antseed claude</code>, <code>antseed codex</code>, <code>antseed opencode</code>). Any other agent uses its custom provider settings with the base URL and key above. <a href="/docs/guides/agents">Connect Agents guide →</a>',
  },
  {
    q: 'My agent runs on a server. Can it still use Antseed?',
    a: "Yes. The simplest way is to install the CLI on that server and run <code>antseed buyer start</code> next to the agent, so it talks to <code>127.0.0.1:8377</code> as usual. If the agent must reach a router on a different machine, publish an authenticated endpoint from the AI VPN's Agents view, using ngrok or Cloudflare, and swap in the URL and key it shows. <a href=\"/docs/guides/public-tunnels\">Public HTTPS tunnels guide →</a>",
  },
  {
    q: 'Are there usage limits?',
    a: 'No caps and no daily, weekly, or monthly quota. Your agent pays per request from your credits and keeps going as long as there are credits to spend. Top up in the AI VPN by card or Apple Pay, or with USDC from the CLI using <code>antseed buyer deposit</code>.',
  },
  {
    q: 'How does Antseed choose the provider for each call?',
    a: 'By your routing policy: price plus trust, with a default minimum trust score of 60. Leave it on auto to hit the cheapest verified provider every time, or pin a provider with <code>&lt;peerId&gt;@&lt;model&gt;</code> in the model field, or from the CLI with <code>antseed buyer connection set --peer &lt;peerId&gt;</code>.',
  },
  {
    q: 'Can a provider see what my agent sends?',
    a: "Requests route peer-to-peer with no platform in the middle, so a provider sees a peer and a wallet, not an account. A standard provider can read the prompt it serves; a TEE-verified provider cannot, and you get an attestation to prove it. <a href=\"/docs/guides/verify-tee\">Verify a provider's TEE →</a>",
  },
];

function AgentFaq() {
  return (
    <Section tone="tinted">
      <Reveal>
        <h2 className={styles.faqTitle}>Frequently asked questions</h2>
      </Reveal>
      <Reveal delay={90}>
        <Faq items={AGENT_FAQ} />
      </Reveal>
    </Section>
  );
}

export default function AgentsPage(): JSX.Element {
  return (
    <Layout title="For agents" description={DESCRIPTION}>
      <Head>
        <title>{TITLE}</title>
        <meta name="description" content={DESCRIPTION} />
        <meta property="og:title" content={TITLE} />
        <meta property="og:description" content={DESCRIPTION} />
        <link rel="canonical" href="https://antseed.com/agents/" />
        <script type="application/ld+json">
          {JSON.stringify({
            '@context': 'https://schema.org',
            '@type': 'FAQPage',
            mainEntity: AGENT_FAQ.map(({q, a}) => ({
              '@type': 'Question',
              name: q,
              acceptedAnswer: {'@type': 'Answer', text: a.replace(/<[^>]+>/g, '')},
            })),
          })}
        </script>
      </Head>
      <AgentsHero />
      <AgentsLogoBar />
      <WishAndBill />
      <ConnectAgents />
      <PointAtLocalhost />
      <AgentSteps />
      <AgentFaq />
      <FinalCta title="Run your agents on your terms." note="Free models to start. Keep using your agent.">
        <DownloadButton />
      </FinalCta>
    </Layout>
  );
}
