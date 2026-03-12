import {useEffect, useRef, useState, useMemo} from 'react';
import BrowserOnly from '@docusaurus/BrowserOnly';
import Link from '@docusaurus/Link';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import Layout from '@theme/Layout';
import styles from './index.module.css';

const RELEASES_URL = 'https://github.com/AntSeed/antseed/releases/latest';
const GH_API_LATEST = 'https://api.github.com/repos/AntSeed/antseed/releases/latest';

function buildDmgUrl(tag: string, arch: 'arm64' | 'x64'): string {
  const version = tag.replace(/^v/, '');
  const suffix = arch === 'arm64' ? '-arm64' : '';
  return `https://github.com/AntSeed/antseed/releases/download/${tag}/AntSeed-Desktop-${version}${suffix}.dmg`;
}

function isMac(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Macintosh|Mac OS X/.test(navigator.userAgent);
}

function useLatestRelease() {
  const [tag, setTag] = useState<string | null>(null);
  const [arch, setArch] = useState<'arm64' | 'x64'>('arm64');
  const mac = useMemo(isMac, []);

  useEffect(() => {
    if (!mac) return;

    // Detect architecture via UserAgentData API (Chromium browsers)
    // The legacy UA string always says "Intel" on macOS regardless of chip
    const nav = navigator as Navigator & { userAgentData?: { getHighEntropyValues(hints: string[]): Promise<{ architecture?: string }> } };
    if (nav.userAgentData?.getHighEntropyValues) {
      nav.userAgentData.getHighEntropyValues(['architecture'])
        .then(data => {
          if (data.architecture === 'x86') setArch('x64');
        })
        .catch(() => { /* keep default arm64 */ });
    }

    fetch(GH_API_LATEST)
      .then(r => r.json())
      .then(data => { if (data?.tag_name) setTag(data.tag_name as string); })
      .catch(() => { /* fall through to RELEASES_URL */ });
  }, [mac]);

  const dmgUrl = mac && tag ? buildDmgUrl(tag, arch) : null;
  return { dmgUrl };
}

/* ========== NAV ICONS (used in mockup nav) ========== */
/* Nav is handled by Docusaurus Layout — DO NOT TOUCH */

/* ========== LIVENESS BAR ========== */
const STATS_URL = 'https://network.antseed.com/stats';
const DEV_STATS_URL = 'http://localhost:4000/stats';

function useNetworkStats() {
  const [peerCount, setPeerCount] = useState<number | null>(null);
  const [serviceCount, setServiceCount] = useState<number | null>(null);

  useEffect(() => {
    const refresh = async () => {
      for (const url of [STATS_URL, DEV_STATS_URL]) {
        try {
          const res = await fetch(url, {signal: AbortSignal.timeout(5000)});
          if (!res.ok) continue;
          const data = await res.json();
          const peers = data.peers ?? [];
          const services = new Set<string>();
          for (const p of peers) for (const pr of p.providers ?? []) for (const m of pr.services ?? []) services.add(m);
          setPeerCount(peers.length);
          setServiceCount(services.size);
          return;
        } catch { /* try next */ }
      }
    };
    refresh();
    const interval = setInterval(refresh, 30_000);
    return () => clearInterval(interval);
  }, []);

  return {peerCount, serviceCount};
}

function LiveBar() {
  const {peerCount, serviceCount} = useNetworkStats();
  return (
    <Link to="/network" className={styles.lbar} style={{textDecoration:'none'}}>
      <div className={styles.litem}><span className={styles.ldot}/> <span>Network live</span></div>
      {peerCount != null && <>
        <div className={styles.ldiv}/>
        <div className={styles.litem}><strong>{peerCount}</strong> ACTIVE PEERS</div>
      </>}
      {serviceCount != null && <>
        <div className={styles.ldiv}/>
        <div className={styles.litem}><strong>{serviceCount}</strong> SERVICES AVAILABLE</div>
      </>}
      <span className={styles.liveArrow}>→</span>
    </Link>
  );
}

/* ========== EARN ANIMATION ========== */
function EarnAnimation() {
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [activeNode, setActiveNode] = useState(-1);
  const [feed, setFeed] = useState<{skill:string;amount:string;id:number}[]>([]);
  const startedRef = useRef(false);
  const totalRef = useRef(0);
  const feedIdRef = useRef(0);
  const hexProgRef = useRef<SVGPolygonElement>(null);
  const hexGlowRef = useRef<SVGPolygonElement>(null);

  const counter = totalRef.current.toFixed(3);

  const skills = ['Legal analysis skill','Code review agent','Translation skill','Writing assistant','Data analysis agent','Medical triage skill','Research agent','Tax advisory skill','Content pipeline','Compliance monitor'];

  // Ant particles circling the hex
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    // Hex vertices mapped to the 440x440 canvas (hex is inset 80px in 600px stage, canvas covers hex area)
    const hex = [{x:220,y:10},{x:410,y:110},{x:410,y:310},{x:220,y:410},{x:30,y:310},{x:30,y:110}];
    const ants = [
      {t:0, spd:0.008},
      {t:1.5, spd:0.006},
      {t:3.0, spd:0.010},
      {t:4.5, spd:0.007},
    ];
    let raf: number;
    function drawAnt(cx: number, cy: number, angle: number) {
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(angle);
      // Body: 3 ellipses (head, thorax, abdomen)
      ctx.fillStyle = '#1FD87A';
      ctx.globalAlpha = 0.85;
      ctx.beginPath(); ctx.ellipse(0, -4, 1.5, 2, 0, 0, Math.PI*2); ctx.fill(); // head
      ctx.beginPath(); ctx.ellipse(0, 0, 2, 2.5, 0, 0, Math.PI*2); ctx.fill(); // thorax
      ctx.beginPath(); ctx.ellipse(0, 5, 2.5, 3.5, 0, 0, Math.PI*2); ctx.fill(); // abdomen
      // Legs
      ctx.strokeStyle = '#1FD87A';
      ctx.lineWidth = 0.6;
      ctx.globalAlpha = 0.5;
      ctx.beginPath(); ctx.moveTo(-2, -1); ctx.lineTo(-6, -4); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(2, -1); ctx.lineTo(6, -4); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(-2, 1); ctx.lineTo(-6, 3); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(2, 1); ctx.lineTo(6, 3); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(-2.5, 4); ctx.lineTo(-6, 8); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(2.5, 4); ctx.lineTo(6, 8); ctx.stroke();
      // Antennae
      ctx.globalAlpha = 0.6;
      ctx.beginPath(); ctx.moveTo(-1, -5); ctx.lineTo(-4, -9); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(1, -5); ctx.lineTo(4, -9); ctx.stroke();
      ctx.restore();
    }
    function animate() {
      ctx.clearRect(0, 0, 440, 440);
      ants.forEach(a => {
        a.t += a.spd;
        if (a.t >= 6) a.t -= 6;
        const seg = Math.floor(a.t), frac = a.t - seg;
        const p1 = hex[seg % 6], p2 = hex[(seg + 1) % 6];
        const x = p1.x + (p2.x - p1.x) * frac;
        const y = p1.y + (p2.y - p1.y) * frac;
        // Ant faces direction of travel (clockwise along hex)
        const angle = Math.atan2(p2.y - p1.y, p2.x - p1.x) + Math.PI/2;
        drawAnt(x, y, angle);
      });
      raf = requestAnimationFrame(animate);
    }
    animate();
    return () => cancelAnimationFrame(raf);
  }, []);

  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    let timeout: ReturnType<typeof setTimeout>;
    const obs = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting && !startedRef.current) {
        startedRef.current = true;
        function fire() {
          const amt = (Math.random()*0.014+0.001).toFixed(3);
          totalRef.current += parseFloat(amt);
          setActiveNode(n => (n+1)%4);
          const skill = skills[Math.floor(Math.random()*skills.length)];
          setFeed(f => [...f.slice(-4), {skill, amount:amt, id:feedIdRef.current++}]);
          if (hexProgRef.current) {
            const pct = Math.min(totalRef.current/0.4, 1);
            const offset = String(1200 - 1200*pct);
            hexProgRef.current.style.strokeDashoffset = offset;
            if (hexGlowRef.current) hexGlowRef.current.style.strokeDashoffset = offset;
          }
          timeout = setTimeout(fire, 1000+Math.random()*1500);
        }
        timeout = setTimeout(fire, 400);
        obs.disconnect();
      }
    }, {threshold:0.15});
    obs.observe(el);
    return () => { obs.disconnect(); clearTimeout(timeout); };
  }, []);

  const nodeData = useMemo(() => [
    {cls:styles.nTop, label:'You provide', sub:'Services & Agents', icon:<svg viewBox="0 0 24 24" fill="none" stroke="#1FD87A" strokeWidth="1.8" strokeLinecap="round"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>},
    {cls:styles.nRight, label:'Users request', sub:'Routed to you', icon:<svg viewBox="0 0 24 24" fill="none" stroke="#1FD87A" strokeWidth="1.8" strokeLinecap="round"><circle cx="12" cy="12" r="3"/><circle cx="5" cy="6" r="1.5"/><circle cx="19" cy="6" r="1.5"/><circle cx="5" cy="18" r="1.5"/><circle cx="19" cy="18" r="1.5"/><line x1="10" y1="10" x2="6.2" y2="7.2"/><line x1="14" y1="10" x2="17.8" y2="7.2"/><line x1="10" y1="14" x2="6.2" y2="16.8"/><line x1="14" y1="14" x2="17.8" y2="16.8"/></svg>},
    {cls:styles.nBottom, label:'Settlement', sub:'Per request', icon:<svg viewBox="0 0 24 24" fill="none" stroke="#1FD87A" strokeWidth="1.8" strokeLinecap="round"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/><path d="M9 10h6M9 13h3"/></svg>},
    {cls:styles.nLeft, label:'You earn', sub:'Passive income', icon:<svg viewBox="0 0 24 24" fill="none" stroke="#1FD87A" strokeWidth="1.8" strokeLinecap="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v12M8 10c0-1.1 1.8-2 4-2s4 .9 4 2-1.8 2-4 2-4 .9-4 2 1.8 2 4 2 4-.9 4-2"/></svg>},
  ], []);

  return (
    <div ref={wrapperRef}>
      <div className={styles.earnStage} ref={stageRef} id="earn-stage">
        <svg className={styles.earnHex} viewBox="0 0 420 420">
          <defs><linearGradient id="hex-grad" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stopColor="#1FD87A"/><stop offset="100%" stopColor="#1FD87A"/></linearGradient></defs>
          <polygon className={styles.hexBg} points="210,25 385,115 385,305 210,395 35,305 35,115"/>
          <polygon className={styles.hexGlow} ref={hexGlowRef} points="210,25 385,115 385,305 210,395 35,305 35,115"/>
          <polygon className={styles.hexProgress} ref={hexProgRef} points="210,25 385,115 385,305 210,395 35,305 35,115"/>
        </svg>
        <canvas ref={canvasRef} width={440} height={440} style={{position:'absolute',top:'80px',left:'80px',width:'440px',height:'440px',pointerEvents:'none'}}/>

        <div className={styles.earnCenter}>
          <div className={styles.earnInnerRing}>
            <div className={styles.earnAmount}>${counter}</div>
            <div className={styles.earnLabel}>earned</div>
          </div>
        </div>
        {nodeData.map((n,i) => (
          <div key={i} className={`${styles.earnNode} ${n.cls} ${activeNode===i ? styles.earnNodeActive : ''}`}>
            <div className={styles.earnNodeIcon}>{n.icon}</div>
            <strong className={styles.earnNodeLabel}>{n.label}</strong>
            <span className={styles.earnNodeSub}>{n.sub}</span>
          </div>
        ))}
      </div>
      {/* Mobile fallback */}
      <div className={styles.earnMobile}>
        <div className={styles.earnMobileCounter}>
          <div className={styles.earnAmount}>${counter}</div>
          <div className={styles.earnLabel}>earned</div>
        </div>
        {nodeData.map((n,i) => (
          <div key={i} className={styles.earnMobileStep}>
            <div className={styles.earnMobileIcon}>{n.icon}</div>
            <div><span className={styles.earnMobileLabel}>{n.label}</span><span className={styles.earnMobileSub}>{n.sub}</span></div>
          </div>
        ))}
      </div>
      {/* Transaction feed — single instance, visible on both desktop and mobile */}
      <div className={styles.earnFeed}>
        {feed.map(f => (
          <div key={f.id} className={styles.feedRow}>
            <span className={styles.feedDot}/> {f.skill} <span className={styles.feedAmount}>+${f.amount}</span>
          </div>
        ))}
        <div className={styles.earnFeedFade}/>
      </div>
    </div>
  );
}

/* ========== FAQ ========== */
const FAQ_DATA = [
  {q:'What is AntSeed?', a:"AntSeed is a peer-to-peer network for AI. It connects people who need AI (users, developers, agents) directly with those who serve it: inference providers, specialized providers, and agent operators. No centralized middleman."},
  {q:'Is it really private?', a:"Privacy works in two layers. Layer 1, the base network: requests go peer-to-peer like a VPN, so the provider never knows who you are. No accounts, no identity, no IP exposed. Layer 2, TEE providers: hardware enclaves (Intel TDX, AMD SEV) where not even the operator can see your prompts. Cryptographic proof, not a policy promise. Payments are settled on-chain. The money trail stays private too. TEE verification is coming in a future release."},
  {q:'What services are available?', a:"Any service a provider chooses to offer. Open-weight models, specialized fine-tunes, uncensored inference, and providers using their own API access to other platforms. Available services depend on what providers are online right now. Check the <a href='/network'>network page</a> for a live view."},
  {q:'How do I earn on AntSeed?', a:"Provide inference or a specialized model. Run open-weight models, fine-tunes, or domain-specific skills and earn per request. Operate agents that solve real problems and rent them out on the network. Or just connect API keys you already have, like Together AI or other providers, and earn on traffic routed through you. The network is built on reputation. The more reliable your offering, the more traffic you attract."},
  {q:'Do I need an account or API key?', a:"No. Download AntStation, connect your wallet, and you're on the network. No sign-up, no API key, no credit card."},
  {q:'What is AntStation?', a:"AntStation is the desktop client for AntSeed. It gives you a chat interface, connects you to the P2P network, and handles service routing. For developers, the AntSeed CLI (@antseed/cli) exposes a local OpenAI-compatible endpoint so your existing tools (Claude Code, Codex, VS Code) can use the network too."},
  {q:'How is this different from OpenRouter or other API aggregators?', a:"No curation. Anyone can provide, anyone can consume. API aggregators are centralized intermediaries that decide which models you get access to, proxy your requests through their servers, require accounts, and can see your data. AntSeed is fully peer-to-peer. Your traffic goes directly from you to the provider. No middleman, no logs, no single point of failure or control. Plus, AntSeed is not just inference. The network supports specialized chat, autonomous agents, and skills-based providers, things no aggregator offers."},
];

function FAQSection() {
  const [openIdx, setOpenIdx] = useState<number|null>(null);
  return (
    <section className={styles.faq}>
      <h2 className={styles.faqTitle}>Frequently asked questions</h2>
      <div className={styles.faqList}>
        {FAQ_DATA.map((item, i) => (
          <div key={i} className={`${styles.faqItem} ${i===0 ? styles.faqItemFirst : ''}`}>
            <div className={styles.faqSummary} onClick={() => setOpenIdx(openIdx===i ? null : i)}>
              <span>{item.q}</span>
              <span className={`${styles.faqChevron} ${openIdx===i ? styles.faqChevronOpen : ''}`}>+</span>
            </div>
            <div className={`${styles.faqCollapse} ${openIdx===i ? styles.faqCollapseOpen : ''}`}>
              <div className={styles.faqCollapseInner}>
                <p className={styles.faqAnswer} dangerouslySetInnerHTML={{__html: item.a}}/>
              </div>
            </div>
          </div>
        ))}
      </div>
      <div className={styles.faqMore}>
        <Link to="/docs/faq" className={styles.faqMoreLink}>See all FAQs →</Link>
      </div>
    </section>
  );
}

/* ========== MAIN PAGE ========== */
export default function Home(): JSX.Element {
  const {siteConfig} = useDocusaurusContext();
  const {dmgUrl} = useLatestRelease();

  return (
    <Layout
      title={`${siteConfig.title} | ${siteConfig.tagline}`}
      description="An open market for machines to trade intelligence. Agents discover, carry, and deliver AI services peer-to-peer."
      wrapperClassName="homepage-wrapper">

      {/* Hero */}
      <section className={styles.hero}>
        <h1 className={styles.heroTitle}>The Unstoppable<br/>AI Economy</h1>
        <p className={styles.heroSub}>Access, build, and monetize AI. No middleman.</p>
      </section>

      {/* Liveness */}
      <section className={styles.live}><LiveBar /></section>

      {/* Tagline */}
      <div className={styles.tagline}>P2P inference. Specialized chat. Autonomous agents. One network.</div>

      {/* Download */}
      <div className={styles.downloads}>
        <a href={dmgUrl ?? RELEASES_URL} target="_blank" rel="noopener noreferrer" className={styles.dlbtn}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.8-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z"/></svg>
          Download for Mac
        </a>
        <a href={RELEASES_URL} target="_blank" rel="noopener noreferrer" className={styles.dlnote}>All releases →</a>
      </div>

      {/* Desktop App Video */}
      <div className={styles.mockupWrap}>
        <div className={styles.mac}>
          {/* <div className={styles.macBar}>
            <div className={styles.macDots}>
              <span className={styles.macDot} style={{background:'#ff5f56'}}/>
              <span className={styles.macDot} style={{background:'#ffbd2e'}}/>
              <span className={styles.macDot} style={{background:'#27c93f'}}/>
            </div>
            <div className={styles.macTitle}>AntStation</div>
            <div style={{width:'52px'}}/>
          </div> */}
          <video
            src="/videos/desktop-app.mp4"
            autoPlay
            loop
            muted
            playsInline
            style={{width:'100%',display:'block'}}
          />
        </div>
      </div>

      {/* Agents & Developers — full width */}
      <div className={styles.agentsSection}>
        <div className={styles.agentsCopy}>
          <div className={styles.cardLabel}>For Agents &amp; Developers</div>
          <h3>Connect anything.<br/>Route everywhere.</h3>
          <ul className={styles.agentsBullets}>
            <li>One command: <code>npm install -g @antseed/cli</code></li>
            <li>Works with any OpenAI-compatible client. No code changes</li>
            <li>Pick services, set routing preferences, or let the network decide</li>
          </ul>
          <Link to="/docs/intro" className={styles.agentsCta}>Read the Docs →</Link>
        </div>
        <div className={styles.agentsVideo}>
          <video
            src="/videos/claude-code.mp4"
            autoPlay
            loop
            muted
            playsInline
            style={{width:'100%',borderRadius:'8px',display:'block'}}
          />
          <div className={styles.compatChips}>
            <span className={styles.compatChip}>Claude Code</span>
            <span className={styles.compatChip}>Codex</span>
            <span className={styles.compatChip}>VS Code</span>
            <span className={styles.compatChip}>Any OpenAI client</span>
          </div>
        </div>
      </div>

      {/* Three feature cards */}
      <section className={styles.features}>
        <div className={styles.featuresGrid}>
          <div className={styles.feat}>
            <div className={styles.featIcon}><svg viewBox="0 0 44 44" fill="none"><rect x="2" y="2" width="40" height="40" rx="10" stroke="#1FD87A" strokeWidth="1.5" fill="#fff"/><circle cx="22" cy="22" r="8" stroke="#1FD87A" strokeWidth="1.5" fill="none"/><path d="M22 14v-4M22 34v-4M30 22h4M8 22h4" stroke="#1FD87A" strokeWidth="1.5" strokeLinecap="round"/><circle cx="22" cy="22" r="3" fill="#1FD87A"/></svg></div>
            <div className={styles.featTitle}>Anonymous Inference</div>
            <h4>Peer-to-peer. Anonymous. Always on.</h4>
            <p>Connect directly to real providers running different services. No corporate middleman. Every request is peer-to-peer. Choose TEE-secured nodes for maximum privacy, where not even the operator can see your data. No accounts, no logging, no lock-in.</p>
          </div>
          <div className={styles.feat}>
            <div className={styles.featIcon}><svg viewBox="0 0 44 44" fill="none"><rect x="2" y="2" width="40" height="40" rx="10" stroke="#1FD87A" strokeWidth="1.5" fill="#fff"/><path d="M14 18h16M14 22h12M14 26h8" stroke="#1FD87A" strokeWidth="1.5" strokeLinecap="round"/><circle cx="32" cy="14" r="4" fill="#1FD87A"/><path d="M30.5 14l1 1 2-2.5" stroke="#fff" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round"/></svg></div>
            <div className={styles.featTitle}>Specialized Chat</div>
            <h4>Expertise on demand.</h4>
            <p>Choose the right skilled inference for your domain. Legal, medical, financial, creative. Real expertise built specifically for the domain you need AI for. Pick a specialization, start talking. Providers earn every time you use their work.</p>
          </div>
          <div className={styles.feat}>
            <div className={styles.featIcon}><svg viewBox="0 0 44 44" fill="none"><rect x="2" y="2" width="40" height="40" rx="10" stroke="#1FD87A" strokeWidth="1.5" fill="#fff"/><circle cx="22" cy="22" r="9" stroke="#1FD87A" strokeWidth="1.5" fill="none"/><path d="M22 16v6l4 3" stroke="#1FD87A" strokeWidth="1.5" strokeLinecap="round"/><circle cx="22" cy="22" r="2" fill="#1FD87A"/><path d="M15 10l-2-3M29 10l2-3" stroke="#1FD87A" strokeWidth="1.5" strokeLinecap="round"/></svg></div>
            <div className={styles.featTitle}>Agents That Work For You</div>
            <h4>Hire AI agents. Let them handle it.</h4>
            <p>Need a code reviewer, compliance monitor, or research assistant? Hire an always-on agent from the network. They run 24/7, switch services and providers as needed, and you only pay for what they do. No setup, no infrastructure, no babysitting.</p>
          </div>
        </div>
      </section>

      {/* Build Once. Earn Forever. */}
      <section className={styles.creator}>
        <h2 className={styles.creatorTitle}>Build Once. Earn Forever.</h2>
        <p className={styles.creatorSub}>A new economy for AI providers. Run services, serve specialized inference, deploy agents. Earn per request, directly from users. No middleman. No permission needed. No kill switch on your income.</p>
        <BrowserOnly fallback={null}>{() => <EarnAnimation />}</BrowserOnly>
        <Link to="/docs/intro" className={styles.creatorCta}>Start Building →</Link>
      </section>

      {/* Join the economy */}
      <section className={styles.supply}>
        <div className={styles.supplyHeader}>
          <h2>Join the economy.</h2>
          <p>There are three ways to earn on the network.</p>
        </div>
        <div className={styles.supplyGrid}>
          <div className={styles.supplyCol}>
            <div className={styles.supplyLabel}>Inference Providers</div>
            <h4>Serve services. Earn per request.</h4>
            <p>Your own hardware, a cloud deployment, or your existing API keys. Connect and start earning. Run open-weight models, specialized fine-tunes, TEE-secured nodes, or API-backed inference. The network is built on reputation. The more reliable your offering, the more traffic you attract.</p>
          </div>
          <div className={styles.supplyCol}>
            <div className={styles.supplyLabel}>Specialized Providers</div>
            <h4>Domain expertise. Premium pricing.</h4>
            <p>Run fine-tuned or domain-specific models. Legal, medical, financial. Your expertise built into a skill running on the right model is the specialized inference chat. The more unique your offering, the more demand you attract.</p>
          </div>
          <div className={styles.supplyCol}>
            <div className={styles.supplyLabel}>Agent Operators</div>
            <h4>Build an agent. Rent it out.</h4>
            <p>You built an agent that solves a real problem. Code review, compliance checks, research pipelines, automated workflows. Put it on the network and let others rent it for specific jobs. Your agent runs 24/7, serves paying users, and you earn every time someone uses it. Build once, get paid forever.</p>
          </div>

        </div>
      </section>

      {/* How it works */}
      <section className={styles.how}>
        <h2>How it works.</h2>
        <div className={styles.howLabel}>For users</div>
        <div className={styles.howSteps}>
          <div className={styles.howStep}><div className={styles.howNum}>1</div><h4>Download AntStation</h4><p>Install the app. Connect your wallet. You're on the network. No sign-up, no credit card.</p></div>
          <span className={styles.howArrow}>→</span>
          <div className={styles.howStep}><div className={styles.howNum}>2</div><h4>Connect to the network</h4><p>AntStation discovers peers automatically. Choose your priority: cost, speed, quality, or privacy.</p></div>
          <span className={styles.howArrow}>→</span>
          <div className={styles.howStep}><div className={styles.howNum}>3</div><h4>Start chatting</h4><p>Use it as commodity inference. Pick your service, specialized chat, or the job that needs to get done.</p></div>
        </div>
        <div className={styles.howLabel} style={{marginTop:'48px'}}>For developers &amp; agents</div>
        <div className={styles.howSteps}>
          <div className={styles.howStep}><div className={styles.howNum}>1</div><h4>Install the CLI</h4><p>One command: npm install -g @antseed/cli. You get a local OpenAI-compatible endpoint. Your existing tools work instantly.</p></div>
          <span className={styles.howArrow}>→</span>
          <div className={styles.howStep}><div className={styles.howNum}>2</div><h4>Pick what you need</h4><p>Commodity inference, specialized chat, or a full agent for the job. Browse what's available or let the network route for you.</p></div>
          <span className={styles.howArrow}>→</span>
          <div className={styles.howStep}><div className={styles.howNum}>3</div><h4>Build with it</h4><p>Pipe it into your app, your agent, your workflow. Switch services and providers without changing code. Pay per request, nothing else.</p></div>
        </div>
      </section>

      {/* Works with your tools */}
      <section className={styles.compat}>
        <h3>Works with your tools</h3>
        <div className={styles.compatLogos}>
          <div className={styles.compatItem}>
            <div className={styles.compatIcon}><svg viewBox="0 0 24 24" fill="none" stroke="#1a1a1a" strokeWidth="1.5" strokeLinecap="round"><path d="M8 3H5a2 2 0 00-2 2v3m18 0V5a2 2 0 00-2-2h-3m0 18h3a2 2 0 002-2v-3M3 16v3a2 2 0 002 2h3"/><path d="M7 12h10M12 7v10" stroke="#1FD87A" strokeWidth="2"/></svg></div>
            <span className={styles.compatName}>Claude Code</span>
          </div>
          <div className={styles.compatItem}>
            <div className={styles.compatIcon}><svg viewBox="0 0 24 24" fill="none" stroke="#1a1a1a" strokeWidth="1.5" strokeLinecap="round"><path d="M9 3H5a2 2 0 00-2 2v4m6-6h10a2 2 0 012 2v4M9 3v18m0 0h10a2 2 0 002-2v-4M9 21H5a2 2 0 01-2-2v-4m0 0h18"/></svg></div>
            <span className={styles.compatName}>Codex</span>
          </div>
          <div className={styles.compatItem}>
            <div className={styles.compatIcon}><svg viewBox="0 0 24 24" fill="none" stroke="#1a1a1a" strokeWidth="1.5" strokeLinecap="round"><path d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4"/></svg></div>
            <span className={styles.compatName}>VS Code</span>
          </div>
          <div className={styles.compatItem}>
            <div className={styles.compatIcon}><svg viewBox="0 0 24 24" fill="none" stroke="#1a1a1a" strokeWidth="1.5" strokeLinecap="round"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M9 9h6M9 12h6M9 15h4"/></svg></div>
            <span className={styles.compatName}>Any OpenAI client</span>
          </div>
        </div>
      </section>

      {/* Bottom CTAs */}
      <section className={styles.bottomCtas}>
        <div className={styles.bottomCard} style={{ maxWidth: 480, margin: '0 auto' }}>
          <h3>Read the Light Paper</h3>
          <p>Understand the protocol, the architecture, and the economics behind the unstoppable AI economy.</p>
          <Link to="/docs/lightpaper" className={styles.bottomBtn}>Read Light Paper →</Link>
        </div>
      </section>

      {/* FAQ */}
      <FAQSection />

    </Layout>
  );
}