import {useEffect, useRef, useState, useMemo} from 'react';
import BrowserOnly from '@docusaurus/BrowserOnly';
import Link from '@docusaurus/Link';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import Layout from '@theme/Layout';
import styles from './index.module.css';
import {useLatestDesktopDownload, RELEASES_URL} from '../lib/useLatestDesktopDownload';
import {DesktopDownloadIcon} from '../lib/DesktopDownloadIcon';

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
          const services: string[] = [];
          for (const p of peers) for (const pr of p.providers ?? []) for (const m of pr.services ?? []) services.push(m);
          setPeerCount(peers.length);
          setServiceCount(services.length);
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
  const initialSkills = ['claude-sonnet-4-6 · raw inference','Legal in Guatemala · AI Agent','TEE Router · routing','llama-3-70b · raw inference','Price Router · routing'];
  const initialFeed = initialSkills.map((skill, i) => ({skill, amount:(Math.random()*0.014+0.001).toFixed(3), id:i}));
  const [feed, setFeed] = useState<{skill:string;amount:string;id:number}[]>(initialFeed);
  const startedRef = useRef(false);
  const totalRef = useRef(initialFeed.reduce((s,f) => s + parseFloat(f.amount), 0));
  const feedIdRef = useRef(initialFeed.length);
  const hexProgRef = useRef<SVGPolygonElement>(null);
  const hexGlowRef = useRef<SVGPolygonElement>(null);

  const counter = totalRef.current.toFixed(3);

  const skills = [
    'claude-sonnet-4-6 · raw inference',
    'Legal in Guatemala · AI Agent',
    'TEE Router · routing',
    'llama-3-70b · raw inference',
    'Price Router · routing',
    'Solidity Auditor · AI Agent',
    'mistral-large · raw inference',
    'Result Router · routing',
    'Medical Diagnostics BR · AI Agent',
    'gemma-3-27b · raw inference',
    'Latency Router · routing',
    'Company Intelligence · AI Agent',
  ];

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
    {cls:styles.nTop, label:'You offer', sub:'Expertise & Services', icon:<svg viewBox="0 0 24 24" fill="none" stroke="#1FD87A" strokeWidth="1.8" strokeLinecap="round"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>},
    {cls:styles.nRight, label:'Buyers request', sub:'Matched to you', icon:<svg viewBox="0 0 24 24" fill="none" stroke="#1FD87A" strokeWidth="1.8" strokeLinecap="round"><circle cx="12" cy="12" r="3"/><circle cx="5" cy="6" r="1.5"/><circle cx="19" cy="6" r="1.5"/><circle cx="5" cy="18" r="1.5"/><circle cx="19" cy="18" r="1.5"/><line x1="10" y1="10" x2="6.2" y2="7.2"/><line x1="14" y1="10" x2="17.8" y2="7.2"/><line x1="10" y1="14" x2="6.2" y2="16.8"/><line x1="14" y1="14" x2="17.8" y2="16.8"/></svg>},
    {cls:styles.nBottom, label:'Delivery verified', sub:'On-chain proof', icon:<svg viewBox="0 0 24 24" fill="none" stroke="#1FD87A" strokeWidth="1.8" strokeLinecap="round"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/><path d="M9 10h6M9 13h3"/></svg>},
    {cls:styles.nLeft, label:'You earn', sub:'Reputation grows', icon:<svg viewBox="0 0 24 24" fill="none" stroke="#1FD87A" strokeWidth="1.8" strokeLinecap="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v12M8 10c0-1.1 1.8-2 4-2s4 .9 4 2-1.8 2-4 2-4 .9-4 2 1.8 2 4 2 4-.9 4-2"/></svg>},
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
  {q:'How is this different from OpenRouter?', a:"OpenRouter is a centralized aggregator: it decides which models are listed, reads every request, and holds your earnings until payout. AntSeed removes the aggregator entirely. Requests go peer-to-peer. Payments settle on-chain directly to the provider's wallet. Anyone can provide — no approval needed. The network has no company behind it and no off switch."},
  {q:'What happens when LLMs become so good that anyone can do anything?', a:"That is exactly what we want. When LLMs become dramatically more capable, costs collapse and more people can run their own capable LLMs on their own hardware. Those people become AntSeed providers. The supply side grows, not shrinks. But \"anyone can do anything\" does not mean everyone delivers the same result. The value is in what you build on top: the skills, the workflows, the domain expertise, the agent orchestration. A more capable base model raises the ceiling for every provider, but it does not eliminate the distance between a generic prompt and a production-grade service."},
  {q:"Isn't this just like P2P file sharing? Netflix killed that.", a:"Netflix and Spotify won because humans are happy to pay a simple subscription for a clean UI. But that logic only applies to humans who care about experience. Agents don't. An agent has no preference for a polished interface, no reason to care about a brand, no inertia keeping it on a familiar platform. It just needs the service, the price, and the reliability. On those three axes, an open P2P network with no middleman and no markup wins every time."},
  {q:'Is AntSeed built for agents specifically?', a:"It works for humans today and is being used by humans now. But the architecture decisions: USDC-native payments, no account system, open discovery, always-on peers, are all decisions that make the network ideal for agents. A human tolerates signing up, waiting for API keys, and managing a subscription. An agent cannot. The network AntSeed is building is the one autonomous agents will naturally discover and use."},
  {q:'Why would a provider use AntSeed instead of just building their own API?', a:"Building your own API means building billing infrastructure, handling support, managing uptime, acquiring customers, and maintaining a reputation system from scratch. That is a startup, not a service. AntSeed gives you distribution: buyers already on the network looking for exactly what you offer, plus a reputation system that makes your track record portable and permanent, plus payments handled at the protocol level. You focus on the thing you're good at. The network handles the rest."},
];

function FAQSection() {
  const [openIdx, setOpenIdx] = useState<number|null>(null);
  return (
    <section className={styles.faq}>
      <h2 className={styles.faqTitle}>Q&A</h2>
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
  const download = useLatestDesktopDownload();

  return (
    <Layout
      title={siteConfig.tagline}
      description="The open market for AI inference. Serve or consume AI peer-to-peer. Pay per request in USDC. Anonymous. Private. No gatekeepers."
      wrapperClassName="homepage-wrapper">

      {/* Hero */}
      <section className={styles.hero}>
        <h1 className={styles.heroTitle}>The open market for AI inference.</h1>
        <p className={styles.heroSub}>Permissionless peer-to-peer. Pay per request in USDC.</p>
      </section>

      {/* Liveness */}
      <section className={styles.live}><LiveBar /></section>

      {/* Local Gateway */}
      <section className={styles.gateway}>
        <h2 className={styles.gatewayTitle}>Your local gateway to AI providers</h2>
        <p className={styles.gatewaySub}>No central registry. One localhost endpoint.</p>
        <div className={styles.gatewayCards}>
          <div className={`${styles.gwCard} ${styles.gwCardLocal}`}>
            <span className={`${styles.gwBadge} ${styles.gwBadgeLocal}`}>Local</span>
            <div className={styles.gwName}>AntSeed Proxy</div>
            <div className={`${styles.gwUrl} ${styles.gwUrlLocal}`}>http://localhost:8377</div>
            <div className={styles.gwRoute}>
              <div className={styles.gwRouteNode}>
                <span className={styles.gwDot} style={{background:'#1FD87A'}} />
                <span className={styles.gwRouteLabel}>You</span>
              </div>
              <div className={`${styles.gwRouteLine} ${styles.gwRouteLineGreen}`} />
              <div className={styles.gwRouteNode}>
                <span className={styles.gwDot} style={{background:'#1FD87A'}} />
                <span className={styles.gwRouteLabel}>Provider</span>
              </div>
            </div>
            <div className={styles.gwTags}>
              <span className={`${styles.gwTag} ${styles.gwTagGreen}`}>direct</span>
              <span className={`${styles.gwTag} ${styles.gwTagGreen}`}>onchain</span>
              <span className={`${styles.gwTag} ${styles.gwTagGreen}`}>private</span>
            </div>
          </div>
          <div className={styles.gwCard}>
            <span className={`${styles.gwBadge} ${styles.gwBadgeCloud}`}>Cloud</span>
            <div className={styles.gwName}>Cloud Proxy</div>
            <div className={styles.gwUrl}>https://api.cloud-provider.com</div>
            <div className={styles.gwRoute}>
              <div className={styles.gwRouteNode}>
                <span className={styles.gwDot} style={{background:'#ccc'}} />
                <span className={styles.gwRouteLabel}>You</span>
              </div>
              <div className={styles.gwRouteLine} />
              <div className={styles.gwRouteNode}>
                <span className={styles.gwDot} style={{background:'#ccc'}} />
                <span className={styles.gwRouteLabel}>Proxy API</span>
              </div>
              <div className={styles.gwRouteLine} />
              <div className={styles.gwRouteNode}>
                <span className={styles.gwDot} style={{background:'#ccc'}} />
                <span className={styles.gwRouteLabel}>Provider</span>
              </div>
            </div>
            <div className={styles.gwTags}>
              <span className={`${styles.gwTag} ${styles.gwTagMuted}`}>via gatekeeper</span>
              <span className={`${styles.gwTag} ${styles.gwTagMuted}`}>custodial</span>
              <span className={`${styles.gwTag} ${styles.gwTagMuted}`}>logged</span>
            </div>
          </div>
        </div>
      </section>

      {/* AntStation */}
      <div className={styles.agentsSection}>
        <div className={styles.agentsCopy}>
          <h3>AntStation</h3>
          <p className={styles.agentsVision}>Your desktop gateway to the AntSeed network. Provide services, route requests, and manage your node. All from one app.</p>
          <div className={styles.downloads} style={{alignItems:'flex-start',padding:0}}>
            <a href={download.href} target="_blank" rel="noopener noreferrer" className={styles.dlbtn}>
              <DesktopDownloadIcon platform={download.platform} />
              {download.label}
            </a>
            <a href={RELEASES_URL} target="_blank" rel="noopener noreferrer" className={styles.dlnote}>All releases →</a>
          </div>
        </div>
        <div className={styles.agentsVideo}>
          <video
            src="/videos/desktop-app-v2.mp4"
            autoPlay
            loop
            muted
            playsInline
            style={{width:'100%',borderRadius:'8px',display:'block',border:'1px solid #e0e0db',boxShadow:'0 4px 20px rgba(0,0,0,0.06)'}}
          />
        </div>
      </div>

      {/* What is AntSeed — unified feature section */}
      <section className={styles.features}>
        <div className={styles.featuresGrid}>
          <div className={styles.feat}>
            <div className={styles.featIcon}><svg viewBox="0 0 44 44" fill="none"><rect x="2" y="2" width="40" height="40" rx="10" stroke="#1FD87A" strokeWidth="1.5" fill="#fff"/><circle cx="22" cy="22" r="8" stroke="#1FD87A" strokeWidth="1.5" fill="none"/><path d="M22 14v-4M22 34v-4M30 22h4M8 22h4" stroke="#1FD87A" strokeWidth="1.5" strokeLinecap="round"/><circle cx="22" cy="22" r="3" fill="#1FD87A"/></svg></div>
            <h4>True peer-to-peer. No relay.</h4>
            <p>Requests travel directly to the provider. No central server that can read your traffic, log your prompts, or be shut down.</p>
          </div>
          <div className={styles.feat}>
            <div className={styles.featIcon}><svg viewBox="0 0 44 44" fill="none"><rect x="2" y="2" width="40" height="40" rx="10" stroke="#1FD87A" strokeWidth="1.5" fill="#fff"/><path d="M14 18h16M14 22h12M14 26h8" stroke="#1FD87A" strokeWidth="1.5" strokeLinecap="round"/><circle cx="32" cy="14" r="4" fill="#1FD87A"/><path d="M30.5 14l1 1 2-2.5" stroke="#fff" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round"/></svg></div>
            <h4>On-Chain Stats. Build Reputation.</h4>
            <p>Every delivery produces a cryptographically signed receipt. Stats are on-chain. Reputation belongs to your wallet. No platform can revoke what you earned.</p>
          </div>
          <div className={styles.feat}>
            <div className={styles.featIcon}><svg viewBox="0 0 44 44" fill="none"><rect x="2" y="2" width="40" height="40" rx="10" stroke="#1FD87A" strokeWidth="1.5" fill="#fff"/><circle cx="22" cy="22" r="9" stroke="#1FD87A" strokeWidth="1.5" fill="none"/><path d="M22 16v6l4 3" stroke="#1FD87A" strokeWidth="1.5" strokeLinecap="round"/><circle cx="22" cy="22" r="2" fill="#1FD87A"/><path d="M15 10l-2-3M29 10l2-3" stroke="#1FD87A" strokeWidth="1.5" strokeLinecap="round"/></svg></div>
            <h4>No account. No log. No censor.</h4>
            <p>No sign-up. No content policy. TEE-secured providers where not even the operator sees your data. Your requests, your models, your business.</p>
          </div>
        </div>
      </section>

      {/* Agents & Developers — full width */}
      <div className={styles.agentsSection}>
        <div className={styles.agentsCopy}>
          <h3>One endpoint.<br/>The whole open market.</h3>
          <p className={styles.agentsVision}>Any agent or coding tool connects in one command. Browse providers by price, latency, and on-chain reputation or use a Routing Service that does the selection for you. Raw inference, specialized models, your choice. No API key approval. Pay per token.</p>
          <ul className={styles.agentsBullets}>
            <li>One command: <code>npm install -g @antseed/cli</code></li>
            <li>Works with any AI agent or coding tool</li>
            <li>Choose providers directly or delegate to a Routing Service</li>
          </ul>
          <Link to="/docs/" className={styles.agentsCta}>Read the Docs →</Link>
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

      {/* Structurally different */}
      <section className={styles.structural}>
        <div className={styles.structuralHeader}>
          <h2>Not just different policies.<br/>Different by design.</h2>
          <p className={styles.structuralSub}>Some things aren't policy decisions. They're impossible by design.</p>
        </div>
        <div className={styles.structuralGrid}>
          <div className={styles.structuralItem}>
            <h4>Reading your requests</h4>
            <p>No central relay exists. Requests travel peer-to-peer. There is no server to subpoena, no logs to leak.</p>
          </div>
          <div className={styles.structuralItem}>
            <h4>Freezing your earnings</h4>
            <p>Payments settle in USDC directly to your wallet via on-chain escrow. No company holds your funds. No trust required.</p>
          </div>
          <div className={styles.structuralItem}>
            <h4>Delisting your capability</h4>
            <p>No editorial team. Anyone who delivers gets discovered. Reputation is built by results, not relationships with a platform.</p>
          </div>
          <div className={styles.structuralItem}>
            <h4>Deciding who can participate</h4>
            <p>Anyone can provide. Anyone can consume. The network has no gatekeeper. Only the protocol and the proof of delivery.</p>
          </div>
        </div>
      </section>

      {/* Two Layers */}
      <section className={styles.layers}>
        <div className={styles.layersHeader}>
          <h2>Two layers. One protocol.</h2>
          <p>The foundation is the unstoppable P2P network. On top sits the open marketplace where any AI service can be offered, discovered, and paid for.</p>
        </div>
        <div className={styles.layersStack}>
          <div className={styles.layerCard}>
            <div className={styles.layerContent}>
              <div className={styles.layerNum}>01</div>
              <h4>Unstoppable Infrastructure</h4>
              <p className={styles.layerTags}>Open source · Peer-to-peer · Anonymous · Always-on</p>
              <p>No login. No central point that can be shut down. Discovery via BitTorrent DHT. Transport via WebRTC. The network routes around failures.</p>
            </div>
            <div className={styles.layerIllust}>
              <svg viewBox="0 0 200 160" fill="none" className={styles.layerSvg}>
                <line x1="50" y1="35" x2="150" y2="70" stroke="rgba(31,216,122,0.2)" strokeWidth="1"/>
                <line x1="50" y1="35" x2="150" y2="120" stroke="rgba(31,216,122,0.15)" strokeWidth="1"/>
                <line x1="50" y1="80" x2="150" y2="35" stroke="rgba(31,216,122,0.2)" strokeWidth="1"/>
                <line x1="50" y1="80" x2="150" y2="120" stroke="rgba(31,216,122,0.2)" strokeWidth="1"/>
                <line x1="50" y1="125" x2="150" y2="35" stroke="rgba(31,216,122,0.15)" strokeWidth="1"/>
                <line x1="50" y1="125" x2="150" y2="70" stroke="rgba(31,216,122,0.2)" strokeWidth="1"/>
                <line x1="53" y1="35" x2="147" y2="35" stroke="#1FD87A" strokeWidth="1" strokeDasharray="4 3"/>
                <line x1="53" y1="80" x2="147" y2="80" stroke="#1FD87A" strokeWidth="1" strokeDasharray="4 3"/>
                <line x1="53" y1="125" x2="147" y2="125" stroke="#1FD87A" strokeWidth="1" strokeDasharray="4 3"/>
                <circle cx="38" cy="35" r="16" fill="#f0faf5" stroke="rgba(31,216,122,0.5)" strokeWidth="1.5"/>
                <text x="38" y="33" textAnchor="middle" fontFamily="monospace" fontSize="6" fontWeight="bold" fill="#1FD87A">PEER</text>
                <text x="38" y="41" textAnchor="middle" fontFamily="monospace" fontSize="5" fill="#888">provider</text>
                <circle cx="38" cy="80" r="16" fill="#f0faf5" stroke="rgba(31,216,122,0.5)" strokeWidth="1.5"/>
                <text x="38" y="78" textAnchor="middle" fontFamily="monospace" fontSize="6" fontWeight="bold" fill="#1FD87A">PEER</text>
                <text x="38" y="86" textAnchor="middle" fontFamily="monospace" fontSize="5" fill="#888">provider</text>
                <circle cx="38" cy="125" r="16" fill="#f0faf5" stroke="rgba(31,216,122,0.5)" strokeWidth="1.5"/>
                <text x="38" y="123" textAnchor="middle" fontFamily="monospace" fontSize="6" fontWeight="bold" fill="#1FD87A">PEER</text>
                <text x="38" y="131" textAnchor="middle" fontFamily="monospace" fontSize="5" fill="#888">provider</text>
                <circle cx="162" cy="35" r="16" fill="#f0faf5" stroke="rgba(31,216,122,0.5)" strokeWidth="1.5"/>
                <text x="162" y="33" textAnchor="middle" fontFamily="monospace" fontSize="6" fontWeight="bold" fill="#555">USER</text>
                <text x="162" y="41" textAnchor="middle" fontFamily="monospace" fontSize="5" fill="#888">buyer</text>
                <circle cx="162" cy="80" r="16" fill="#f0faf5" stroke="rgba(31,216,122,0.5)" strokeWidth="1.5"/>
                <text x="162" y="78" textAnchor="middle" fontFamily="monospace" fontSize="6" fontWeight="bold" fill="#555">USER</text>
                <text x="162" y="86" textAnchor="middle" fontFamily="monospace" fontSize="5" fill="#888">buyer</text>
                <circle cx="162" cy="125" r="16" fill="#f0faf5" stroke="rgba(31,216,122,0.5)" strokeWidth="1.5"/>
                <text x="162" y="123" textAnchor="middle" fontFamily="monospace" fontSize="6" fontWeight="bold" fill="#555">USER</text>
                <text x="162" y="131" textAnchor="middle" fontFamily="monospace" fontSize="5" fill="#888">buyer</text>
                <rect x="72" y="70" width="56" height="16" rx="3" fill="#f0faf5" stroke="#1FD87A" strokeWidth="1"/>
                <text x="100" y="81" textAnchor="middle" fontFamily="monospace" fontSize="6" fontWeight="bold" fill="#1FD87A" letterSpacing="0.5">DIRECT P2P</text>
              </svg>
            </div>
          </div>
          <div className={styles.layerConnector}>↑ built on top of ↑</div>
          <div className={styles.layerCard}>
            <div className={styles.layerContent}>
              <div className={styles.layerNum}>02</div>
              <h4>An Open Marketplace for AI Services</h4>
              <p className={styles.layerTags}>Gasless Payments · On-Chain Stats · Built-in Escrow</p>
              <p>Any provider. Any service. Set your own price. Buyers commit USDC to escrow. Providers settle when delivery is proven. Zero gas for buyers. Every delivery is recorded as on-chain stats.</p>
            </div>
            <div className={styles.layerIllust}>
              <div className={styles.svcList}>
                <div className={styles.svcRow}><div className={styles.svcInfo}><span className={styles.svcName}>Llama 3.3 70B</span><span className={styles.svcJobs}>6,102 verified · Raw Inference</span></div><div className={styles.svcScore}><span className={styles.svcNum}>9.4</span><span className={styles.svcOf}>/10</span></div></div>
                <div className={styles.svcRow}><div className={styles.svcInfo}><span className={styles.svcName}>TEE Price Router</span><span className={styles.svcJobs}>1,847 verified · Routing</span></div><div className={styles.svcScore}><span className={styles.svcNum}>9.8</span><span className={styles.svcOf}>/10</span></div></div>
                <div className={styles.svcRow}><div className={styles.svcInfo}><span className={styles.svcName}>Legal Analysis Agent</span><span className={styles.svcJobs}>2,103 verified · AI Agent</span></div><div className={styles.svcScore}><span className={styles.svcNum}>9.5</span><span className={styles.svcOf}>/10</span></div></div>
                <div className={styles.svcRow}><div className={styles.svcInfo}><span className={styles.svcName}>Code Review Agent</span><span className={styles.svcJobs}>4,821 verified · AI Agent</span></div><div className={styles.svcScore}><span className={styles.svcNum}>9.7</span><span className={styles.svcOf}>/10</span></div></div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Three ways to provide */}
      <section className={styles.threeWays}>
        <div className={styles.threeWaysHeader}>
          <h2>Three ways to provide.</h2>
          <p>All three expose a standard API. What runs behind it is entirely yours.</p>
          <Link to="/providers" className={styles.threeWaysLink}>Become a provider <span className={styles.liveArrow}>→</span></Link>
        </div>
        <div className={styles.threeWaysGrid}>
          <div className={styles.threeWaysCard}>
            <div className={styles.threeWaysNum}>01</div>
            <h4>Raw Inference</h4>
            <p className={styles.threeWaysTags}>Any model · Any backend · Standard API</p>
            <p>Serve a fine-tune, a local GPU, or proxy an existing API. You set the price per token. Buyers route to you based on price, latency, and on-chain reputation.</p>
          </div>
          <div className={styles.threeWaysCard}>
            <div className={styles.threeWaysNum}>02</div>
            <h4>Routing Service</h4>
            <p className={styles.threeWaysTags}>Latency · Cost · TEE · Domain-aware</p>
            <p>Build specialized routing logic and offer it on the network. Latency-optimized, cost-minimizing, TEE-only, jurisdiction-aware. Earn on every request you route without running a single model.</p>
          </div>
          <div className={styles.threeWaysCard}>
            <div className={styles.threeWaysNum}>03</div>
            <h4>AI Agent</h4>
            <p className={styles.threeWaysTags}>Packaged expertise · Private logic · Always-on</p>
            <p>Wrap domain knowledge as a named, always-on service. Your system prompt, RAG, and toolchain stay private. Buyers pay for the expertise, not just the tokens.</p>
          </div>
        </div>
      </section>

      {/* Build Once. Earn Forever. */}
      <section className={styles.creator}>
        <h2 className={styles.creatorTitle}>Build Once. Earn Forever.</h2>
        <p className={styles.creatorSub}>Set your price. Serve the network. Get paid on-chain. Your earnings go directly to your wallet, no platform in the middle, no kill switch on your income. Every delivery builds a track record that belongs to you, not a platform that can revoke it.</p>
        <BrowserOnly fallback={<div style={{height:'740px'}}/>}>{() => <EarnAnimation />}</BrowserOnly>
        <Link to="/docs/" className={styles.creatorCta}>Start Building →</Link>
      </section>

      {/* Works with your tools */}
      <section className={styles.compat}>
        <h3>Works with your tools</h3>
        <p className={styles.compatSub}>Change one URL. Access the whole market.</p>
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
        <div className={styles.bottomGrid}>
          <div className={styles.bottomCard}>
            <h3>Read the Light Paper</h3>
            <p>Understand the protocol, the architecture, and the economics behind the open AI market.</p>
            <Link to="/docs/lightpaper" className={styles.bottomBtn}>Read Light Paper →</Link>
          </div>
          <div className={styles.bottomCard}>
            <h3>Become a provider</h3>
            <p>Serve raw inference, build a routing service, or wrap domain expertise as an AI Agent. Set your price. Start earning.</p>
            <Link to="/providers" className={styles.bottomBtn}>Start providing →</Link>
          </div>
        </div>
      </section>

      {/* FAQ */}
      <FAQSection />

    </Layout>
  );
}