import {useEffect, useRef, useState} from 'react';
import BrowserOnly from '@docusaurus/BrowserOnly';
import Link from '@docusaurus/Link';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import Layout from '@theme/Layout';
import styles from './index.module.css';

const RELEASES_URL = 'https://github.com/AntSeed/antseed/releases/latest';

function AntMarkFull({size = 48}: {size?: number}) {
  const c = '#3dffa2';
  const body = '#0a0e14';
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
    const PAUSE = 5000;

    let timers: ReturnType<typeof setTimeout>[] = [];

    function runCycle() {
      setVisibleCount(0);
      timers = DELAYS.map((d, idx) =>
        setTimeout(() => setVisibleCount(idx + 1), d)
      );
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
          The Unstoppable<br /><span className={styles.accent}>AI Economy</span>
        </h1>
        <div className={`${styles.heroSubtitle} animate-fade-up-2`}>
          ACCESS, BUILD, AND MONETIZE AI. NO MIDDLEMAN.
        </div>
        <div className="animate-fade-up-3">
          <LiveBar />
        </div>

        {/* Consumer section */}
        <div className={`${styles.heroSection} animate-fade-up-4`}>
          <p className={styles.heroSectionLabel}>Private inference. Specialised chat. Autonomous agents. One network.</p>
          <AppWindow />
          <div className={styles.platformBadges}>
            <a href={RELEASES_URL} target="_blank" rel="noopener noreferrer" className={styles.badgeMac}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.8-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z"/></svg>
              Download for Mac
            </a>
            <p className={styles.dlNote}>Other platforms soon</p>
          </div>
        </div>

        {/* Developer section */}
        <div className={`${styles.devSection} animate-fade-up-5`}>
          <div className={styles.devCard}>
            <div className={styles.devCardLabel}>For developers &amp; agents</div>
            <h3 className={styles.devCardTitle}>Connect anything.<br />Route everywhere.</h3>
            <p className={styles.devCardDesc}>One command connects your tools to the entire network. Works with any OpenAI-compatible client.</p>
            <TerminalWindow />
          </div>
          <div className={styles.devCard}>
            <div className={styles.devCardLabel}>Works with</div>
            <h3 className={styles.devCardTitle}>Claude Code,<br />Cursor &amp; more.</h3>
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

function FeatureCards() {
  const cards = [
    {
      title: 'Private Inference',
      heading: 'Anonymous. TEE-secured. Always on.',
      desc: 'Every open model, one connection. Your prompts never touch a corporate server. Route to TEE nodes where not even the operator can see your data. No logging, no accounts, no lock-in. Switch models and providers freely.',
      icon: (
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#3dffa2" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3"/>
          <path d="M12 2v2M12 20v2M2 12h2M20 12h2"/>
          <path d="M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/>
        </svg>
      ),
    },
    {
      title: 'Specialised Chat',
      heading: 'Expertise on demand.',
      desc: 'Chat with AI that actually knows your domain. Legal, medical, financial, creative. Real expertise packaged as skills by real people. Pick a specialisation, start talking. Skill creators earn every time you use their work.',
      icon: (
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#3dffa2" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/>
          <line x1="9" y1="10" x2="15" y2="10"/>
          <line x1="9" y1="13" x2="12" y2="13"/>
        </svg>
      ),
    },
    {
      title: 'Specialised Agents',
      heading: 'Specialised AI that works for you, 24/7.',
      desc: 'Deploy specialised agents that run continuously on the network. Expert skills running autonomously. Reviewing code, monitoring systems, publishing content, executing workflows. Built by creators, powered by the swarm, always earning.',
      icon: (
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#3dffa2" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="9"/>
          <path d="M12 6v6l4 3"/>
        </svg>
      ),
    },
  ];

  return (
    <section className={styles.section}>
      <div className={`${styles.grid3} reveal`}>
        {cards.map((c) => (
          <div key={c.title} className={styles.card}>
            <div style={{marginBottom: '16px', opacity: 0.9}}>{c.icon}</div>
            <div className={styles.cardTitle}>{c.title}</div>
            <h3 className={styles.cardHeading}>{c.heading}</h3>
            <p className={styles.cardDesc}>{c.desc}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function BuildOnceEarnForever() {
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [earnings, setEarnings] = useState('0.000');
  const [activeNode, setActiveNode] = useState(-1);
  const [feed, setFeed] = useState<{skill: string; amount: string; id: number}[]>([]);
  const startedRef = useRef(false);
  const feedIdRef = useRef(0);
  const totalRef = useRef(0);

  const skills = ['Legal analysis skill','Code review agent','Translation skill','Writing assistant','Data analysis agent','Medical triage skill','Research agent','Tax advisory skill','Content pipeline','Compliance monitor'];

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const W = 400, H = 400;
    const hex = [{x:200,y:24},{x:367,y:110},{x:367,y:290},{x:200,y:376},{x:33,y:290},{x:33,y:110}];

    interface ParticleType {
      t: number; speed: number; size: number; opacity: number;
      update: () => void; draw: () => void;
    }

    function makeParticle(speed: number, size: number, opacity: number): ParticleType {
      return {
        t: Math.random() * 6, speed, size, opacity,
        update() { this.t += this.speed; if (this.t >= 6) this.t -= 6; },
        draw() {
          const seg = Math.floor(this.t); const frac = this.t - seg;
          const a = hex[seg % 6]; const b = hex[(seg + 1) % 6];
          const x = a.x + (b.x - a.x) * frac; const y = a.y + (b.y - a.y) * frac;
          ctx.beginPath(); ctx.arc(x, y, this.size * 3, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(61,255,162,${this.opacity * 0.15})`; ctx.fill();
          ctx.beginPath(); ctx.arc(x, y, this.size, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(61,255,162,${this.opacity})`; ctx.fill();
        },
      };
    }

    const particles = [
      makeParticle(0.012,4,0.9), makeParticle(0.008,3,0.6),
      makeParticle(0.005,2.5,0.4), makeParticle(0.015,3.5,0.7), makeParticle(0.006,2,0.35),
    ];
    let raf: number;
    function animate() { ctx.clearRect(0,0,W,H); particles.forEach(p=>{p.update();p.draw();}); raf = requestAnimationFrame(animate); }
    animate();
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    let timeout: ReturnType<typeof setTimeout>;

    const obs = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting && !startedRef.current) {
          startedRef.current = true;
          function fire() {
            const amount = (Math.random() * 0.014 + 0.001).toFixed(3);
            totalRef.current += parseFloat(amount);
            setEarnings(totalRef.current.toFixed(3));
            setActiveNode(n => (n + 1) % 4);
            const skill = skills[Math.floor(Math.random() * skills.length)];
            const id = feedIdRef.current++;
            setFeed(f => [...f.slice(-4), {skill, amount, id}]);
            timeout = setTimeout(fire, 1000 + Math.random() * 1500);
          }
          timeout = setTimeout(fire, 400);
          obs.disconnect();
        }
      });
    }, {threshold: 0.15});
    obs.observe(el);
    return () => { obs.disconnect(); clearTimeout(timeout); };
  }, []);

  const nodeConfigs = [
    {className: styles.earnNodeTop, label: 'You build', sub: 'Skill or agent'},
    {className: styles.earnNodeRight, label: 'Peers run', sub: 'Network hosts it'},
    {className: styles.earnNodeBottom, label: 'Users pay', sub: 'Per request'},
    {className: styles.earnNodeLeft, label: 'You earn', sub: 'Passive income'},
  ];

  const nodeIcons = [
    <svg key="build" viewBox="0 0 24 24" fill="none" stroke="#3dffa2" strokeWidth="1.8" strokeLinecap="round"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>,
    <svg key="run" viewBox="0 0 24 24" fill="none" stroke="#3dffa2" strokeWidth="1.8" strokeLinecap="round"><circle cx="12" cy="12" r="3"/><circle cx="5" cy="6" r="1.5"/><circle cx="19" cy="6" r="1.5"/><circle cx="5" cy="18" r="1.5"/><circle cx="19" cy="18" r="1.5"/><line x1="10" y1="10" x2="6.2" y2="7.2"/><line x1="14" y1="10" x2="17.8" y2="7.2"/><line x1="10" y1="14" x2="6.2" y2="16.8"/><line x1="14" y1="14" x2="17.8" y2="16.8"/></svg>,
    <svg key="pay" viewBox="0 0 24 24" fill="none" stroke="#3dffa2" strokeWidth="1.8" strokeLinecap="round"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>,
    <svg key="earn" viewBox="0 0 24 24" fill="none" stroke="#3dffa2" strokeWidth="1.8" strokeLinecap="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v12M8 10c0-1.1 1.8-2 4-2s4 .9 4 2-1.8 2-4 2-4 .9-4 2 1.8 2 4 2 4-.9 4-2"/></svg>,
  ];

  return (
    <section className={styles.earnSection}>
      <div className="reveal">
        <h2 className={styles.earnTitle}>Build Once. Earn Forever.</h2>
        <p className={styles.earnSub}>A new creator economy for AI. Package your expertise into a skill. Deploy it as a chat or an autonomous agent. Earn every time someone uses it. No app store. No platform cut. No kill switch on your income.</p>
      </div>

      {/* Desktop hex visualization */}
      <div className={styles.earnStage} ref={stageRef}>
        <svg style={{position:'absolute',top:'60px',left:'60px',right:'60px',bottom:'60px',width:'calc(100% - 120px)',height:'calc(100% - 120px)'}} viewBox="0 0 420 420">
          <defs>
            <linearGradient id="hexGrad" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#3dffa2"/>
              <stop offset="100%" stopColor="#2ecf85"/>
            </linearGradient>
          </defs>
          <polygon fill="none" stroke="#3dffa2" strokeWidth="8" opacity="0.06" style={{filter:'blur(6px)'}} points="210,25 385,115 385,305 210,395 35,305 35,115"/>
          <polygon fill="none" stroke="#e8e8e3" strokeWidth="0.5" opacity="0.4" points="210,80 340,150 340,270 210,340 80,270 80,150"/>
          <polygon fill="none" stroke="#e8e8e3" strokeWidth="1.5" points="210,25 385,115 385,305 210,395 35,305 35,115"/>
          <polygon fill="none" stroke="url(#hexGrad)" strokeWidth="2.5" strokeLinecap="round" points="210,25 385,115 385,305 210,395 35,305 35,115"/>
        </svg>
        <canvas ref={canvasRef} width={400} height={400} style={{position:'absolute',top:'60px',left:'60px',width:'400px',height:'400px',pointerEvents:'none'}} />

        {/* Center badge */}
        <div className={styles.earnCenter}>
          <div className={styles.earnInnerRing}>
            <div className={styles.earnAmount}>${earnings}</div>
            <div className={styles.earnLabel}>earned</div>
          </div>
        </div>

        {/* Nodes */}
        {nodeConfigs.map((n, i) => (
          <div key={i} className={`${styles.earnNode} ${n.className} ${activeNode === i ? styles.earnNodeActive : ''}`}>
            <div className={styles.earnNodeIcon}>{nodeIcons[i]}</div>
            <strong style={{fontSize:'11px'}}>{n.label}</strong>
            <span style={{fontSize:'10px',color:'#6b7280'}}>{n.sub}</span>
          </div>
        ))}
      </div>

      {/* Feed */}
      <div className={styles.earnFeed}>
        {feed.map(f => (
          <div key={f.id} className={styles.feedRow}>
            <span className={styles.feedDot} />
            <span>{f.skill}</span>
            <span className={styles.feedAmount}>+${f.amount}</span>
          </div>
        ))}
      </div>

      {/* Mobile fallback */}
      <div className={styles.earnMobile}>
        <div className={styles.earnMobileCounter}>
          <div className={styles.earnAmount}>${earnings}</div>
          <div className={styles.earnLabel}>earned</div>
        </div>
        {nodeConfigs.map((n, i) => (
          <div key={i} className={styles.earnMobileStep}>
            <div className={styles.earnMobileIcon}>{nodeIcons[i]}</div>
            <div>
              <strong style={{display:'block',fontSize:'14px',marginBottom:'2px'}}>{n.label}</strong>
              <span style={{fontSize:'12px',color:'#6b7280'}}>{n.sub}</span>
            </div>
          </div>
        ))}
      </div>

      <Link to="/docs/intro" className={styles.earnCta}>Start Building →</Link>
    </section>
  );
}

function JoinEconomy() {
  const cols = [
    {
      label: 'Inference Providers',
      heading: 'Serve models. Earn per request.',
      desc: 'You have a way to serve inference. Your own hardware, a cloud deployment, a fine-tuned model for a specific domain or language. Connect to the network and start earning. Run open-weight models, specialised fine-tunes, uncensored models, TEE-secured nodes. The more unique or reliable your offering, the more traffic you attract.',
    },
    {
      label: 'Skill Creators',
      heading: 'Package expertise. Get paid.',
      desc: "You're a lawyer, trader, doctor, developer, musician. You know things models don't. Package that knowledge into a skill. Prompts, fine-tuning, tools, domain data. Deploy it as a chat or an agent. Earn every time someone uses your work.",
    },
    {
      label: 'Agent Builders',
      heading: 'Build once. Runs forever.',
      desc: "Combine skills, inference, and tools into autonomous agents that run 24/7 on the swarm. A compliance monitor. A content pipeline. A research assistant. They use other providers' compute and other creators' skills. Everyone in the chain earns.",
    },
  ];

  return (
    <section className={styles.section}>
      <div className="reveal">
        <div className={styles.sectionTitle}>Join the economy.</div>
        <div className={styles.sectionDesc}>Three ways to earn on the network. Bring expertise, bring inference, or build agents that combine both.</div>
      </div>
      <div className={`${styles.grid3} reveal`}>
        {cols.map(c => (
          <div key={c.label} className={styles.card}>
            <div className={styles.cardTitle}>{c.label}</div>
            <h3 className={styles.cardHeading}>{c.heading}</h3>
            <p className={styles.cardDesc}>{c.desc}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function HowItWorksV9() {
  const rows = [
    {
      label: 'FOR USERS',
      steps: [
        {n:'1', title:'Download AntFarm', desc:"Install the app. No sign-up, no API key, no credit card. You're connected to the network instantly."},
        {n:'2', title:'Connect to the swarm', desc:'AntFarm discovers peers automatically. Choose your priority: cost, speed, quality, or privacy.'},
        {n:'3', title:'Chat, build, or earn', desc:'Use it as a chat app. Pick a specialised skill. Or package your own expertise and start earning.'},
      ],
    },
    {
      label: 'FOR DEVELOPERS & AGENTS',
      steps: [
        {n:'1', title:'Install the SDK', desc:'One command: npm install antseed. Or just point any OpenAI-compatible client at your local AntFarm endpoint.'},
        {n:'2', title:'Route to the network', desc:'Your code connects to the swarm automatically. Pick models, set routing preferences, or let OpenMind decide.'},
        {n:'3', title:'Ship and scale', desc:'No API keys to manage. No rate limits. No vendor lock-in. Your agents run on the network, always on.'},
      ],
    },
  ];

  return (
    <section className={styles.section}>
      <div className="reveal">
        <div className={styles.sectionTitle}>How it works.</div>
      </div>
      {rows.map(row => (
        <div key={row.label} className="reveal" style={{marginBottom: '48px'}}>
          <div className={styles.sectionLabel} style={{marginBottom: '24px'}}>{row.label}</div>
          <div className={styles.howSteps}>
            {row.steps.map((s, i) => (
              <div key={s.n} className={styles.howStepWrap}>
                <div className={styles.howStep}>
                  <div className={styles.howNum}>{s.n}</div>
                  <h4 className={styles.howTitle}>{s.title}</h4>
                  <p className={styles.cardDesc}>{s.desc}</p>
                </div>
                {i < 2 && <span className={styles.howArrow}>→</span>}
              </div>
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}

function WorksWith() {
  const tools = [
    {
      name: 'Claude Code',
      icon: <svg viewBox="0 0 24 24" fill="none" stroke="#1a1a1a" strokeWidth="1.5" strokeLinecap="round"><path d="M8 3H5a2 2 0 00-2 2v3m18 0V5a2 2 0 00-2-2h-3m0 18h3a2 2 0 002-2v-3M3 16v3a2 2 0 002 2h3"/><path d="M7 12h10M12 7v10" stroke="#3dffa2" strokeWidth="2"/></svg>,
    },
    {
      name: 'Cursor',
      icon: <svg viewBox="0 0 24 24" fill="none" stroke="#1a1a1a" strokeWidth="1.5" strokeLinecap="round"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>,
    },
    {
      name: 'VS Code',
      icon: <svg viewBox="0 0 24 24" fill="none" stroke="#1a1a1a" strokeWidth="1.5" strokeLinecap="round"><path d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4"/></svg>,
    },
    {
      name: 'Any OpenAI client',
      icon: <svg viewBox="0 0 24 24" fill="none" stroke="#1a1a1a" strokeWidth="1.5" strokeLinecap="round"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M9 9h6M9 12h6M9 15h4"/></svg>,
    },
  ];

  return (
    <section className={styles.section} style={{textAlign: 'center'}}>
      <div className="reveal">
        <div className={styles.sectionLabel}>Works with your tools</div>
        <div className={styles.compatLogos}>
          {tools.map(t => (
            <div key={t.name} className={styles.compatItem}>
              <div className={styles.compatIcon}>{t.icon}</div>
              <span className={styles.compatName}>{t.name}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function LightPaperAndSubscribe() {
  const [email, setEmail] = useState('');
  const [subscribed, setSubscribed] = useState(false);

  return (
    <section className={`${styles.section} ${styles.sectionBorder}`}>
      <div className={`${styles.bottomGrid} reveal`}>
        <div className={styles.bottomCard}>
          <h3 className={styles.bottomCardTitle}>Read the Light Paper</h3>
          <p className={styles.cardDesc}>Understand the protocol, the architecture, and the economics behind the unstoppable AI economy.</p>
          <Link to="/docs/lightpaper" className={styles.btnPrimary}>Read Light Paper →</Link>
        </div>
        <div className={styles.bottomCard}>
          <h3 className={styles.bottomCardTitle}>Stay in the loop</h3>
          <p className={styles.cardDesc}>Get updates on new features, platform launches, network milestones, and everything AntSeed.</p>
          {subscribed ? (
            <p style={{color: '#3dffa2', fontFamily: "'JetBrains Mono', monospace", fontSize: '13px'}}>You're in. We'll be in touch.</p>
          ) : (
            <div className={styles.subscribeForm}>
              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="your@email.com"
                className={styles.subscribeInput}
              />
              <button className={styles.subscribeBtn} onClick={() => email && setSubscribed(true)}>Subscribe</button>
            </div>
          )}
        </div>
      </div>
    </section>
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
        <div style={{background: '#f0f4f8', position: 'relative'}}>
          <Hero />
          <FeatureCards />
        </div>
        <div style={{height: '60px', background: 'linear-gradient(to bottom, #f0f4f8, transparent)', position: 'relative', marginTop: '-60px'}} />
        <BrowserOnly fallback={null}>
          {() => <BuildOnceEarnForever />}
        </BrowserOnly>
        <JoinEconomy />
        <HowItWorksV9 />
        <WorksWith />
        <LightPaperAndSubscribe />
      </div>
    </Layout>
  );
}