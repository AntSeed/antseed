import {useEffect, useRef, useState, Fragment} from 'react';
import BrowserOnly from '@docusaurus/BrowserOnly';
import Link from '@docusaurus/Link';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import Layout from '@theme/Layout';
import styles from './index.module.css';

const RELEASES_URL = 'https://github.com/AntSeed/antseed/releases/latest';

/* ========== NAV ICONS (used in mockup nav) ========== */
/* Nav is handled by Docusaurus Layout — DO NOT TOUCH */

/* ========== LIVENESS BAR ========== */
// TODO: Replace hardcoded stats with live data from network API
function LiveBar() {
  return (
    <Link to="/network" className={styles.lbar} style={{textDecoration:'none'}}>
      <div className={styles.litem}><span className={styles.ldot}/> <span>Network live</span></div>
      {/* <div className={styles.ldiv}/>
      <div className={styles.litem}><strong>3</strong> ACTIVE PEERS</div>
      <div className={styles.ldiv}/>
      <div className={styles.litem}><strong>10</strong> MODELS AVAILABLE</div> */}
      <span className={styles.liveArrow}>→</span>
    </Link>
  );
}

/* ========== ANTFARM MOCKUP (inline dark UI) ========== */
function AntFarmMockup() {
  return (
    <div className={styles.mockupWrap}>
      <div className={styles.mac}>
        <div className={styles.macBar}>
          <div className={styles.macDots}>
            <span className={styles.macDot} style={{background:'#ff5f56'}}/>
            <span className={styles.macDot} style={{background:'#ffbd2e'}}/>
            <span className={styles.macDot} style={{background:'#27c93f'}}/>
          </div>
          <div className={styles.macTitle}>AntFarm</div>
          <div style={{width:'52px'}}/>
        </div>
        <div className={styles.macBody}>
          <div style={{display:'flex',justifyContent:'space-between',width:'100%',maxWidth:'420px',marginBottom:'20px'}}>
            <div className={styles.appPills}>
              <span className={`${styles.appPill} ${styles.appPillAuto}`}>Auto</span>
              <span className={`${styles.appPill} ${styles.appPillManual}`}>Manual</span>
            </div>
            <div className={styles.appPills}>
              <span className={`${styles.appPill} ${styles.appPillOpt}`}>Low Cost</span>
              <span className={`${styles.appPill} ${styles.appPillOpt}`}>Low Latency</span>
              <span className={`${styles.appPill} ${styles.appPillOpt}`}>Best Quality</span>
              <span className={`${styles.appPill} ${styles.appPillOpt}`}>Max Privacy</span>
            </div>
          </div>
          <div style={{marginBottom:'14px'}}>
            <svg width="48" height="48" viewBox="0 0 100 100" fill="none">
              <circle cx="50" cy="62" r="14" fill="#3dffa2"/><circle cx="50" cy="30" r="5" fill="#3dffa2"/>
              <circle cx="26" cy="22" r="4" fill="#3dffa2" opacity=".7"/><circle cx="74" cy="22" r="4" fill="#3dffa2" opacity=".7"/>
              <line x1="50" y1="48" x2="50" y2="35" stroke="#3dffa2" strokeWidth="2"/>
              <line x1="42" y1="52" x2="28" y2="25" stroke="#3dffa2" strokeWidth="1.5" opacity=".6"/>
              <line x1="58" y1="52" x2="72" y2="25" stroke="#3dffa2" strokeWidth="1.5" opacity=".6"/>
            </svg>
          </div>
          <div className={styles.appWelcome}>Welcome to Ant<span style={{color:'#3dffa2'}}>Seed</span></div>
          <div className={styles.appDesc}>You're connected to 3 free community peers. Start chatting. No sign-up, no API key, no credit card.</div>
          <div className={styles.appStatus}>
            <span style={{width:'5px',height:'5px',borderRadius:'50%',background:'#3dffa2',display:'inline-block'}}/> 3 peers · llama-4-scout · Free tier
          </div>
          <div className={styles.appCards}>
            <div className={styles.appCard}><div className={styles.appCardTitle}>💬 Just chat</div><div className={styles.appCardDesc}>General knowledge, brainstorming</div></div>
            <div className={styles.appCard}><div className={styles.appCardTitle}>✍️ Write something</div><div className={styles.appCardDesc}>Emails, posts, creative writing</div></div>
            <div className={styles.appCard}><div className={styles.appCardTitle}>&lt;/&gt; Help me code</div><div className={styles.appCardDesc}>Debug, refactor, explain</div></div>
            <div className={styles.appCard}><div className={styles.appCardTitle}>🔗 Explore providers</div><div className={styles.appCardDesc}>Private, uncensored, skilled</div></div>
          </div>
          <div className={styles.appInput}>
            <span>Message the swarm...</span>
            <div className={styles.appSend}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#0a0a0a" strokeWidth="3" strokeLinecap="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>
            </div>
          </div>
          <div className={styles.appRoute}>Routed → <span style={{color:'#3dffa2'}}>OpenMind</span> · llama-4-scout · $0.12/M tokens</div>
        </div>
      </div>
    </div>
  );
}

/* ========== TERMINAL (animated, looping) ========== */
const TERM_LINES: {text:string; cls:'cmd'|'out'|'grn'; delay:number}[] = [
  {text:'$ antseed connect', cls:'cmd', delay:600},
  {text:'> Discovering peers on the network...', cls:'out', delay:800},
  {text:'> Found 3 peers · 10 models available', cls:'out', delay:600},
  {text:'> Routing: DeepSeek-R1 · $0.08/M · 12ms', cls:'out', delay:500},
  {text:'> Ready. Routing to best provider...', cls:'out', delay:800},
  {text:'', cls:'out', delay:300},
  {text:'$ antseed models', cls:'cmd', delay:600},
  {text:'> claude-sonnet-4-6, deepseek-r1,', cls:'out', delay:400},
  {text:'  llama-4-maverick, qwen3.5-397b...', cls:'out', delay:400},
  {text:'', cls:'out', delay:300},
  {text:'✓ Ready. Point any OpenAI client here.', cls:'grn', delay:0},
];

function TerminalCard() {
  const [visibleCount, setVisibleCount] = useState(0);
  const [cursorVisible, setCursorVisible] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];

    function runCycle() {
      if (cancelled) return;
      setVisibleCount(0);
      let total = 0;
      TERM_LINES.forEach((_line, i) => {
        total += _line.delay;
        timers.push(setTimeout(() => { if (!cancelled) setVisibleCount(i + 1); }, total));
      });
      total += 3000;
      timers.push(setTimeout(() => { if (!cancelled) runCycle(); }, total));
    }

    // Start immediately
    runCycle();

    const blink = setInterval(() => setCursorVisible(v => !v), 530);
    return () => { cancelled = true; timers.forEach(clearTimeout); clearInterval(blink); };
  }, []);

  return (
    <div className={styles.terminal}>
      <div className={styles.termBar}>
        <span className={styles.termDot} style={{background:'#ff5f56'}}/>
        <span className={styles.termDot} style={{background:'#ffbd2e'}}/>
        <span className={styles.termDot} style={{background:'#27c93f'}}/>
        <div className={styles.termTitle}>Terminal</div>
      </div>
      <div className={styles.termBody}>
        {TERM_LINES.slice(0, visibleCount).map((line, i) => {
          if (line.text === '') return <br key={i}/>;
          return (
            <div key={i} style={{color: line.cls === 'cmd' ? '#e8e8e8' : line.cls === 'grn' ? '#3dffa2' : '#888', fontWeight: line.cls === 'cmd' ? 600 : 400}}>
              {line.text}
            </div>
          );
        })}
        <span style={{color:'#3dffa2', opacity: cursorVisible ? 1 : 0}}>▋</span>
      </div>
    </div>
  );
}

/* ========== EARN ANIMATION ========== */
function EarnAnimation() {
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [counter, setCounter] = useState('0.000');
  const [activeNode, setActiveNode] = useState(-1);
  const [feed, setFeed] = useState<{skill:string;amount:string;id:number}[]>([]);
  const startedRef = useRef(false);
  const totalRef = useRef(0);
  const feedIdRef = useRef(0);
  const hexProgRef = useRef<SVGPolygonElement>(null);
  const hexGlowRef = useRef<SVGPolygonElement>(null);

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
      ctx.fillStyle = '#2ecf85';
      ctx.globalAlpha = 0.85;
      ctx.beginPath(); ctx.ellipse(0, -4, 1.5, 2, 0, 0, Math.PI*2); ctx.fill(); // head
      ctx.beginPath(); ctx.ellipse(0, 0, 2, 2.5, 0, 0, Math.PI*2); ctx.fill(); // thorax
      ctx.beginPath(); ctx.ellipse(0, 5, 2.5, 3.5, 0, 0, Math.PI*2); ctx.fill(); // abdomen
      // Legs
      ctx.strokeStyle = '#2ecf85';
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

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    let timeout: ReturnType<typeof setTimeout>;
    const obs = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting && !startedRef.current) {
        startedRef.current = true;
        function fire() {
          const amt = (Math.random()*0.014+0.001).toFixed(3);
          totalRef.current += parseFloat(amt);
          setCounter(totalRef.current.toFixed(3));
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

  const nodeData = [
    {cls:styles.nTop, label:'You build', sub:'Skill or agent', icon:<svg viewBox="0 0 24 24" fill="none" stroke="#2ecf85" strokeWidth="1.8" strokeLinecap="round"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>},
    {cls:styles.nRight, label:'Peers run', sub:'Network hosts it', icon:<svg viewBox="0 0 24 24" fill="none" stroke="#2ecf85" strokeWidth="1.8" strokeLinecap="round"><circle cx="12" cy="12" r="3"/><circle cx="5" cy="6" r="1.5"/><circle cx="19" cy="6" r="1.5"/><circle cx="5" cy="18" r="1.5"/><circle cx="19" cy="18" r="1.5"/><line x1="10" y1="10" x2="6.2" y2="7.2"/><line x1="14" y1="10" x2="17.8" y2="7.2"/><line x1="10" y1="14" x2="6.2" y2="16.8"/><line x1="14" y1="14" x2="17.8" y2="16.8"/></svg>},
    {cls:styles.nBottom, label:'Users pay', sub:'Per request', icon:<svg viewBox="0 0 24 24" fill="none" stroke="#2ecf85" strokeWidth="1.8" strokeLinecap="round"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/><path d="M9 10h6M9 13h3"/></svg>},
    {cls:styles.nLeft, label:'You earn', sub:'Passive income', icon:<svg viewBox="0 0 24 24" fill="none" stroke="#2ecf85" strokeWidth="1.8" strokeLinecap="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v12M8 10c0-1.1 1.8-2 4-2s4 .9 4 2-1.8 2-4 2-4 .9-4 2 1.8 2 4 2 4-.9 4-2"/></svg>},
  ];

  return (
    <>
      <div className={styles.earnStage} ref={stageRef} id="earn-stage">
        <svg className={styles.earnHex} viewBox="0 0 420 420">
          <defs><linearGradient id="hex-grad" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stopColor="#3dffa2"/><stop offset="100%" stopColor="#2ecf85"/></linearGradient></defs>
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
      <div className={styles.earnFeed}>
        {feed.map(f => (
          <div key={f.id} className={styles.feedRow}>
            <span className={styles.feedDot}/> {f.skill} <span className={styles.feedAmount}>+${f.amount}</span>
          </div>
        ))}
        <div className={styles.earnFeedFade}/>
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
    </>
  );
}

/* ========== FAQ ========== */
const FAQ_DATA = [
  {q:'What is AntSeed?', a:"AntSeed is a peer-to-peer network for AI services. It connects people who need AI (users, developers, agents) directly with people who provide it (inference providers, skill creators, agent builders) with no centralised middleman."},
  {q:'Is it really private?', a:"By default, you're anonymous. No accounts, no sign-up, no tracking. You connect to providers directly with no corporate server in the middle. For maximum privacy, some providers offer TEE-secured nodes where not even the operator can see your data. The same applies to skills and agents on the network."},
  {q:'What models are available?', a:"Any open-weight model that providers choose to serve. Available models depend on what providers are currently online. Check the <a href='/network'>network page</a> for a live view."},
  {q:'How do I earn on AntSeed?', a:"Three ways: serve inference (run models and get paid per request), create skills (package domain expertise and earn when people use it), or build agents (deploy autonomous AI that uses others' compute and skills, everyone in the chain earns)."},
  {q:'Do I need an account or API key?', a:"No. Download AntFarm, open it, and you're connected. No sign-up, no API key, no credit card. Free community peers are available immediately."},
  {q:'What is AntFarm?', a:"AntFarm is the desktop client for AntSeed. It gives you a chat interface, connects you to the P2P network, handles model routing, and exposes a local OpenAI-compatible endpoint so your existing tools (Claude Code, Cursor, VS Code) can use the network too."},
  {q:'How is this different from OpenRouter or other API aggregators?', a:"Aggregators like OpenRouter are single providers on the network, not the network itself. They take up to 5.5% on every request and control who gets access. AntSeed is an open network where any provider can compete freely on price, speed, and quality. No platform cut. No gatekeeper. Just providers competing for your traffic."},
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
              <span className={styles.faqChevron}>{openIdx===i ? '−' : '+'}</span>
            </div>
            {openIdx===i && <p className={styles.faqAnswer} dangerouslySetInnerHTML={{__html: item.a}}/>}
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
  const [email, setEmail] = useState('');

  return (
    <Layout
      title={`${siteConfig.title} — ${siteConfig.tagline}`}
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
      <div className={styles.tagline}>Private inference. Specialised chat. Autonomous agents. One network.</div>

      {/* Download */}
      <div className={styles.downloads}>
        <a href={RELEASES_URL} target="_blank" rel="noopener noreferrer" className={styles.dlbtn}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.8-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z"/></svg>
          Download for Mac
        </a>
        <span className={styles.dlnote}>Other platforms soon</span>
      </div>

      {/* Desktop App Video */}
      <div className={styles.mockupWrap}>
        <video
          src="/videos/desktop-app.mp4"
          autoPlay
          loop
          muted
          playsInline
          style={{width:'100%',borderRadius:'12px',display:'block'}}
        />
      </div>

      {/* Two cards: Developer + Works With */}
      <div className={styles.twoCards}>
        <div className={styles.card}>
          <div className={styles.cardLabel}>For Developers &amp; Agents</div>
          <h3>Connect anything.<br/>Route everywhere.</h3>
          <p>One command connects your tools to the entire network. Works with any OpenAI-compatible client.</p>
          <BrowserOnly fallback={null}>{() => <TerminalCard />}</BrowserOnly>
        </div>
        <div className={styles.card}>
          <div className={styles.cardLabel}>Works With</div>
          <h3>Claude Code,<br/>Cursor &amp; more.</h3>
          <p>Point your existing tools at AntFarm. No code changes. Access every model on the network instantly.</p>
          <video
            src="/videos/claude-code.mp4"
            autoPlay
            loop
            muted
            playsInline
            style={{width:'100%',borderRadius:'8px',display:'block',marginTop:'16px'}}
          />
        </div>
      </div>

      {/* Three feature cards */}
      <section className={styles.features}>
        <div className={styles.featuresGrid}>
          <div className={styles.feat}>
            <div className={styles.featIcon}><svg viewBox="0 0 44 44" fill="none"><rect x="2" y="2" width="40" height="40" rx="10" stroke="#2ecf85" strokeWidth="1.5" fill="#fff"/><circle cx="22" cy="22" r="8" stroke="#2ecf85" strokeWidth="1.5" fill="none"/><path d="M22 14v-4M22 34v-4M30 22h4M8 22h4" stroke="#2ecf85" strokeWidth="1.5" strokeLinecap="round"/><circle cx="22" cy="22" r="3" fill="#2ecf85"/></svg></div>
            <div className={styles.featTitle}>Private Inference</div>
            <h4>Anonymous by default. Always on.</h4>
            <p>Every open model, one connection. No accounts, no sign-up, no tracking. You connect directly to providers with no corporate server in the middle. For maximum privacy, choose TEE-secured providers where not even the operator can see your data. No lock-in. Switch models and providers freely.</p>
          </div>
          <div className={styles.feat}>
            <div className={styles.featIcon}><svg viewBox="0 0 44 44" fill="none"><rect x="2" y="2" width="40" height="40" rx="10" stroke="#2ecf85" strokeWidth="1.5" fill="#fff"/><path d="M14 18h16M14 22h12M14 26h8" stroke="#2ecf85" strokeWidth="1.5" strokeLinecap="round"/><circle cx="32" cy="14" r="4" fill="#2ecf85"/><path d="M30.5 14l1 1 2-2.5" stroke="#fff" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round"/></svg></div>
            <div className={styles.featTitle}>Specialised Chat</div>
            <h4>Expertise on demand.</h4>
            <p>Chat with AI that actually knows your domain. Legal, medical, financial, creative. Real expertise packaged as skills by real people. Pick a specialisation, start talking. Skill creators earn every time you use their work.</p>
          </div>
          <div className={styles.feat}>
            <div className={styles.featIcon}><svg viewBox="0 0 44 44" fill="none"><rect x="2" y="2" width="40" height="40" rx="10" stroke="#2ecf85" strokeWidth="1.5" fill="#fff"/><circle cx="22" cy="22" r="9" stroke="#2ecf85" strokeWidth="1.5" fill="none"/><path d="M22 16v6l4 3" stroke="#2ecf85" strokeWidth="1.5" strokeLinecap="round"/><circle cx="22" cy="22" r="2" fill="#2ecf85"/><path d="M15 10l-2-3M29 10l2-3" stroke="#2ecf85" strokeWidth="1.5" strokeLinecap="round"/></svg></div>
            <div className={styles.featTitle}>Specialised Agents</div>
            <h4>Specialised AI that works for you, 24/7.</h4>
            <p>Deploy specialised agents that run continuously on the network. Expert skills running autonomously. Reviewing code, monitoring systems, publishing content, executing workflows. Built by creators, powered by the swarm, always earning.</p>
          </div>
        </div>
      </section>

      {/* Build Once. Earn Forever. */}
      <section className={styles.creator}>
        <h2 className={styles.creatorTitle}>Build Once. Earn Forever.</h2>
        <p className={styles.creatorSub}>A new creator economy for AI. Package your expertise into a skill. Deploy it as a chat or an autonomous agent. Earn every time someone uses it. No app store. No platform cut. No kill switch on your income.</p>
        <BrowserOnly fallback={null}>{() => <EarnAnimation />}</BrowserOnly>
        <Link to="/docs/intro" className={styles.creatorCta}>Start Building →</Link>
      </section>

      {/* Join the economy */}
      <section className={styles.supply}>
        <div className={styles.supplyHeader}>
          <h2>Join the economy.</h2>
          <p>Three ways to earn on the network. Bring expertise, bring inference, or build agents that combine both.</p>
        </div>
        <div className={styles.supplyGrid}>
          <div className={styles.supplyCol}>
            <div className={styles.supplyLabel}>Inference Providers</div>
            <h4>Serve models. Earn per request.</h4>
            <p>You have a way to serve inference. Your own hardware, a cloud deployment, a fine-tuned model for a specific domain or language. Connect to the network and start earning. Run open-weight models, specialised fine-tunes, uncensored models, TEE-secured nodes. The more unique or reliable your offering, the more traffic you attract.</p>
          </div>
          <div className={styles.supplyCol}>
            <div className={styles.supplyLabel}>Skill Creators</div>
            <h4>Package expertise. Get paid.</h4>
            <p>You're a lawyer, trader, doctor, developer, musician. You know things models don't. Package that knowledge into a skill. Prompts, fine-tuning, tools, domain data. Deploy it as a chat or an agent. Earn every time someone uses your work.</p>
          </div>
          <div className={styles.supplyCol}>
            <div className={styles.supplyLabel}>Agent Builders</div>
            <h4>Build once. Runs forever.</h4>
            <p>Combine skills, inference, and tools into autonomous agents that run 24/7 on the swarm. A compliance monitor. A content pipeline. A research assistant. They use other providers' compute and other creators' skills. Everyone in the chain earns.</p>
          </div>
        </div>
      </section>

      {/* How it works */}
      <section className={styles.how}>
        <h2>How it works.</h2>
        <div className={styles.howLabel}>For users</div>
        <div className={styles.howSteps}>
          <div className={styles.howStep}><div className={styles.howNum}>1</div><h4>Download AntFarm</h4><p>Install the app. No sign-up, no API key, no credit card. You're connected to the network instantly.</p></div>
          <span className={styles.howArrow}>→</span>
          <div className={styles.howStep}><div className={styles.howNum}>2</div><h4>Connect to the swarm</h4><p>AntFarm discovers peers automatically. Choose your priority: cost, speed, quality, or privacy.</p></div>
          <span className={styles.howArrow}>→</span>
          <div className={styles.howStep}><div className={styles.howNum}>3</div><h4>Chat, build, or earn</h4><p>Use it as a chat app. Pick a specialised skill. Or package your own expertise and start earning.</p></div>
        </div>
        <div className={styles.howLabel} style={{marginTop:'48px'}}>For developers &amp; agents</div>
        <div className={styles.howSteps}>
          <div className={styles.howStep}><div className={styles.howNum}>1</div><h4>Install the SDK</h4><p>One command: npm install antseed. Or just point any OpenAI-compatible client at your local AntFarm endpoint.</p></div>
          <span className={styles.howArrow}>→</span>
          <div className={styles.howStep}><div className={styles.howNum}>2</div><h4>Route to the network</h4><p>Your code connects to the swarm automatically. Pick models, set routing preferences, or let OpenMind decide.</p></div>
          <span className={styles.howArrow}>→</span>
          <div className={styles.howStep}><div className={styles.howNum}>3</div><h4>Ship and scale</h4><p>No API keys to manage. No rate limits. No vendor lock-in. Your agents run on the network, always on.</p></div>
        </div>
      </section>

      {/* Works with your tools */}
      <section className={styles.compat}>
        <h3>Works with your tools</h3>
        <div className={styles.compatLogos}>
          <div className={styles.compatItem}>
            <div className={styles.compatIcon}><svg viewBox="0 0 24 24" fill="none" stroke="#1a1a1a" strokeWidth="1.5" strokeLinecap="round"><path d="M8 3H5a2 2 0 00-2 2v3m18 0V5a2 2 0 00-2-2h-3m0 18h3a2 2 0 002-2v-3M3 16v3a2 2 0 002 2h3"/><path d="M7 12h10M12 7v10" stroke="#2ecf85" strokeWidth="2"/></svg></div>
            <span className={styles.compatName}>Claude Code</span>
          </div>
          <div className={styles.compatItem}>
            <div className={styles.compatIcon}><svg viewBox="0 0 24 24" fill="none" stroke="#1a1a1a" strokeWidth="1.5" strokeLinecap="round"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg></div>
            <span className={styles.compatName}>Cursor</span>
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
        <div className={styles.bottomGrid}>
          <div className={styles.bottomCard}>
            <h3>Read the Light Paper</h3>
            <p>Understand the protocol, the architecture, and the economics behind the unstoppable AI economy.</p>
            <Link to="/docs/lightpaper" className={styles.bottomBtn}>Read Light Paper →</Link>
          </div>
          <div className={styles.bottomCard}>
            <h3>Stay in the loop</h3>
            <p>Get updates on new features, platform launches, network milestones, and everything AntSeed.</p>
            <div className={styles.waitlistForm}>
              <input type="email" className={styles.waitlistInput} placeholder="your@email.com" value={email} onChange={e=>setEmail(e.target.value)}/>
              <button className={styles.waitlistBtn}>Subscribe</button>
            </div>
          </div>
        </div>
      </section>

      {/* FAQ */}
      <FAQSection />

    </Layout>
  );
}