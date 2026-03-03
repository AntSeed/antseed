import {useEffect, useRef, useState} from 'react';
import BrowserOnly from '@docusaurus/BrowserOnly';
import Link from '@docusaurus/Link';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import Layout from '@theme/Layout';
import styles from './index.module.css';

const RELEASES_URL = 'https://github.com/AntSeed/antseed/releases/latest';

function AntMarkFull({size = 48}: {size?: number}) {
  const c = '#3dffa2'; // mint — seeds and nodes
  const body = '#0a0e14'; // black — ant body segments
  return (
    <svg width={size} height={size} viewBox="0 0 80 80" fill="none">
      <ellipse cx="40" cy="22" rx="5" ry="5.5" fill={body} />
      <ellipse cx="40" cy="36" rx="7" ry="8" fill={body} />
      <ellipse cx="40" cy="55" rx="9" ry="12" fill={body} />
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

function LiveBar() {
  return (
    <Link to="/network" className={styles.liveBar} style={{textDecoration: 'none'}}>
      <div className={styles.liveDot} />
      <span className={styles.liveLabel}>Network live</span>
      <span className={styles.liveSep}>|</span>
      <div className={styles.liveStat}>
        <span className={styles.liveNum}>3</span>
        <span className={styles.liveStatLabel}>Active peers</span>
      </div>
      <span className={styles.liveSep}>|</span>
      <div className={styles.liveStat}>
        <span className={styles.liveNum}>10</span>
        <span className={styles.liveStatLabel}>Models available</span>
      </div>
      <span style={{fontSize: '11px', color: '#16a863', fontFamily: "'JetBrains Mono', monospace", marginLeft: '4px'}}>→</span>
    </Link>
  );
}

function AppWindow() {
  return (
    <div className={styles.appWindow}>
      <div className={styles.appWindowBar}>
        <div className={styles.macDots}>
          <span className={styles.macDotRed} />
          <span className={styles.macDotYellow} />
          <span className={styles.macDotGreen} />
        </div>
        <span className={styles.macTitle}>AntFarm</span>
      </div>
      <div className={styles.appWindowPlaceholder}>
        <img src="/app-screenshot.jpg" alt="AntFarm app" className={styles.appWindowImg} />
      </div>
    </div>
  );
}

const TERMINAL_LINES: {text: string; type: 'cmd' | 'out' | 'success'; gap?: boolean}[] = [
  {text: '$ antseed connect', type: 'cmd'},
  {text: '> Discovering peers on the network...', type: 'out'},
  {text: '> Found 3 peers · 10 models available', type: 'out'},
  {text: '> Routing: DeepSeek-R1 · $0.08/M · 12ms', type: 'out'},
  {text: '> Ready. Routing to best provider...', type: 'out'},
  {text: '$ antseed models', type: 'cmd', gap: true},
  {text: '> claude-sonnet-4-6, deepseek-r1,', type: 'out'},
  {text: '  llama-4-maverick, qwen3.5-397b...', type: 'out'},
  {text: '✓ Ready. Point any OpenAI client here.', type: 'success', gap: true},
];

function TerminalWindow() {
  const [visibleCount, setVisibleCount] = useState(0);
  const [cursor, setCursor] = useState(true);

  useEffect(() => {
    const DELAYS = [0, 500, 950, 1400, 1850, 2600, 3100, 3450, 4050];
    const TOTAL = 4050;
    const PAUSE = 5000; // pause at full before reset

    let timers: ReturnType<typeof setTimeout>[] = [];

    function runCycle() {
      setVisibleCount(0);
      timers = DELAYS.map((d, idx) =>
        setTimeout(() => setVisibleCount(idx + 1), d)
      );
      // Loop after full display + pause
      timers.push(setTimeout(() => runCycle(), TOTAL + PAUSE));
    }

    runCycle();
    const blink = setInterval(() => setCursor(c => !c), 530);
    return () => {
      timers.forEach(clearTimeout);
      clearInterval(blink);
    };
  }, []);

  return (
    <div className={styles.terminal}>
      <div className={styles.terminalBar}>
        <div className={styles.macDots}>
          <span className={styles.macDotRed} />
          <span className={styles.macDotYellow} />
          <span className={styles.macDotGreen} />
        </div>
        <span className={styles.macTitle}>Terminal</span>
      </div>
      <div className={styles.terminalBody}>
        {TERMINAL_LINES.map((line, i) => (
          <div
            key={i}
            className={styles.terminalLine}
            style={{
              marginTop: line.gap ? '12px' : undefined,
              opacity: i < visibleCount ? 1 : 0,
              transition: 'opacity 0.15s ease',
            }}
          >
            <span className={
              line.type === 'cmd' ? styles.terminalCmd :
              line.type === 'success' ? styles.terminalSuccess :
              styles.terminalOut
            }>
              {line.text}
            </span>
          </div>
        ))}
        <span className={styles.terminalCursor} style={{opacity: cursor ? 1 : 0}}>▋</span>
      </div>
    </div>
  );
}

function Hero() {
  return (
    <div className={styles.hero}>
      <div className={styles.heroInner}>
        <h1 className={`${styles.heroTitle} animate-fade-up-1`}>
          Your AI tools,<br /><span className={styles.accent}>unstoppable.</span>
        </h1>
        <div className={`${styles.heroSubtitle} animate-fade-up-2`}>
          A Peer-to-Peer AI Services Network
        </div>
        <div className="animate-fade-up-3">
          <LiveBar />
        </div>

        {/* Consumer section */}
        <div className={`${styles.heroSection} animate-fade-up-4`}>
          <p className={styles.heroSectionLabel}>All the models. One chat. Totally anonymous and P2P.</p>
          <AppWindow />
          <div className={styles.platformBadges}>
            <a href={RELEASES_URL} target="_blank" rel="noopener noreferrer" className={styles.badgeMac}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.8-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z"/></svg>
              Download for Mac
            </a>
            <span className={styles.badgeComingSoon}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M3 5h18v14H3V5zm2 2v10h14V7H5zm2 2h10v2H7V9zm0 4h7v2H7v-2z"/></svg>
              Windows — soon
            </span>
            <span className={styles.badgeComingSoon}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M17.05 20.28c-.98.95-2.05.8-3.08.35-1.09-.46-2.09-.48-3.24 0-1.44.62-2.2.44-3.06-.35C2.79 15.25 3.51 7.7 9.05 7.4c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.39-1.32 2.76-2.54 3.99zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z"/></svg>
              iOS — soon
            </span>
            <span className={styles.badgeComingSoon}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M17.523 15.341c-.303 0-.548-.245-.548-.548V9.207c0-.303.245-.548.548-.548s.548.245.548.548v5.586c0 .303-.245.548-.548.548zm-11.046 0c-.303 0-.548-.245-.548-.548V9.207c0-.303.245-.548.548-.548s.548.245.548.548v5.586c0 .303-.245.548-.548.548zM17.12 7.365l1.065-1.954a.22.22 0 00-.09-.299.22.22 0 00-.299.09L16.72 7.17a6.635 6.635 0 00-2.72-.578 6.635 6.635 0 00-2.72.578L10.204 5.202a.22.22 0 00-.299-.09.22.22 0 00-.09.299l1.065 1.954A6.267 6.267 0 007.5 12h9a6.267 6.267 0 00-2.38-4.635zM10.5 10.5a.75.75 0 110-1.5.75.75 0 010 1.5zm3 0a.75.75 0 110-1.5.75.75 0 010 1.5z"/></svg>
              Android — soon
            </span>
          </div>
        </div>

        {/* Developer section */}
        <div className={`${styles.devSection} animate-fade-up-5`}>
          <div className={styles.devCard}>
            <div className={styles.devCardLabel}>For developers & agents</div>
            <h3 className={styles.devCardTitle}>Connect anything.<br />Route everywhere.</h3>
            <p className={styles.devCardDesc}>One command connects your tools to the entire network. Works with any OpenAI-compatible client.</p>
            <TerminalWindow />
          </div>
          <div className={styles.devCard}>
            <div className={styles.devCardLabel}>Works with</div>
            <h3 className={styles.devCardTitle}>Claude Code,<br />Cursor & more.</h3>
            <p className={styles.devCardDesc}>Point your existing tools at AntFarm. No code changes. Access every model on the network instantly.</p>
            <div className={styles.videoPlaceholder}>
              <div className={styles.videoStaticPlaceholder}>
                <span className={styles.videoPlaceholderIcon}>▶</span>
                <span className={styles.videoPlaceholderText}>Demo video</span>
              </div>
            </div>
          </div>
        </div>

      </div>
    </div>
  );
}

function UseCaseIcon({type}: {type: string}) {
  const c = '#3dffa2';
  if (type === 'models') return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3"/>
      <circle cx="4" cy="6" r="2"/>
      <circle cx="20" cy="6" r="2"/>
      <circle cx="4" cy="18" r="2"/>
      <circle cx="20" cy="18" r="2"/>
      <line x1="6" y1="6" x2="10" y2="11"/>
      <line x1="18" y1="6" x2="14" y2="11"/>
      <line x1="6" y1="18" x2="10" y2="13"/>
      <line x1="18" y1="18" x2="14" y2="13"/>
    </svg>
  );
  if (type === 'anon') return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2C8 2 4 5 4 9v2l-1 1v2h2v1a7 7 0 0 0 14 0v-1h2v-2l-1-1V9c0-4-4-7-8-7z"/>
      <circle cx="9" cy="12" r="1" fill={c}/>
      <circle cx="15" cy="12" r="1" fill={c}/>
    </svg>
  );
  if (type === 'failover') return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="23 4 23 10 17 10"/>
      <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
    </svg>
  );
  return null;
}

function UseCases() {
  const cases = [
    {
      type: 'models',
      title: 'Any model, one place',
      desc: 'Claude, DeepSeek, Llama, Qwen, and specialized agents — all available through a single connection. Switch models without switching tools or accounts.',
    },
    {
      type: 'anon',
      title: 'Anonymous by default',
      desc: 'Providers never know who you are — like a VPN, but for AI. Route to TEE nodes for uncensored models where not even the operator can see your prompts, or both.',
    },
    {
      type: 'failover',
      title: 'Never hit a limit',
      desc: 'Rate limited? Provider down? The network detects it instantly and reroutes to the next best provider. Automatic failover, zero data loss.',
    },
  ];
  return (
    <section className={styles.section}>
      <div className={`${styles.grid3} reveal`}>
        {cases.map((c) => (
          <div key={c.title} className={styles.card}>
            <div style={{marginBottom: '16px', opacity: 0.9}}><UseCaseIcon type={c.type} /></div>
            <h3 className={styles.cardTitle}>{c.title}</h3>
            <p className={styles.cardDesc}>{c.desc}</p>
          </div>
        ))}
      </div>
    </section>
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

const FAQ_ITEMS = [
  {
    q: 'What is AntSeed?',
    a: 'AntSeed is a peer-to-peer network for AI services. It connects buyers who need AI inference with providers who offer it — directly, without a central platform in the middle. Unlike cloud AI APIs (OpenAI, Anthropic, Google), there is no single company routing your requests or storing your data. The protocol handles discovery, routing, and payment settlement across a decentralized network of peers.',
  },
  {
    q: 'How is this different from ChatGPT or Claude?',
    a: 'ChatGPT and Claude are centralized AI products. AntSeed is open infrastructure — a protocol layer that lets you access any model on the network, including Claude Sonnet, DeepSeek-R1, Llama 4, Qwen, and more, without going through their native platforms. Your existing tools (Cursor, Claude Code, any OpenAI-compatible client) connect and work immediately without modification.',
  },
  {
    q: 'Is my data private?',
    a: 'Privacy starts at the network level — like a VPN for AI. Providers never know who you are. No accounts, no identity, no way to link a request back to you. That is the baseline for every request on AntSeed. From there, you can go deeper: TEE-verified providers run inside hardware enclaves where not even the node operator can read your prompts — cryptographic proof, not a policy promise. Multiple layers of privacy. You choose how deep you go.',
  },
  {
    q: 'Do I need to sign up or create an account?',
    a: 'No account required. Install the CLI with one command and you are connected to the network. Any tool that speaks the OpenAI API format works immediately — no API keys, no dashboards, no terms of service to accept.',
  },
];

function FAQSection() {
  const [open, setOpen] = useState<number | null>(null);
  return (
    <section className={`${styles.section} ${styles.sectionBorder}`} id="faq">
      <script type="application/ld+json" dangerouslySetInnerHTML={{__html: JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'FAQPage',
        mainEntity: FAQ_ITEMS.map(f => ({
          '@type': 'Question',
          name: f.q,
          acceptedAnswer: {'@type': 'Answer', text: f.a},
        })),
      })}} />
      <div className={`${styles.faqSection} reveal`}>
        <div className={styles.sectionTitle} style={{marginBottom: '40px'}}>Frequently asked questions</div>
        <div className={styles.faqList}>
          {FAQ_ITEMS.map((item, i) => (
            <div
              key={i}
              className={`${styles.faqItem} ${open === i ? styles.faqItemOpen : ''}`}
              onClick={() => setOpen(open === i ? null : i)}
            >
              <div className={styles.faqQuestion}>
                <span>{item.q}</span>
                <span className={styles.faqChevron} style={{transform: open === i ? 'rotate(180deg)' : 'rotate(0deg)'}}>▾</span>
              </div>
              {open === i && <div className={styles.faqAnswer}>{item.a}</div>}
            </div>
          ))}
        </div>
        <div className={styles.faqFooter}>
          <Link to="/docs/faq" className={styles.faqMoreLink}>See all FAQs →</Link>
        </div>
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
          <a href="https://github.com/AntSeed/antseed" target="_blank" rel="noopener noreferrer" className={styles.btnSecondary}>GitHub →</a>
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
      <BrowserOnly fallback={null}>
        {() => {
          const AntNetworkBackground = require('../components/AntNetworkBackground').default;
          return <AntNetworkBackground />;
        }}
      </BrowserOnly>
      <div ref={containerRef} style={{position: 'relative', zIndex: 3}}>
        {/* Solid bg covers animation over hero + use cases */}
        <div style={{background: '#f0f4f8', position: 'relative'}}>
          <Hero />
          <UseCases />
        </div>
        {/* Fade transition into animation */}
        <div style={{height: '60px', background: 'linear-gradient(to bottom, #f0f4f8, transparent)', position: 'relative', marginTop: '-60px'}} />
        {/* Animation visible all the way to the bottom — transparent backgrounds only */}
        <ThreeMarkets />
        <SupplySources />
        <CTASection />
        <FAQSection />
      </div>
    </Layout>
  );
}
