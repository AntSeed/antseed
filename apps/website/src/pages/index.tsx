import {useEffect, useRef, useState, useMemo} from 'react';
import Head from '@docusaurus/Head';
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

function useNetworkStats() {
  const [peerCount, setPeerCount] = useState<number | null>(null);
  const [serviceCount, setServiceCount] = useState<number | null>(null);

  useEffect(() => {
    const refresh = async () => {
      try {
        const res = await fetch(STATS_URL, {signal: AbortSignal.timeout(5000)});
        if (!res.ok) return;
        const data = await res.json();
        const peers = data.peers ?? [];
        const services: string[] = [];
        for (const p of peers) for (const pr of p.providers ?? []) for (const m of pr.services ?? []) services.push(m);
        setPeerCount(peers.length);
        setServiceCount(services.length);
      } catch { /* stats unavailable — leave counters hidden */ }
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
  {q:'How is this different from OpenRouter?', a:"OpenRouter is a centralized aggregator: it decides which models are listed, reads every request, and holds your earnings until payout. AntSeed removes the aggregator entirely. Requests go peer-to-peer. Payments settle on-chain directly to the provider's wallet. Anyone can provide — no approval needed. The network has no company behind it and no off switch. <a href=\"/vs/openrouter\" style=\"color:#1FD87A;font-weight:500;\">Read the full comparison →</a>"},
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

  const faqLd = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: FAQ_DATA.map(({q, a}) => ({
      '@type': 'Question',
      name: q,
      acceptedAnswer: {
        '@type': 'Answer',
        text: a.replace(/<[^>]*>/g, '').trim(),
      },
    })),
  };

  return (
    <Layout
      title={siteConfig.tagline}
      description="The open market for AI inference. Serve or consume AI peer-to-peer. Onchain payments. Verifiable reputation. Anonymous. Private. No gatekeepers."
      wrapperClassName="homepage-wrapper">
      <Head>
        <script type="application/ld+json">{JSON.stringify(faqLd)}</script>
      </Head>

      {/* Hero */}
      <section className={styles.hero}>
        <h1 className={styles.heroTitle}>The open market for AI inference.</h1>
        <p className={styles.heroSub}>Permissionless peer-to-peer. Onchain payments. Verifiable reputation.</p>
      </section>

      {/* Liveness */}
      <section className={styles.live}><LiveBar /></section>

      {/* Audience paths */}
      <section className={styles.entrySwitchboard}>
        <div className={styles.entryHeader}>
          <h2>Three ways in.</h2>
        </div>

        <div className={styles.switchboardShell}>
          <div className={styles.modelTicker} aria-label="Available models">
            <div className={styles.modelTickerTrack}>
              {[
                ['anthropic.png', 'Claude'], ['openai.png', 'GPT'], ['google.png', 'Gemini'], ['deepseek.png', 'DeepSeek'], ['meta.png', 'Llama'], ['qwen.png', 'Qwen'], ['mistral.png', 'Mistral'], ['moonshot.png', 'Kimi'], ['zhipu.png', 'GLM'],
                ['anthropic.png', 'Claude'], ['openai.png', 'GPT'], ['google.png', 'Gemini'], ['deepseek.png', 'DeepSeek'], ['meta.png', 'Llama'], ['qwen.png', 'Qwen'], ['mistral.png', 'Mistral'], ['moonshot.png', 'Kimi'], ['zhipu.png', 'GLM'],
                ['anthropic.png', 'Claude'], ['openai.png', 'GPT'], ['google.png', 'Gemini'], ['deepseek.png', 'DeepSeek'], ['meta.png', 'Llama'], ['qwen.png', 'Qwen'], ['mistral.png', 'Mistral'], ['moonshot.png', 'Kimi'], ['zhipu.png', 'GLM'],
              ].map(([logo, name], i) => (
                <span key={`${name}-${i}`}><img src={`/logos/${logo}`} alt="" />{name}</span>
              ))}
            </div>
          </div>

          <div className={styles.entryGrid}>
            <article className={styles.entryCard}>
              <div className={styles.stationIcon}><img src="/logos/antseed-mark.svg" alt="AntStation" /></div>
              <div className={styles.entryContent}>
                <span>Chat</span>
                <h3>AntStation</h3>
                <p>Sort providers by what you need — video, images, coding, price, privacy — then chat anonymously.</p>
                <div className={styles.entryBadges}><b>No account</b></div>
              </div>
              <div className={styles.entryDownloadPair}>
                <a href={download.href} target="_blank" rel="noopener noreferrer" className={styles.entryCta}><DesktopDownloadIcon platform={download.platform} />{download.platform === 'win' ? 'Windows' : 'Mac'}</a>
                <a href={RELEASES_URL} target="_blank" rel="noopener noreferrer" className={styles.entryCta}><DesktopDownloadIcon platform={download.platform === 'win' ? 'mac' : 'win'} />{download.platform === 'win' ? 'Mac' : 'Windows'}</a>
              </div>
            </article>

            <article className={styles.entryCard}>
              <div className={styles.toolStack} aria-label="Coding tools">
                <span><img src="/logos/anthropic.png" alt="" /></span>
                <span><img src="/logos/openai.png" alt="" /></span>
                <span className={styles.toolText}>VS</span>
                <span className={styles.toolText}>OC</span>
                <span className={styles.toolText}>PI</span>
              </div>
              <div className={styles.entryContent}>
                <span>CLI</span>
                <h3>Coding tools</h3>
                <p>Sort coding providers by model, price, latency, or reputation — then plug your tools into one local endpoint.</p>
                <code>localhost:8377/v1</code>
              </div>
              <a href="/docs/guides/using-the-api" rel="noopener noreferrer" className={styles.entryCta}>Connect</a>
            </article>

            <article className={styles.entryCard}>
              <div className={styles.agentStack} aria-label="Agent tools">
                <span><img src="/logos/openclaw.svg" alt="" />OpenClaw</span>
                <span><img src="/logos/nousresearch.svg" alt="" />Hermes</span>
              </div>
              <div className={styles.entryContent}>
                <span>Agents</span>
                <h3>Connect your agent</h3>
                <p>Let agents sort providers by task, price, latency, reputation, capability, or Private Provider routes.</p>
                <div className={styles.entryBadges}><b>cheap</b><b>fast</b><b>reliable</b></div>
              </div>
              <a href="https://github.com/AntSeed/antseed/tree/main/skills" target="_blank" rel="noopener noreferrer" className={styles.entryCta}>Connect</a>
            </article>
          </div>
        </div>
      </section>

      {/* Chat users */}
      <section className={`${styles.audienceSection} ${styles.chatSection}`}>
        <div className={styles.audienceCopy}>
          <span className={styles.kicker}>For chat users</span>
          <h2>AntStation is the anonymous AI app for the open model market.</h2>
          <p className={styles.audienceLead}>Open the desktop app, pick a model, chat anonymously, and pay providers in USDC. Providers compete directly, so users get some of the lowest AI prices in the market.</p>
          <div className={styles.conversionGrid}>
            <div><strong>Anon by default</strong><span>No account wall before you can ask.</span></div>
            <div><strong>Uncensored market</strong><span>Providers compete; no single policy team controls access.</span></div>
            <div><strong>Frontier + open source</strong><span>Use the best model for the job, not the one your subscription picked.</span></div>
            <div><strong>Private Providers</strong><span>Prefer TEE providers and direct P2P transport.</span></div>
          </div>
          <div className={styles.pathActions}>
            <a href={download.href} target="_blank" rel="noopener noreferrer" className={styles.pathPrimaryBtn}>
              <DesktopDownloadIcon platform={download.platform} />
              {download.platform === 'win' ? 'Download Windows' : 'Download Mac'}
            </a>
            <a href={RELEASES_URL} target="_blank" rel="noopener noreferrer" className={styles.pathPrimaryBtn}>
              <DesktopDownloadIcon platform={download.platform === 'win' ? 'mac' : 'win'} />
              {download.platform === 'win' ? 'Download Mac' : 'Download Windows'}
            </a>
            <Link to="/network" className={styles.pathSecondaryBtn}>See live providers →</Link>
          </div>
        </div>
        <div className={styles.audienceMedia}>
          <video
            src="/videos/desktop-app-v2.mp4"
            autoPlay
            loop
            muted
            playsInline
            className={styles.mediaVideo}
          />
        </div>
      </section>

      {/* CLI users */}
      <section className={`${styles.audienceSection} ${styles.cliSection}`}>
        <div className={styles.audienceMedia}>
          <video
            src="/videos/claude-code.mp4"
            autoPlay
            loop
            muted
            playsInline
            className={styles.mediaVideo}
          />
          <div className={styles.toolLogoRow}>
            <span><img src="/logos/anthropic.png" alt="" />Claude Code</span>
            <span><img src="/logos/openai.png" alt="" />Codex</span>
            <span className={styles.toolLogoText}>VS</span>
            <span className={styles.toolLogoText}>OC</span>
            <span className={styles.toolLogoText}>PI</span>
            <span>OpenAI API</span>
          </div>
        </div>
        <div className={styles.audienceCopy}>
          <span className={styles.kicker}>For CLI users</span>
          <h2>Keep your workflow. Swap in the open market.</h2>
          <p className={styles.audienceLead}>Developers care about speed, model quality, low prices, easy integration, and not getting stuck with one provider. AntSeed exposes a local OpenAI-compatible endpoint for the tools they already use.</p>
          <div className={styles.localEndpoint}>
            <span>Base URL</span>
            <code>http://localhost:8377/v1</code>
          </div>
          <ul className={styles.checkList}>
            <li>Use the best coding model available right now</li>
            <li>Fallback across providers when one is slow or unavailable</li>
            <li>Compare price, latency, and reputation before routing</li>
            <li>Works with normal SDKs, CLIs, and editor plugins</li>
          </ul>
          <a href="/docs/guides/using-the-api" rel="noopener noreferrer" className={styles.pathPrimaryBtn}>Connect CLI →</a>
        </div>
      </section>

      {/* Agent users */}
      <section className={`${styles.audienceSection} ${styles.agentSection}`}>
        <div className={styles.audienceCopy}>
          <span className={styles.kicker}>For agents</span>
          <div className={styles.agentLogoRow}>
            <span><img src="/logos/openclaw.svg" alt="" />OpenClaw</span>
            <span><img src="/logos/nousresearch.svg" alt="" />Hermes</span>
          </div>
          <h2>Agents need economic routing, not another SaaS account.</h2>
          <p className={styles.audienceLead}>Autonomous agents optimize for cost, capability, reliability, and privacy. AntSeed gives them a discoverable service market where providers compete for the lowest viable price.</p>
          <div className={styles.agentMetrics}>
            <div><span>Price</span><strong>lowest viable</strong></div>
            <div><span>Latency</span><strong>fastest healthy</strong></div>
            <div><span>Trust</span><strong>on-chain reputation</strong></div>
            <div><span>Privacy</span><strong>TEE / direct P2P</strong></div>
          </div>
          <ul className={styles.checkList}>
            <li>Raw inference for commodity tasks</li>
            <li>Routing services for cost, latency, privacy, or domain policies</li>
            <li>Specialist AI agents for packaged expertise and tools</li>
            <li>USDC settlement without platform custody</li>
          </ul>
          <a href="https://github.com/AntSeed/antseed/tree/main/skills" target="_blank" rel="noopener noreferrer" className={styles.pathPrimaryBtn}>Connect →</a>
        </div>
        <div className={styles.agentAnimation} aria-label="Agent provider routing animation">
          <div className={styles.orbitRing} />
          <div className={styles.orbitRingTwo} />
          <div className={styles.agentCore}>
            <div className={styles.agentCoreIcons}>
              <img src="/logos/openclaw.svg" alt="" />
              <img src="/logos/nousresearch.svg" alt="" />
            </div>
            <strong>agent</strong>
            <span>selects provider</span>
          </div>
          <div className={`${styles.providerNode} ${styles.providerPrice}`}><b>$</b><span>lowest price</span></div>
          <div className={`${styles.providerNode} ${styles.providerCode}`}><b>{`</>`}</b><span>coding model</span></div>
          <div className={`${styles.providerNode} ${styles.providerTee}`}><b>TEE</b><span>private route</span></div>
          <div className={`${styles.providerNode} ${styles.providerResearch}`}><b>R</b><span>research agent</span></div>
          <div className={`${styles.providerNode} ${styles.providerOpen}`}><b>OS</b><span>open source</span></div>
          <div className={styles.routeBeam} />
          <div className={styles.routeBeamTwo} />
          <div className={styles.routePacket} />
          <div className={styles.agentSettlement}>provider selected → USDC settlement</div>
        </div>
      </section>

      {/* ANTS utility */}
      <section className={styles.antsUtilitySection}>
        <div className={styles.antsOrb}><img src="/logos/antseed-mark.svg" alt="ANTS" /></div>
        <div>
          <span className={styles.kicker}>Network utility</span>
          <h2>$ANTS will power Subscription Pools, reputation and more.</h2>
          <p>As AntSeed grows from individual requests to recurring agent workloads, ANTS becomes the coordination layer for access, incentives, and subscription pool utility.</p>
        </div>
        <Link to="/ants-token" className={styles.antsUtilityCta}>Explore ANTS →</Link>
      </section>

      {/* Provider stripe */}
      <section className={styles.providerStripe}>
        <span>Have GPUs, an API, a router, or a specialist agent?</span>
        <strong>Become a provider and get discovered when users choose where to route.</strong>
        <Link to="/providers">Provider page →</Link>
      </section>

      {/* Bottom CTAs */}
      <section className={styles.bottomCtas}>
        <div className={styles.bottomGrid}>
          <div className={styles.bottomCard}>
            <h3>Chat Anonymously</h3>
            <p>Download AntStation and use frontier or open-source models without creating a central account.</p>
            <a href={download.href} target="_blank" rel="noopener noreferrer" className={styles.bottomBtn}>Download AntStation →</a>
          </div>
          <div className={styles.bottomCard}>
            <h3>Connect your CLI</h3>
            <p>Point Claude Code, Codex, VS Code, or any OpenAI-compatible tool at your local AntSeed endpoint.</p>
            <a href="/docs/guides/using-the-api" rel="noopener noreferrer" className={styles.bottomBtn}>Connect a tool →</a>
          </div>
          <div className={styles.bottomCard}>
            <h3>Build with agents</h3>
            <p>Route tasks by model quality, price, latency, privacy, and on-chain reputation.</p>
            <Link to="https://github.com/AntSeed/antseed/tree/main/skills" className={styles.bottomBtn}>Connect agents →</Link>
          </div>
        </div>
      </section>

      {/* FAQ */}
      <FAQSection />

    </Layout>
  );
}