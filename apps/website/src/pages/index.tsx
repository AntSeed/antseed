import {useEffect, useRef, useState} from 'react';
import Link from '@docusaurus/Link';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import Layout from '@theme/Layout';
import styles from './index.module.css';

const RELEASES_URL = 'https://github.com/AntSeed/antseed/releases/latest';

function AntMarkFull({size = 48}: {size?: number}) {
  const c = '#3dffa2';
  return (
    <svg width={size} height={size} viewBox="0 0 80 80" fill="none">
      <ellipse cx="40" cy="22" rx="5" ry="5.5" fill={c} opacity="0.9" />
      <ellipse cx="40" cy="36" rx="7" ry="8" fill={c} />
      <ellipse cx="40" cy="55" rx="9" ry="12" fill={c} opacity="0.9" />
      <line x1="37" y1="17" x2="28" y2="6" stroke={c} strokeWidth="1.5" strokeLinecap="round" opacity="0.7" />
      <line x1="43" y1="17" x2="52" y2="6" stroke={c} strokeWidth="1.5" strokeLinecap="round" opacity="0.7" />
      <circle cx="28" cy="6" r="2.5" fill={c} opacity="0.6" />
      <circle cx="52" cy="6" r="2.5" fill={c} opacity="0.6" />
      <line x1="34" y1="30" x2="18" y2="22" stroke={c} strokeWidth="1.3" strokeLinecap="round" opacity="0.5" />
      <line x1="46" y1="30" x2="62" y2="22" stroke={c} strokeWidth="1.3" strokeLinecap="round" opacity="0.5" />
      <circle cx="18" cy="22" r="2.5" fill={c} opacity="0.5" />
      <circle cx="62" cy="22" r="2.5" fill={c} opacity="0.5" />
      <line x1="33" y1="38" x2="14" y2="40" stroke={c} strokeWidth="1.3" strokeLinecap="round" opacity="0.5" />
      <line x1="47" y1="38" x2="66" y2="40" stroke={c} strokeWidth="1.3" strokeLinecap="round" opacity="0.5" />
      <circle cx="14" cy="40" r="2.5" fill={c} opacity="0.5" />
      <circle cx="66" cy="40" r="2.5" fill={c} opacity="0.5" />
      <line x1="34" y1="52" x2="16" y2="60" stroke={c} strokeWidth="1.3" strokeLinecap="round" opacity="0.5" />
      <line x1="46" y1="52" x2="64" y2="60" stroke={c} strokeWidth="1.3" strokeLinecap="round" opacity="0.5" />
      <circle cx="16" cy="60" r="2.5" fill={c} opacity="0.5" />
      <circle cx="64" cy="60" r="2.5" fill={c} opacity="0.5" />
      <line x1="18" y1="22" x2="14" y2="40" stroke={c} strokeWidth="0.7" strokeLinecap="round" opacity="0.15" />
      <line x1="62" y1="22" x2="66" y2="40" stroke={c} strokeWidth="0.7" strokeLinecap="round" opacity="0.15" />
      <line x1="14" y1="40" x2="16" y2="60" stroke={c} strokeWidth="0.7" strokeLinecap="round" opacity="0.15" />
      <line x1="66" y1="40" x2="64" y2="60" stroke={c} strokeWidth="0.7" strokeLinecap="round" opacity="0.15" />
    </svg>
  );
}

function useReveal() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) entry.target.classList.add('visible');
        });
      },
      {threshold: 0.1},
    );
    el.querySelectorAll('.reveal').forEach((child) => observer.observe(child));
    return () => observer.disconnect();
  }, []);
  return ref;
}

function InstallBox() {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    navigator.clipboard.writeText('npm install -g @antseed/cli');
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <button onClick={handleCopy} className={styles.installBox}>
      <span className={styles.installPrompt}>$</span>
      <span className={styles.installCmd}>npm install -g @antseed/cli</span>
      <span className={`${styles.installCopy} ${copied ? styles.installCopied : ''}`}>
        {copied ? 'copied!' : 'copy'}
      </span>
    </button>
  );
}

function Hero() {
  return (
    <div className={styles.hero}>
      <div className={styles.heroInner}>
        <div className={`${styles.heroLogo} animate-fade-up-1`}>
          <div className="animate-float">
            <AntMarkFull size={100} />
          </div>
        </div>
        <div className={`${styles.heroSubtitle} animate-fade-up-1`}>
          A Peer-to-Peer AI Services Network
        </div>
        <h1 className={`${styles.heroTitle} animate-fade-up-2`}>
          Your AI tools,<br /><span className={styles.accent}>unstoppable.</span>
        </h1>
        <p className={`${styles.heroDesc} animate-fade-up-3`}>
          An open market for machines to trade intelligence. Agents discover, carry, and deliver AI services peer-to-peer. Everyone profits. No one controls.
        </p>
        <div className={`${styles.heroCtas} animate-fade-up-4`}>
          <Link to="/docs/lightpaper" className={styles.btnPrimary}>
            Light Paper
          </Link>
          <Link to="/docs/intro" className={styles.btnSecondary}>
            Read the Docs
          </Link>
        </div>
        <div className={`${styles.heroInstall} animate-fade-up-5`}>
          <InstallBox />
        </div>
      </div>
    </div>
  );
}

function HowItWorks() {
  const steps = [
    {step: '01', title: 'Install the daemon', desc: 'One command. Runs as a background service. Exposes an API-compatible endpoint on localhost. Your existing tools work without modification.'},
    {step: '02', title: 'Set your preferences', desc: 'Tell AntSeed what you care about: cheapest price, lowest latency, specific capabilities, TEE privacy, minimum provider reputation. The router scores all available providers and picks the best match in real time.'},
    {step: '03', title: 'Never stop working', desc: 'Hit a rate limit? Provider down? AntSeed detects it instantly and reroutes to the next best provider. Automatic failover across a decentralized network. Zero data loss on switch.'},
  ];
  return (
    <section className={styles.section}>
      <div className="reveal">
        <div className={styles.sectionLabel}>How It Works</div>
        <div className={styles.sectionTitle}>Install. Route. Unstoppable.</div>
        <div className={styles.sectionDesc}>
          AntSeed runs as a local proxy. Your tools send requests to localhost. The protocol handles everything else.
        </div>
      </div>
      <div className={`${styles.grid3} reveal`}>
        {steps.map((s) => (
          <div key={s.step} className={styles.card}>
            <div className={styles.cardNum}>{s.step}</div>
            <h3 className={styles.cardTitle}>{s.title}</h3>
            <p className={styles.cardDesc}>{s.desc}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function SupplySources() {
  const sources = [
    {name: 'Skilled Inference', tier: 'Differentiated · Reputation-based', desc: 'Anyone with frontier model API access can offer specialized agents with Skills — legal research, security audit, market analysis. Compete on outcomes, not just price.'},
    {name: 'Self-Hosted Operators', tier: 'Low cost · Variable uptime', desc: 'A gamer with a GPU, a developer with a Mac Mini running open-weight models. No terms-of-service issues. Cost basis is electricity and hardware depreciation.'},
    {name: 'Inference Farms', tier: 'Mid cost · 24/7 reliability', desc: 'Professional operators running optimized stacks at scale. Always on, high throughput, high stake. Farms in cheap-electricity regions set the global floor price.'},
    {name: 'Privacy / TEE Nodes', tier: 'Premium · Cryptographic proof', desc: 'Trusted Execution Environments where not even the operator can see prompts. Cryptographic attestation proves the enclave is genuine.'},
    {name: 'Custom Model Operators', tier: 'Premium · Unique capabilities', desc: 'Models serving use cases that cannot exist on centralized platforms — security research, red-teaming, unrestricted creative work.'},
    {name: 'Edge Providers', tier: 'Premium · Sub-100ms latency', desc: 'Metro-located nodes optimized for speed. For real-time coding assistants, chatbots, and agentic chains where every millisecond matters.'},
  ];
  return (
    <section className={styles.section}>
      <div className="reveal">
        <div className={styles.sectionLabel}>Supply</div>
        <div className={styles.sectionTitle}>Anyone can provide.<br />No partnership required.</div>
        <div className={styles.sectionDesc}>
          The protocol is provider-agnostic. It does not care how a seller fulfills a request. It cares that a response came back, the receipt verified, and quality was consistent.
        </div>
      </div>
      <div className={`${styles.grid2} reveal`}>
        {sources.map((s) => (
          <div key={s.name} className={styles.supplyCard}>
            <h3 className={styles.supplyName}>{s.name}</h3>
            <div className={styles.supplyTier}>{s.tier}</div>
            <p className={styles.cardDesc}>{s.desc}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function ThreeMarkets() {
  const markets = [
    {num: '01', title: 'Commodity Inference', desc: 'A seller has a model or API access. A buyer needs inference. They trade directly. Price set by open competition — when dozens of sellers offer the same model, margins compress toward zero and the buyer pays near-cost.'},
    {num: '02', title: 'Differentiated AI Services', desc: 'Same protocol, but the seller equips their model with Skills — modular packages of domain expertise and workflows. The buyer does not care what is inside. They care about the result and the reputation.'},
    {num: '03', title: 'Agent-to-Agent Commerce', desc: 'Same protocol, but now the buyers are also machines. An autonomous agent holds credits, discovers providers by capability, evaluates reputation, consumes services, and settles payment — without human involvement.'},
  ];
  return (
    <section className={styles.section}>
      <div className="reveal">
        <div className={styles.sectionLabel}>Three Markets</div>
        <div className={styles.sectionTitle}>One protocol.<br />Three use cases.</div>
        <div className={styles.sectionDesc}>
          Each builds on the one before it. All three share the same discovery, routing, reputation, and settlement mechanisms.
        </div>
      </div>
      <div className={`${styles.grid3} reveal`}>
        {markets.map((m) => (
          <div key={m.num} className={styles.card}>
            <div className={styles.cardNum}>{m.num}</div>
            <h3 className={styles.cardTitle}>{m.title}</h3>
            <p className={styles.cardDesc}>{m.desc}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function Roadmap() {
  const phases = [
    {label: 'Phase 1a', title: 'The Protocol', desc: 'P2P protocol goes live. Commodity inference and skilled services serve builders and agents. Settlement and reputation operational.'},
    {label: 'Phase 1b', title: 'Differentiated Services', desc: 'Providers offer specialized AI services: fine-tuned models, agentic workflows, domain expertise. Capability-based discovery and per-skill reputation.'},
    {label: 'Phase 1c', title: 'Agent Network', desc: 'Autonomous agents use the network for inference and for hiring other agents. Agent-to-agent commerce emerges.'},
    {label: 'Phase 2', title: 'Price Index & Derivatives', desc: 'The AntSeed Compute Index — real-time pricing from verified transactions. Futures contracts let startups hedge AI costs and providers sell forward capacity.'},
  ];
  return (
    <section className={`${styles.section} ${styles.sectionBorder}`}>
      <div className="reveal">
        <div className={styles.sectionLabel}>Roadmap</div>
        <div className={styles.sectionTitle}>From marketplace to commodity standard.</div>
      </div>
      <div className={`${styles.roadmapGrid} reveal`}>
        {phases.map((p) => (
          <div key={p.label} className={styles.roadmapItem}>
            <div className={styles.roadmapLabel}>{p.label}</div>
            <div className={styles.roadmapTitle}>{p.title}</div>
            <p className={styles.cardDesc}>{p.desc}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function DownloadDesktop() {
  const platforms = [
    {name: 'macOS', arch: 'Apple Silicon & Intel', ext: '.dmg', icon: '\u2318'},
    {name: 'Windows', arch: 'x64 & ARM64', ext: '.exe', icon: '\u229E'},
    {name: 'Linux', arch: 'x64 & ARM64', ext: '.AppImage', icon: '\u2726'},
  ];
  return (
    <section className={`${styles.section} ${styles.sectionBorder}`}>
      <div className="reveal">
        <div className={styles.sectionLabel}>Download</div>
        <div className={styles.sectionTitle}>AntSeed Desktop</div>
        <div className={styles.sectionDesc}>
          A native app for seeding and connecting to the AntSeed network. Manage providers, monitor peers, and route requests — all from one interface.
        </div>
      </div>
      <div className={`${styles.grid3} reveal`}>
        {platforms.map((p) => (
          <a key={p.name} href={RELEASES_URL} target="_blank" rel="noopener noreferrer" className={styles.downloadCard}>
            <div className={styles.cardNum}>{p.icon}</div>
            <h3 className={styles.cardTitle}>{p.name}</h3>
            <p className={styles.cardDesc}>{p.arch}</p>
            <p className={styles.downloadExt}>{p.ext}</p>
          </a>
        ))}
      </div>
      <div className="reveal" style={{marginTop: '1.5rem', textAlign: 'center'}}>
        <a href={RELEASES_URL} target="_blank" rel="noopener noreferrer" className={styles.releasesLink}>
          All releases on GitHub &rarr;
        </a>
      </div>
    </section>
  );
}

function CTASection() {
  return (
    <div className={`${styles.cta} ${styles.sectionBorder}`}>
      <div className="reveal">
        <h2 className={styles.ctaTitle}>
          Start providing. Start building.<br /><span className={styles.accent}>Start now.</span>
        </h2>
        <p className={styles.ctaDesc}>Everyone profits. No one controls.</p>
        <div className={styles.heroCtas}>
          <Link to="/docs/intro" className={styles.btnPrimary}>Get Started</Link>
          <Link to="/docs/lightpaper" className={styles.btnSecondary}>Light Paper</Link>
        </div>
      </div>
    </div>
  );
}

export default function Home(): JSX.Element {
  const {siteConfig} = useDocusaurusContext();
  const containerRef = useReveal();

  return (
    <Layout
      title={`${siteConfig.title} — ${siteConfig.tagline}`}
      description="An open market for machines to trade intelligence. Agents discover, carry, and deliver AI services peer-to-peer. Everyone profits. No one controls."
      wrapperClassName="homepage-wrapper">
      <div ref={containerRef}>
        <Hero />
        <HowItWorks />
        <SupplySources />
        <ThreeMarkets />
        <Roadmap />
        <DownloadDesktop />
        <CTASection />
      </div>
    </Layout>
  );
}
