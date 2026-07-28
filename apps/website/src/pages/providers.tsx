import Layout from '@theme/Layout';
import styles from './providers.module.css';
import {
  Button,
  Faq,
  FinalCta,
  LinkArrow,
  PageHero,
  Reveal,
  Section,
  SectionHeader,
  Terminal,
} from '../components/ui';

/* ── FAQ ─────────────────────────────────────────────────────── */
const FAQ_DATA = [
  {
    q: 'Does the network see my backend, model choice, or routing logic?',
    a: 'The network only sees what you announce: your service names, pricing, capability tags, and on-chain reputation. Your backend URL, model provider, routing strategy, system prompt, and fine-tune weights are intended to remain under your control. You are responsible for securing your own node, credentials, logs, and provider infrastructure.',
  },
  {
    q: 'What provider types can I run?',
    a: 'Three: Raw Inference (serve a model or proxy an existing API), Routing Service (select providers on behalf of buyers and receive payment per routed request), or AI Agent (wrap domain expertise as a named always-on service). A single node can run all three simultaneously at different price tiers.',
  },
  {
    q: 'Does my node need to run 24/7?',
    a: 'No. Providers announce uptime windows in their metadata. When you go offline, the network routes around you. Your on-chain reputation persists across sessions.',
  },
  {
    q: 'How do payments actually reach me?',
    a: 'Buyers lock USDC in on-chain escrow on Base before a session starts. Requests flow freely during the session. When the session ends (or idles for 10 minutes), settlement executes on-chain and USDC lands in your wallet automatically. No invoicing, no billing cycles.',
  },
  {
    q: 'Are seller ANTS incentives claimable now?',
    a: 'Seller ANTS emissions are currently tracked but routed into a dedicated Provider Pool and locked. They are not freely claimable yet. Future claimability is expected after stronger validation, audit, attestation, and proof systems are introduced, and may be subject to verification or slashing.',
  },
  {
    q: 'Can I use any model underneath?',
    a: 'Yes. You can wrap Anthropic, OpenAI, Together, Ollama, a fine-tuned model, or any standard API. The network only sees what you deliver — not your backend.',
  },
  {
    q: 'Can I serve multiple capability types from one node?',
    a: 'Yes. A single AntSeed node can advertise multiple services — raw inference on one model, a routing service with custom logic, and an AI Agent, all at different price tiers. Each service is announced independently to the DHT.',
  },
];

/* ── Icons ───────────────────────────────────────────────────── */
const ICON_PROPS = {
  width: 24,
  height: 24,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

function CheckIcon() {
  return (
    <svg {...ICON_PROPS} width={16} height={16}>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg {...ICON_PROPS} width={16} height={16}>
      <rect x="4" y="10" width="16" height="11" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </svg>
  );
}

/* ── Page data ───────────────────────────────────────────────── */
const PATHS = [
  {
    title: 'Raw Inference',
    icon: (
      <svg {...ICON_PROPS}>
        <rect x="2" y="3" width="20" height="14" rx="2" />
        <line x1="8" y1="21" x2="16" y2="21" />
        <line x1="12" y1="17" x2="12" y2="21" />
      </svg>
    ),
    body: 'You run a model or proxy an upstream API — Ollama, a fine-tune, a local GPU, OpenAI, Together. Point AntSeed at it with one config entry and announce it to the network. Buyers choose you based on price, latency, and on-chain reputation; payments depend on demand and successful settlement.',
    points: ['Any model or backend', 'Set your own price per token', 'Reputation built per delivery'],
  },
  {
    title: 'AI Agent',
    icon: (
      <svg {...ICON_PROPS}>
        <path d="M12 2 2 7l10 5 10-5-10-5z" />
        <path d="M2 17l10 5 10-5" />
        <path d="M2 12l10 5 10-5" />
      </svg>
    ),
    body: "You've built domain expertise in AI form. A legal agent, a security researcher, a trading analyst. Announce it as a named service. Buyers pay for your expertise, not just the tokens.",
    points: [
      'Persona, guardrails, and knowledge stay private',
      'Announced as a named service on the network',
      'Premium pricing for specialized delivery',
    ],
  },
  {
    title: 'Routing Service',
    icon: (
      <svg {...ICON_PROPS}>
        <circle cx="18" cy="5" r="3" />
        <circle cx="6" cy="12" r="3" />
        <circle cx="18" cy="19" r="3" />
        <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
        <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
      </svg>
    ),
    body: 'Build specialized routing logic and offer it on the network. Latency-optimized, cost-minimizing, TEE-only, or domain-aware. Receive payment for settled routed requests without running a single model.',
    points: [
      'No model infrastructure required',
      'Latency, cost, TEE, or domain-aware routing',
      'Payment per settled routed request',
    ],
  },
];

const PUBLIC_FACTS = [
  'Your service names',
  'Your price per token or per request',
  'Your capability tags (TEE, domain, model family…)',
  'Your on-chain reputation score',
  'Your latency percentiles',
  'Your uptime window',
];

const PRIVATE_FACTS = [
  'Your backend URL or model provider',
  'Your routing logic and selection criteria',
  'Your system prompt and guardrails',
  'Your RAG sources and knowledge base',
  'Your prompt engineering',
  'Your fine-tune weights',
];

const PAY_STEPS = [
  {
    step: '1',
    title: 'Buyer locks funds',
    body: 'USDC is locked in the AntSeedEscrow smart contract on Base before the session starts. Requests flow freely while funds are escrowed.',
  },
  {
    step: '2',
    title: 'You deliver, receipts are signed',
    body: 'Each request generates a provider-signed receipt with exact token counts, cost, and a cryptographic signature. Both sides have proof.',
  },
  {
    step: '3',
    title: 'Settlement executes on-chain',
    body: 'On session end (or 10 min idle), the escrow contract computes final cost from signed receipts, sends your payout to your wallet, and refunds unused funds to the buyer.',
  },
];

const ECONOMICS = [
  {label: 'Your price', value: 'You set it — per input token + per output token'},
  {
    label: 'Protocol fee',
    value:
      '4% — may be directed to ecosystem mechanisms such as reserves, grants, incentives, buy-and-burn, or other community-approved uses',
  },
  {label: 'Your payout', value: '96% of what buyers pay, direct to your wallet in USDC'},
  {label: 'Payment methods', value: 'Buyers pay in USDC or by card — your payout is always USDC'},
  {label: 'Settlement chain', value: 'Base mainnet'},
];

const REPUTATION = [
  {label: 'Success rate', desc: 'Percentage of requests delivered and settled on-chain'},
  {label: 'Latency p50 / p99', desc: 'Measured per delivery, visible to buyers pre-route'},
  {label: 'Token accuracy', desc: 'Signed receipts verify exact token counts on both sides'},
  {label: 'Uptime', desc: 'Historical availability across announced service windows'},
];

const CLI_SNIPPET = `# Point at any OpenAI-compatible endpoint
antseed config seller add-provider together \\
  --plugin openai \\
  --base-url https://api.together.ai

# Announce a service with your price + categories
# (--cached is optional — set it to charge less for
# cached-input tokens when your upstream supports them)
antseed config seller add-service together deepseek-v3.1 \\
  --upstream "deepseek-ai/DeepSeek-V3.1" \\
  --input 0.6 --cached 0.06 --output 1.7 \\
  --categories chat,math,coding

# Start serving
export OPENAI_API_KEY=<your-key>
antseed seller start`;

const CONFIG_SNIPPET = `{
  "seller": {
    "providers": {
      "together": {
        "plugin": "openai",
        "baseUrl": "https://api.together.ai",
        "services": {
          "deepseek-v3.1": {
            "upstreamModel": "deepseek-ai/DeepSeek-V3.1",
            "pricing": {
              "inputUsdPerMillion": 0.6,
              "cachedInputUsdPerMillion": 0.06,
              "outputUsdPerMillion": 1.7
            },
            "categories": ["chat", "coding", "math"]
          }
        }
      }
    }
  }
}`;

const WALLET_SNIPPET = `antseed seller status         # earnings, peers, wallet address
antseed seller stake <amt>    # stake USDC to become discoverable
antseed seller unstake        # withdraw your stake`;

/* ── MAIN PAGE ───────────────────────────────────────────────── */
export default function Providers(): JSX.Element {
  return (
    <Layout
      title="Become a Provider"
      description="Build an AntSeed provider for your AI capability. Providers are independent operators responsible for their own infrastructure, policies, compliance, and data handling."
    >
      <PageHero
        kicker="Providers"
        title={
          <>
            Serve AI on the open market.<br />
            <em>No permission needed.</em>
          </>
        }
        lead="Set your price. Announce to the network. Receive USDC for settled deliveries, depending on demand, availability, successful settlement, and your configuration — whether you run a model, a routing service, or a specialized agent."
      >
        <Button to="/docs/guides/become-a-provider" arrow>Become a provider</Button>
        <Button to="/docs/install" variant="ghost">Install AntSeed</Button>
      </PageHero>

      {/* ── THREE WAYS TO PROVIDE ── */}
      <Section tone="tinted">
        <Reveal>
          <SectionHeader
            title="Three ways to provide"
            lead="All three serve buyers on the open market. What runs behind is entirely yours."
          />
        </Reveal>
        <div className={styles.pathsGrid}>
          {PATHS.map((path, i) => (
            <Reveal key={path.title} className={styles.pathCard} delay={i * 100}>
              <div className={styles.pathIcon}>{path.icon}</div>
              <h3>{path.title}</h3>
              <p>{path.body}</p>
              <ul className={styles.pathList}>
                {path.points.map((point) => (
                  <li key={point}>{point}</li>
                ))}
              </ul>
              <LinkArrow to="/docs/guides/become-a-provider" className={styles.pathLink}>
                Become a provider
              </LinkArrow>
            </Reveal>
          ))}
        </div>

        <Reveal className={styles.compliance} delay={120}>
          <span className={styles.complianceIcon} aria-hidden="true">!</span>
          <div className={styles.complianceBody}>
            <p className={styles.complianceTitle}>Provider compliance</p>
            <p>
              AntSeed is designed for providers who build differentiated services —
              such as TEE-secured inference, domain-specific skills or agents,
              fine-tuned models, or managed product experiences. Simply reselling
              raw API access or subscription credentials is <strong>not</strong> the
              intended use and may violate your upstream provider's terms of service.
            </p>
            <p>
              Providers are independent operators and are solely responsible for their models,
              infrastructure, outputs, logs, privacy practices, data handling,
              security, sanctions/export compliance, tax obligations, applicable AI laws,
              and upstream API provider terms.
            </p>
            <p>
              Seller-side ANTS emissions are currently tracked but locked in a dedicated Provider Pool while AntSeed develops stronger validation and proof systems. Fake usage, sybil behavior, or incentive extraction may be excluded or subject to future slashing.
            </p>
          </div>
        </Reveal>
      </Section>

      {/* ── WHAT THE NETWORK SEES ── */}
      <Section>
        <Reveal>
          <SectionHeader
            title="What the network sees. What stays private."
            lead="Buyers see enough to route and verify. Everything else stays on your machine."
          />
        </Reveal>
        <div className={styles.privacyGrid}>
          <Reveal className={`${styles.privacyCol} ${styles.privacyColPublic}`}>
            <p className={`${styles.privacyColLabel} ${styles.public}`}>Public to the network</p>
            {PUBLIC_FACTS.map((item) => (
              <div key={item} className={styles.privacyRow}>
                <span className={styles.privacyIcon}><CheckIcon /></span>
                <span>{item}</span>
              </div>
            ))}
          </Reveal>
          <Reveal className={styles.privacyCol} delay={100}>
            <p className={`${styles.privacyColLabel} ${styles.private}`}>
              Under your control — secure your node
            </p>
            {PRIVATE_FACTS.map((item) => (
              <div key={item} className={styles.privacyRow}>
                <span className={styles.privacyIcon}><LockIcon /></span>
                <span>{item}</span>
              </div>
            ))}
          </Reveal>
        </div>
      </Section>

      {/* ── CONFIG ── */}
      <Section tone="tinted">
        <Reveal>
          <SectionHeader
            title="One JSON file. Full control."
            lead="No code to write. Point AntSeed at an OpenAI-compatible endpoint, set your prices and categories, and offer capacity to buyers."
          />
        </Reveal>
        <div className={styles.codeGrid}>
          <Reveal className={styles.codeCard}>
            <p className={styles.codeCardLabel}>1 · Configure with the CLI</p>
            <Terminal title="terminal">{CLI_SNIPPET}</Terminal>
            <p className={styles.codeNote}>
              Compatible with any OpenAI-API endpoint — your own Ollama, vLLM, a
              fine-tune, or an upstream you have the right to resell. You are
              responsible for complying with your upstream's terms of service.
            </p>
          </Reveal>
          <Reveal className={styles.codeCard} delay={100}>
            <p className={styles.codeCardLabel}>2 · Or edit config.json directly</p>
            <Terminal title="~/.antseed/config.json">{CONFIG_SNIPPET}</Terminal>
            <p className={styles.codeNote}>
              Your backend URL, API key, and routing logic are intended to remain under your control.
              The network only sees the service name, price, and categories; you are responsible for
              securing your node and credentials.{' '}
              <LinkArrow to="/docs/config">Full config reference</LinkArrow>
            </p>
          </Reveal>
        </div>
      </Section>

      {/* ── SETTLEMENT ── */}
      <Section width="md">
        <Reveal>
          <SectionHeader
            title="Direct settlement. No invoicing."
            lead="Buyers lock funds before a session. You deliver. Settlement executes on-chain automatically."
          />
        </Reveal>
        <Reveal className={styles.payFlow}>
          {PAY_STEPS.map((s) => (
            <div key={s.step} className={styles.payStep}>
              <span className={styles.payStepNum}>{s.step}</span>
              <div>
                <h3>{s.title}</h3>
                <p>{s.body}</p>
              </div>
            </div>
          ))}
        </Reveal>

        <Reveal className={styles.factTable} delay={80}>
          {ECONOMICS.map((row) => (
            <div key={row.label} className={styles.factRow}>
              <span className={styles.factLabel}>{row.label}</span>
              <span className={styles.factValue}>{row.value}</span>
            </div>
          ))}
        </Reveal>

        <Reveal className={styles.walletBlock} delay={120}>
          <Terminal title="wallet management">{WALLET_SNIPPET}</Terminal>
          <p className={styles.walletNote}>
            Your EVM wallet is derived automatically from your node's secp256k1 identity key.
            Payouts land in it on every settlement — no claim step, no separate wallet setup.{' '}
            <LinkArrow to="/docs/payments">Full payment docs</LinkArrow>
          </p>
        </Reveal>
      </Section>

      {/* ── REPUTATION ── */}
      <Section tone="tinted" width="md">
        <Reveal>
          <SectionHeader
            title="Build reputation that compounds."
            lead="Every delivery is recorded on-chain. Your reputation belongs to your wallet. No platform can revoke it."
          />
        </Reveal>
        <div className={styles.repGrid}>
          {REPUTATION.map((r, i) => (
            <Reveal key={r.label} className={styles.repCard} delay={i * 80}>
              <p className={styles.repLabel}>{r.label}</p>
              <p>{r.desc}</p>
            </Reveal>
          ))}
        </div>
        <Reveal delay={160}>
          <p className={styles.repNote}>
            Any buyer can build their own access and routing rules on top of on-chain stats.
            Providers with strong track records may command higher prices and receive more traffic,
            depending on buyer and router preferences.
          </p>
        </Reveal>
      </Section>

      {/* ── FAQ ── */}
      <Section width="md">
        <Reveal>
          <SectionHeader title="Common questions" />
        </Reveal>
        <Reveal delay={80}>
          <Faq items={FAQ_DATA} />
        </Reveal>
      </Section>

      {/* ── CLOSING CTA ── */}
      <FinalCta
        title="Ready to provide?"
        sub="Install AntSeed, configure your provider, and offer AI capacity as an independent operator."
        note={
          <>
            <a href="/docs/lightpaper">Read the lightpaper</a>
            <a href="/docs/payments">Payment protocol</a>
            <a href="/docs/faq">FAQ</a>
          </>
        }>
        <Button to="/docs/install" variant="white" size="lg" arrow>Get started</Button>
        <Button to="/docs/guides/become-a-provider" variant="light" size="lg">Become a provider</Button>
      </FinalCta>
    </Layout>
  );
}
