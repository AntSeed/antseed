import {useState} from 'react';
import Link from '@docusaurus/Link';
import Layout from '@theme/Layout';
import styles from './providers.module.css';

/* ── FAQ ─────────────────────────────────────────────────────── */
const FAQ_DATA = [
  {
    q: 'Does the network see my backend, model choice, or routing logic?',
    a: 'Never. The network only sees what you announce: your service names, pricing, capability tags, and on-chain reputation. Your backend URL, model provider, routing strategy, system prompt, and fine-tune weights stay completely private on your machine.',
  },
  {
    q: 'What provider types can I run?',
    a: 'Three: Raw Inference (serve a model or proxy an existing API), Routing Service (select providers on behalf of buyers and earn per request), or AI Agent (wrap domain expertise as a named always-on service). A single node can run all three simultaneously at different price tiers.',
  },
  {
    q: 'Does my node need to run 24/7?',
    a: 'No. Providers announce uptime windows in their metadata. When you go offline, the network routes around you. Your on-chain reputation persists across sessions.',
  },
  {
    q: 'How do payments actually reach me?',
    a: 'Buyers lock USDC in on-chain escrow on Base before a session starts. Requests flow freely during the session. When the session ends (or idles for 30 seconds), settlement executes on-chain and USDC lands in your wallet automatically. No invoicing, no billing cycles.',
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

function FAQSection() {
  const [openIdx, setOpenIdx] = useState<number | null>(null);
  return (
    <section className={styles.faq}>
      <h2 className={styles.faqTitle}>Common questions</h2>
      <div className={styles.faqList}>
        {FAQ_DATA.map((item, i) => (
          <div key={i} className={`${styles.faqItem} ${i === 0 ? styles.faqItemFirst : ''}`}>
            <div className={styles.faqSummary} onClick={() => setOpenIdx(openIdx === i ? null : i)}>
              <span>{item.q}</span>
              <span className={`${styles.faqChevron} ${openIdx === i ? styles.faqChevronOpen : ''}`}>+</span>
            </div>
            <div className={`${styles.faqCollapse} ${openIdx === i ? styles.faqCollapseOpen : ''}`}>
              <div className={styles.faqCollapseInner}>
                <p className={styles.faqAnswer}>{item.a}</p>
              </div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ── MAIN PAGE ───────────────────────────────────────────────── */
export default function Providers(): JSX.Element {
  return (
    <Layout
      title="Become a Provider | AntSeed"
      description="Build an AntSeed provider that monetizes your AI capability. Your model, your prompt chain, your RAG — none of it is ever exposed. Buyers get results. You get paid."
    >

      {/* ── HERO ── */}
      <section className={styles.hero}>
        <h1 className={styles.heroTitle}>
          Serve AI on the open market.<br />
          <em>No permission needed.</em>
        </h1>
        <p className={styles.heroSub}>
          Set your price. Announce to the network. Get paid in USDC on every delivery — whether you run a model, a routing service, or a specialized agent.
        </p>
        <div className={styles.heroCtas}>
          <Link to="/docs/guides/become-a-provider" className={styles.ctaPrimary}>Become a provider →</Link>
          <Link to="/docs/install" className={styles.ctaSecondary}>Install AntSeed</Link>
        </div>
      </section>

      {/* ── TWO PATHS ── */}
      <section className={styles.paths}>
        <div className={styles.pathsHeader}>
          <h2>Three ways to provide</h2>
          <p>All three serve buyers on the open market. What runs behind is entirely yours.</p>
        </div>
        <div className={styles.pathsGrid}>

          <div className={styles.pathCard}>
            <div className={styles.pathIcon}>
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#1FD87A" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="3" width="20" height="14" rx="2"/>
                <line x1="8" y1="21" x2="16" y2="21"/>
                <line x1="12" y1="17" x2="12" y2="21"/>
              </svg>
            </div>
            <h3>Raw Inference</h3>
            <p>You run a model or proxy an upstream API — Ollama, a fine-tune, a local GPU, OpenAI, Together. Point AntSeed at it with one config entry, announce it to the network, and start earning. Buyers choose you based on price, latency, and on-chain reputation.</p>
            <ul className={styles.pathList}>
              <li>→ Any model or backend</li>
              <li>→ Set your own price per token</li>
              <li>→ Reputation built per delivery</li>
            </ul>
            <Link to="/docs/guides/become-a-provider" className={styles.pathLink}>Become a provider →</Link>
          </div>

          <div className={styles.pathCard}>
            <div className={styles.pathIcon}>
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#1FD87A" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 2L2 7l10 5 10-5-10-5z"/>
                <path d="M2 17l10 5 10-5"/>
                <path d="M2 12l10 5 10-5"/>
              </svg>
            </div>
            <h3>AI Agent</h3>
            <p>You've built domain expertise in AI form. A legal agent, a security researcher, a trading analyst. Announce it as a named service. Buyers pay for your expertise, not just the tokens.</p>
            <ul className={styles.pathList}>
              <li>→ Persona, guardrails, and knowledge stay private</li>
              <li>→ Announced as a named service on the network</li>
              <li>→ Premium pricing for specialized delivery</li>
            </ul>
            <Link to="/docs/guides/become-a-provider" className={styles.pathLink}>Become a provider →</Link>
          </div>

          <div className={styles.pathCard}>
            <div className={styles.pathIcon}>
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#1FD87A" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>
                <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/>
                <line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
              </svg>
            </div>
            <h3>Routing Service</h3>
            <p>Build specialized routing logic and offer it on the network. Latency-optimized, cost-minimizing, TEE-only, or domain-aware. Earn per request you route without running a single model.</p>
            <ul className={styles.pathList}>
              <li>→ No model infrastructure required</li>
              <li>→ Latency, cost, TEE, or domain-aware routing</li>
              <li>→ Earn per request routed</li>
            </ul>
            <Link to="/docs/guides/become-a-provider" className={styles.pathLink}>Become a provider →</Link>
          </div>

        </div>
      </section>

      {/* ── PRIVACY DIAGRAM ── */}
      <section className={styles.privacy}>
        <div className={styles.privacyHeader}>
          <h2>What the network sees. What stays private.</h2>
          <p>Buyers see enough to route and verify. Everything else stays on your machine.</p>
        </div>
        <div className={styles.privacyGrid}>
          <div className={styles.privacyCol}>
            <div className={styles.privacyColLabel + ' ' + styles.public}>Public to the network</div>
            {['Your service names', 'Your price per token or per request', 'Your capability tags (TEE, domain, model family…)', 'Your on-chain reputation score', 'Your latency percentiles', 'Your uptime window'].map(item => (
              <div key={item} className={styles.privacyRow}>
                <span className={styles.privacyCheck}>✓</span>
                <span>{item}</span>
              </div>
            ))}
          </div>
          <div className={styles.privacyDivider}>
            <svg width="1" height="100%" viewBox="0 0 1 200" preserveAspectRatio="none">
              <line x1="0.5" y1="0" x2="0.5" y2="200" stroke="#e8e8e3" strokeWidth="1" strokeDasharray="6 4"/>
            </svg>
          </div>
          <div className={styles.privacyCol}>
            <div className={styles.privacyColLabel + ' ' + styles.private}>Private — never leaves your node</div>
            {['Your backend URL or model provider', 'Your routing logic and selection criteria', 'Your system prompt and guardrails', 'Your RAG sources and knowledge base', 'Your prompt engineering', 'Your fine-tune weights'].map(item => (
              <div key={item} className={styles.privacyRow}>
                <span className={styles.privacyLock}>🔒</span>
                <span>{item}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── THE INTEGRATION ── */}
      <section className={styles.code}>
        <div className={styles.codeHeader}>
          <h2>One JSON file. Full control.</h2>
          <p>
            No code to write. Point AntSeed at an OpenAI-compatible endpoint,
            set your prices and categories, and start earning.{' '}
            <Link to="/docs/guides/become-a-provider">Become a provider →</Link>
          </p>
        </div>

        <div className={styles.codeGrid}>
          {/* CLI setup example */}
          <div className={styles.codeCard}>
            <div className={styles.codeCardLabel}>1. Configure with the CLI</div>
            <div className={styles.codeTerm}>
              <div className={styles.codeTermBar}>
                <span className={styles.codeTermDot} style={{background:'#ff5f57'}}/>
                <span className={styles.codeTermDot} style={{background:'#febc2e'}}/>
                <span className={styles.codeTermDot} style={{background:'#28c840'}}/>
                <span className={styles.codeTermTitle}>terminal</span>
              </div>
              <pre className={styles.codePre}>{`# Point at any OpenAI-compatible endpoint
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
antseed seller start`}</pre>
            </div>
            <p className={styles.codeNote}>
              Works with OpenAI, Together, OpenRouter, Groq, Ollama, vLLM — anything
              that speaks the OpenAI API.
            </p>
          </div>

          {/* config.json example */}
          <div className={styles.codeCard}>
            <div className={styles.codeCardLabel}>2. Or edit config.json directly</div>
            <div className={styles.codeTerm}>
              <div className={styles.codeTermBar}>
                <span className={styles.codeTermDot} style={{background:'#ff5f57'}}/>
                <span className={styles.codeTermDot} style={{background:'#febc2e'}}/>
                <span className={styles.codeTermDot} style={{background:'#28c840'}}/>
                <span className={styles.codeTermTitle}>~/.antseed/config.json</span>
              </div>
              <pre className={styles.codePre}>{`{
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
}`}</pre>
            </div>
            <p className={styles.codeNote}>
              Your backend URL, API key, and routing logic never leave your node.
              The network only sees the service name, price, and categories.{' '}
              <Link to="/docs/getting-started/configuration">Full config reference →</Link>
            </p>
          </div>
        </div>
      </section>

      {/* ── PAYMENTS ── */}
      <section className={styles.payments}>
        <div className={styles.paymentsHeader}>
          <h2>Direct settlement. No invoicing.</h2>
          <p>
            Buyers lock funds before a session. You deliver. Settlement executes on-chain automatically.{' '}
            <Link to="/docs/payments">Payment protocol details →</Link>
          </p>
        </div>

        <div className={styles.paymentsFlow}>
          {[
            {
              step: '01',
              title: 'Buyer locks funds',
              body: 'USDC is locked in the AntSeedEscrow smart contract on Base before the session starts. Requests flow freely while funds are escrowed.',
            },
            {
              step: '02',
              title: 'You deliver, receipts are signed',
              body: 'Each request generates a provider-signed receipt with exact token counts, cost, and a cryptographic signature. Both sides have proof.',
            },
            {
              step: '03',
              title: 'Settlement executes on-chain',
              body: 'On session end (or 30s idle), the escrow contract computes final cost from signed receipts, sends your payout to your wallet, and refunds unused funds to the buyer.',
            },
          ].map(s => (
            <div key={s.step} className={styles.payStep}>
              <div className={styles.payStepNum}>{s.step}</div>
              <div className={styles.payStepContent}>
                <h4>{s.title}</h4>
                <p>{s.body}</p>
              </div>
            </div>
          ))}
        </div>

        <div className={styles.paymentsEcon}>
          <div className={styles.econRow}>
            <span className={styles.econLabel}>Your price</span>
            <span className={styles.econValue}>You set it — per input token + per output token</span>
          </div>
          <div className={styles.econRow}>
            <span className={styles.econLabel}>Protocol fee</span>
            <span className={styles.econValue}>2% — distributed back to the network, not extracted</span>
          </div>
          <div className={styles.econRow}>
            <span className={styles.econLabel}>Your payout</span>
            <span className={styles.econValue}>98% of what buyers pay, direct to your wallet in USDC</span>
          </div>
          <div className={styles.econRow}>
            <span className={styles.econLabel}>Payment methods</span>
            <span className={styles.econValue}>Buyers pay in USDC or by card — your payout is always USDC</span>
          </div>
          <div className={styles.econRow}>
            <span className={styles.econLabel}>Settlement chain</span>
            <span className={styles.econValue}>Base mainnet</span>
          </div>
        </div>

        <div className={styles.paymentsWallet}>
          <div className={styles.walletTerm}>
            <div className={styles.codeTermBar}>
              <span className={styles.codeTermDot} style={{background:'#ff5f57'}}/>
              <span className={styles.codeTermDot} style={{background:'#febc2e'}}/>
              <span className={styles.codeTermDot} style={{background:'#28c840'}}/>
              <span className={styles.codeTermTitle}>wallet management</span>
            </div>
            <pre className={styles.codePre}>{`antseed seller status         # earnings, peers, wallet address
antseed seller stake <amt>    # stake USDC to become discoverable
antseed seller unstake        # withdraw your stake`}</pre>
          </div>
          <p className={styles.walletNote}>
            Your EVM wallet is derived automatically from your node's secp256k1 identity key.
            Payouts land in it on every settlement — no claim step, no separate wallet setup.{' '}
            <Link to="/docs/payments">Full payment docs →</Link>
          </p>
        </div>
      </section>

      {/* ── REPUTATION ── */}
      <section className={styles.reputation}>
        <div className={styles.reputationHeader}>
          <h2>Build reputation that compounds.</h2>
          <p>
            Every delivery is recorded on-chain. Your reputation belongs to your wallet.
            No platform can revoke it.
          </p>
        </div>
        <div className={styles.reputationGrid}>
          {[
            {label: 'Success rate', desc: 'Percentage of requests delivered and settled on-chain'},
            {label: 'Latency p50 / p99', desc: 'Measured per delivery, visible to buyers pre-route'},
            {label: 'Token accuracy', desc: 'Signed receipts verify exact token counts on both sides'},
            {label: 'Uptime', desc: 'Historical availability across announced service windows'},
          ].map(r => (
            <div key={r.label} className={styles.reputationCard}>
              <div className={styles.reputationLabel}>{r.label}</div>
              <p>{r.desc}</p>
            </div>
          ))}
        </div>
        <p className={styles.reputationNote}>
          Any buyer can build their own access and routing rules on top of on-chain stats.
          Providers with strong track records command higher prices and earn more traffic automatically.
        </p>
      </section>

      {/* ── FAQ ── */}
      <FAQSection />

      {/* ── BOTTOM CTA ── */}
      <section className={styles.bottomCta}>
        <h2>Ready to provide?</h2>
        <p>Install AntSeed, configure your provider, and start earning.</p>
        <div className={styles.bottomCtaBtns}>
          <Link to="/docs/install" className={styles.ctaPrimary}>Get started →</Link>
          <Link to="/docs/guides/become-a-provider" className={styles.ctaSecondary}>Become a provider</Link>
        </div>
        <div className={styles.bottomLinks}>
          <Link to="/docs/lightpaper">Read the lightpaper</Link>
          <span>·</span>
          <Link to="/docs/payments">Payment protocol</Link>
          <span>·</span>
          <Link to="/docs/faq">FAQ</Link>
        </div>
      </section>

    </Layout>
  );
}
