import {useEffect, useRef, useState, type CSSProperties, type ReactNode} from 'react';
import Head from '@docusaurus/Head';
import Link from '@docusaurus/Link';
import Layout from '@theme/Layout';
import {ArrowRight, Button, Reveal} from '../components/ui';
import styles from './network.module.css';

const SOURCE = 'https://github.com/AntSeed/antseed/tree/main';
const EXAMPLE_FEE_BPS = 200;
const EXAMPLE_AUTH_MICROS = [0, 14_000, 31_000, 47_000];
const STAGES = [
  {name: 'Discover', target: 'discovery', label: '01 / LOOKUP', title: 'Find providers first. Match services on your machine.', detail: 'Your device asks the network for provider addresses, then downloads each provider’s signed listing. The listing says which models they offer and at what price.', wire: 'DHT lookup → provider addresses → listings'},
  {name: 'Verify', target: 'discovery', label: '02 / IDENTITY', title: 'Every listing is signed.', detail: 'Your device checks that each listing is signed by its provider and is recent. Only providers that offer the service you asked for move on.', wire: 'check signature → filter services → candidates'},
  {name: 'Rank', target: 'routing', label: '03 / LOCAL POLICY', title: 'Your machine picks the route.', detail: 'Your own trust level and allow/block lists decide who is eligible. Among those, ready providers with the lowest advertised price come first. Pinned providers and ongoing conversations can override that.', wire: 'your rules → ready? → price → tie-breaks'},
  {name: 'Connect', target: 'transport', label: '04 / DIRECT TRANSPORT', title: 'Two peers. One encrypted connection.', detail: 'Your device connects straight to the chosen provider over an encrypted link where both sides prove who they are. Antseed is not in the middle.', wire: 'key exchange → shared secret → encrypted stream'},
  {name: 'Stream', target: 'transport', label: '05 / DELIVERY', title: 'The response comes straight from the provider.', detail: 'For paid use, a budget is reserved first. Then the request and the streamed response travel directly between you and the provider.', wire: 'reserved budget → request → streamed response'},
  {name: 'Authorize', target: 'payments', label: '06 / OFFCHAIN', title: 'A signature, not a transaction per token.', detail: 'After each response, your device signs the running total the provider may collect. Spending can never exceed the reserved budget. The signature covers payment, not proof of output quality.', wire: 'count usage → sign running total → next request'},
  {name: 'Settle', target: 'payments', label: '07 / BASE', title: 'Service delivered. USDC settled.', detail: 'The provider submits your latest signature to Base and gets paid in USDC. That settlement becomes part of the public record.', wire: 'latest signature → Base → provider payout'},
];

function Eyebrow({children}: {children: ReactNode}) {
  return <p className={styles.eyebrow}>{children}</p>;
}

function Chapter({id, number, title, intro, children, dark = false}: {
  id: string; number: string; title: string; intro: string; children: ReactNode; dark?: boolean;
}) {
  return (
    <section id={id} className={`${styles.chapter} ${dark ? styles.dark : ''}`}>
      <div className={styles.inner}>
        <Reveal className={styles.chapterHeading}>
          <Eyebrow>{number} / {id}</Eyebrow>
          <h2>{title}</h2>
          <p className={styles.lead}>{intro}</p>
        </Reveal>
        {children}
      </div>
    </section>
  );
}

function DocLink({to, children}: {to: string; children: ReactNode}) {
  return <Link className={styles.docLink} to={to}>{children}<ArrowRight size={16} /></Link>;
}

const TRACE_MESSAGES = [
  ['FINDING PROVIDERS', 'Asking the network for provider addresses'],
  ['CHECKING LISTINGS', 'Signatures valid · listings fresh'],
  ['ROUTE CHOSEN LOCALLY', 'Peer 02 fits your settings and price'],
  ['ENCRYPTED CONNECTION OPEN', 'Encrypted · both sides verified'],
  ['RESPONSE STREAMING', 'Output travels directly to the buyer'],
  ['SPENDING SIGNED', 'Example: 0.047 USDC authorized'],
  ['SETTLEMENT CONFIRMED', 'Payment recorded on Base'],
];

const SWARM_NODES = [
  [28, 138], [56, 72], [60, 205], [94, 32], [105, 113], [108, 170],
  [114, 247], [152, 65], [157, 139], [165, 211], [190, 23], [201, 99],
  [211, 174], [211, 269], [247, 51], [261, 125], [269, 223], [298, 82],
  [315, 170], [325, 267], [348, 34], [367, 117], [376, 219], [407, 70],
  [413, 167], [435, 236], [455, 112], [456, 189],
];

const SWARM_EDGES = SWARM_NODES.flatMap(([startX, startY], startIndex) =>
  SWARM_NODES.flatMap(([endX, endY], endIndex) =>
    endIndex > startIndex && Math.hypot(endX - startX, endY - startY) < 100
      ? [{startX, startY, endX, endY, id: `${startIndex}-${endIndex}`}]
      : [],
  ),
);

const LOOKUP_PATHS = [
  'M28 138L105 113L152 65L247 51L348 34L407 70L455 112',
  'M28 138L108 170L157 139L201 99L261 125L315 170L413 167L456 189',
  'M28 138L60 205L114 247L165 211L269 223L325 267L376 219L435 236',
];
const MATCHED_NODES = new Set([23, 26, 27]);
const QUERY_NODES = new Set([0, 4, 7, 8, 11, 14, 15, 18, 24]);

function DiscoverySwarm() {
  return (
    <div className={styles.discoveryCloud} aria-hidden="true">
      <div className={styles.swarmCaption}><span className={styles.swarmDot} /> BITTORRENT DHT <span>BEP 5</span></div>
      <svg viewBox="0 0 490 300" preserveAspectRatio="none" className={styles.swarmGraph}>
        <g className={styles.swarmMesh}>
          {SWARM_EDGES.map(({startX, startY, endX, endY, id}) => <line key={id} x1={startX} y1={startY} x2={endX} y2={endY} />)}
        </g>
        {LOOKUP_PATHS.map((path, index) => (
          <g key={path} style={{'--delay': `${index * -.9}s`} as CSSProperties}>
            <path className={styles.swarmRoute} d={path} />
            <path className={styles.swarmPacket} d={path} />
          </g>
        ))}
        {SWARM_NODES.map(([nodeX, nodeY], index) => {
          const matched = MATCHED_NODES.has(index);
          const queried = QUERY_NODES.has(index);
          return (
            <g key={index} className={matched ? styles.swarmMatch : queried ? styles.swarmQuery : styles.swarmPeer} style={{'--delay': `${index * -.27}s`} as CSSProperties}>
              {(matched || queried) && <circle className={styles.swarmHalo} cx={nodeX} cy={nodeY} r={matched ? 14 : 11} />}
              <circle className={styles.swarmNode} cx={nodeX} cy={nodeY} r={matched ? 6 : queried ? 4.5 : 3} />
              {(matched || index % 4 === 0) && <text x={nodeX + 9} y={nodeY - 10}>{((index + 1) * 1973).toString(16).padStart(4, '0')}</text>}
            </g>
          );
        })}
      </svg>
      <div className={styles.swarmLegend}><span><i /> DHT node</span><span><i /> Queried node</span><span><i /> Returns endpoints</span></div>
    </div>
  );
}

function RequestTrace({motionPaused}: {motionPaused: boolean}) {
  const [active, setActive] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [visible, setVisible] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(true);
  const traceRef = useRef<HTMLDivElement>(null);
  const controlsRef = useRef<HTMLDivElement>(null);
  const running = playing && visible && !motionPaused && !reducedMotion;

  useEffect(() => {
    const controls = controlsRef.current;
    const button = controls?.children[active] as HTMLElement | undefined;
    if (!controls || !button || controls.scrollWidth <= controls.clientWidth) return;
    const controlsBounds = controls.getBoundingClientRect();
    const buttonBounds = button.getBoundingClientRect();
    controls.scrollLeft += buttonBounds.left - controlsBounds.left - (controls.clientWidth - buttonBounds.width) / 2;
  }, [active]);

  useEffect(() => {
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    const syncMotion = () => setReducedMotion(preference.matches);
    syncMotion();
    preference.addEventListener('change', syncMotion);
    const element = traceRef.current;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), {threshold: 0.25});
    if (element) observer.observe(element);
    return () => {
      preference.removeEventListener('change', syncMotion);
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    if (!running) return undefined;
    const timer = window.setInterval(() => {
      if (!document.hidden) setActive(current => (current + 1) % STAGES.length);
    }, 4400);
    return () => window.clearInterval(timer);
  }, [running, active]);

  const stage = STAGES[active];
  const selected = active >= 2;
  const direct = active >= 3;
  return (
    <div ref={traceRef} className={`${styles.trace} ${!running ? styles.traceStill : ''}`}>
      <div className={styles.panelBar}><span><i className={styles.statusDot} /> ONE REQUEST / THROUGH THE NETWORK</span><span>Illustrative · not live traffic</span></div>
      <div className={styles.networkScene} data-stage={active} data-direct={direct} data-selected={selected} role="img" aria-label={`${stage.name}: ${stage.detail}`}>
        <div className={styles.sceneLabels} aria-hidden="true"><span>YOUR DEVICE</span><span>OPEN DISCOVERY</span><span>INDEPENDENT PROVIDERS</span></div>
        <svg viewBox="0 0 1000 500" preserveAspectRatio="none" aria-hidden="true" className={styles.sceneWires}>
          <g className={styles.lookupWires}><path d="M250 218L304 189M670 169L710 90M671 227L710 218M653 262L710 345" /></g>
          <path className={styles.directWire} d="M250 218L710 218" />
          <path className={styles.settleWire} d="M840 250L975 250L975 436L840 436" />
          <path className={styles.requestPacket} d="M250 209L710 209" />
          <path className={styles.responsePacket} d="M710 227L250 227" />
        </svg>
        <svg viewBox="0 0 400 700" preserveAspectRatio="none" aria-hidden="true" className={styles.mobileWires}>
          <g className={styles.lookupWires}><path d="M200 125L44 239M351 226L70 410M351 265L200 410M336 289L330 410" /></g>
          <path className={styles.directWire} d="M200 125L200 410" />
          <path className={styles.settleWire} d="M200 490L200 610" />
          <path className={styles.requestPacket} d="M193 125L193 410" />
          <path className={styles.responsePacket} d="M207 410L207 125" />
        </svg>
        <div className={styles.clientCard} aria-hidden="true">
          <div className={styles.clientHeading}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8M12 17v4M7 9l3 2-3 2M13 13h4" /></svg><strong>Your agent</strong><span>LOCAL</span></div>
          <code>POST /v1/chat/completions</code>
          <div className={styles.clientStatus}><i />{active < 2 ? 'Finding providers…' : active === 2 ? 'Route selected locally' : active === 3 ? 'Channel authenticated' : active === 4 ? 'Receiving response…' : active === 5 ? 'Signing usage' : 'Request complete'}</div>
        </div>
        <DiscoverySwarm />
        {[['01', '0.80', 'Higher price'], ['02', '0.40', 'Selected route'], ['03', '0.65', 'Lower trust']].map(([peer, price, reason], index) => (
          <div key={peer} className={`${styles.offerCard} ${index === 1 ? styles.chosenOffer : ''}`} style={{'--offer': index} as CSSProperties} aria-hidden="true">
            <div><span className={styles.serverGlyph}>▤</span><strong>Peer {peer}</strong><span className={styles.offerBadge}>{selected ? index === 1 ? 'SELECTED' : 'SKIPPED' : active === 1 ? 'VERIFIED ✓' : 'FOUND'}</span></div>
            <p><span>${price}<small> / 1M input</small></span><span>{selected ? reason : active === 1 ? 'Signature valid' : 'Model available'}</span></p>
          </div>
        ))}
        <div key={active} className={styles.sceneMessage} aria-hidden="true"><span>{TRACE_MESSAGES[active][0]}</span><strong>{TRACE_MESSAGES[active][1]}</strong>{active === 4 && <div className={styles.tokenStream}><i /><i /><i /><i /><i /><i /><i /></div>}</div>
        <div className={styles.baseCard} aria-hidden="true"><span className={styles.baseMark} /><strong>Base</strong><span>{active === 6 ? '0.047 USDC · settled ✓' : 'USDC settlement'}</span></div>
        <span className={styles.sceneFootnote}>{direct ? 'Requests skip the discovery layer entirely.' : 'The network finds addresses. Listings describe services. You choose.'}</span>
      </div>
      <div className={styles.playbackBar}><span>0{active + 1} / 07 <span>{direct ? 'DIRECT PEER SESSION' : 'DISCOVER & SELECT'}</span></span><button type="button" disabled={motionPaused || reducedMotion} onClick={() => setPlaying(current => !current)}>{motionPaused || reducedMotion ? 'Manual mode' : playing ? 'Ⅱ Pause walkthrough' : '▶ Play walkthrough'}</button></div>
      <div ref={controlsRef} className={styles.traceControls} role="group" aria-label="Explore the request lifecycle">
        {STAGES.map((item, index) => <button key={item.name} type="button" aria-pressed={active === index} aria-controls="trace-detail" onClick={() => {setActive(index); setPlaying(false);}}><span>0{index + 1}</span>{item.name}{active === index && running && <i key={`${index}-${running}`} className={styles.stageProgress} />}</button>)}
      </div>
      <div id="trace-detail" className={styles.traceDetail} aria-live={running ? 'off' : 'polite'} aria-atomic="true">
        <div><Eyebrow>{stage.label}</Eyebrow><h3>{stage.title}</h3><p>{stage.detail}</p></div>
        <div className={styles.traceWire}><code>{stage.wire}</code><a href={`#${stage.target}`}>Inside this layer <ArrowRight size={16} /></a></div>
      </div>
    </div>
  );
}

function PaymentChannel() {
  const [requestCount, setRequestCount] = useState(0);
  const [settled, setSettled] = useState(false);
  const amountMicros = EXAMPLE_AUTH_MICROS[requestCount];
  const amount = (amountMicros / 1_000_000).toFixed(3);
  const feeMicros = Math.floor(amountMicros * EXAMPLE_FEE_BPS / 10_000);
  const payoutMicros = amountMicros - feeMicros;
  return (
    <div className={styles.paymentPanel}>
      <div className={styles.panelBar}><span>CHANNEL / 0x7f3a…</span><span>Interactive example</span></div>
      <div className={styles.budget}><span>Reserved budget (maximum)</span><strong>2.00 <small>USDC</small></strong></div>
      <div className={styles.authorizations}>
        {[1, 2, 3].map((request) => <div key={request} className={request <= requestCount ? styles.signed : ''}><span>Request 0{request}</span><code>{(EXAMPLE_AUTH_MICROS[request] / 1_000_000).toFixed(3)} USDC</code><span>{request <= requestCount ? 'Signed ✓' : 'Waiting'}</span></div>)}
      </div>
      <div className={styles.settlement} aria-live="polite" aria-atomic="true"><span>{settled ? 'Gross settled amount' : 'Latest cumulative authorization'}</span><strong>{amount} <small>USDC</small></strong><p>{settled ? `${(payoutMicros / 1_000_000).toFixed(6)} to provider · ${(feeMicros / 1_000_000).toFixed(6)} protocol fee` : 'Each signature carries the running total, not a new amount. Settlement charges only what has not been settled yet.'}</p></div>
      <div className={styles.demoActions}>
        <button type="button" disabled={settled || requestCount === 3} onClick={() => setRequestCount(requestCount + 1)}>Send request <ArrowRight size={16} /></button>
        <button type="button" disabled={settled || requestCount === 0} onClick={() => setSettled(true)}>Close & settle</button>
        <button type="button" onClick={() => {setRequestCount(0); setSettled(false);}}>Reset</button>
      </div>
      <p className={styles.finePrint}>{settled ? `${((2_000_000 - amountMicros) / 1_000_000).toFixed(3)} USDC of the reservation goes back to the buyer’s deposit.` : 'Simulation only. One final settlement, no headroom.'} The {EXAMPLE_FEE_BPS / 100}% fee is the default in the contract source and assumes a fee recipient is configured. The live fee may differ.</p>
    </div>
  );
}

export default function NetworkPage() {
  const [motionPaused, setMotionPaused] = useState(false);
  return (
    <Layout title="The peer-to-peer AI protocol" description="Inside Antseed: your device finds providers over Mainline DHT, the same network BitTorrent uses, picks the route itself, talks to the provider directly, and pays in USDC on Base.">
      <Head><link rel="canonical" href="https://antseed.com/network/" /></Head>
      <main className={`${styles.page} ${motionPaused ? styles.paused : ''}`}>
        <header className={styles.hero}>
          <div className={styles.inner}>
            <div className={styles.heroTop}><Eyebrow>ANTSEED / NETWORK PROTOCOL</Eyebrow><button type="button" className={styles.motionToggle} aria-pressed={motionPaused} onClick={() => setMotionPaused(!motionPaused)}>{motionPaused ? 'Resume motion' : 'Pause motion'}</button></div>
            <Reveal><h1>Antseed Network.<br /><span>Not another API gateway.</span></h1><p className={styles.heroLead}>A peer-to-peer protocol for buying AI. Your device finds providers over the same Mainline DHT that BitTorrent uses, reads their signed price lists, picks the best one itself, and pays in USDC on Base.</p></Reveal>
            <div className={styles.ctas}><Button href="#discovery" size="lg" arrow>Follow a request</Button><Button href={SOURCE} variant="ghost" size="lg">Inspect the source</Button></div>
            <RequestTrace motionPaused={motionPaused} />
            <div className={styles.heroFooter}><span>Discovery is distributed.</span><span>Routing is local.</span><span>Delivery is direct.</span><span>Settlement is onchain.</span></div>
          </div>
        </header>

        <nav className={styles.chapterNav} aria-label="Protocol chapters"><div>{['discovery', 'routing', 'transport', 'payments', 'trust', 'incentives', 'resilience', 'protocol'].map((chapter, index) => <a key={chapter} href={`#${chapter}`}><span>0{index + 1}</span>{chapter}</a>)}</div></nav>

        <Chapter id="discovery" number="01" title="Find providers. Read their listings. Choose locally." intro="Antseed finds providers over Mainline DHT, the same network BitTorrent uses. It only stores addresses. It never sees model names or prompts. Each provider’s service listing comes straight from that provider, signed.">
          <div className={styles.split}>
            <Reveal className={styles.discoveryPanel}>
              <div className={styles.panelBar}><span>DISCOVERY / FINDING PROVIDERS</span><span>Mainline DHT · BEP 5</span></div>
              <div className={styles.topic}>
                <span>01 / Ask the network</span><code>Same Mainline DHT that BitTorrent uses</code>
                <span>02 / Scan for providers</span><code>Only addresses are stored, nothing else</code>
                <div className={styles.shards}>{Array.from({length: 16}, (_, index) => <i key={index} style={{'--delay': `${index * 0.13}s`} as CSSProperties}>{index}</i>)}</div>
                <small>Your device sweeps the network and collects every provider address it finds.</small>
                <span className={styles.downArrow}>↓ Download each provider’s listing</span>
                <code>listing → verify signature → keep matching services</code>
              </div>
              <div className={styles.metadata}><span>SIGNED PROVIDER LISTING</span><dl><div><dt>Services</dt><dd>Models + capabilities</dd></div><div><dt>Offer</dt><dd>Pricing + current load</dd></div><div><dt>Endpoint</dt><dd>Public peer address</dd></div><div><dt>Identity</dt><dd>Signature + timestamp</dd></div></dl></div>
            </Reveal>
            <Reveal className={styles.prose}>
              <h3>Addresses, not a model index.</h3><p>Providers put only their address on the network, never their model names. So the network stays small no matter how many models a provider offers. If you already know a provider, your device can look it up directly.</p>
              <h3>Scan once. Filter on your machine.</h3><p>Your device collects provider addresses, downloads each signed listing, and keeps the ones that offer what you asked for. A quick first scan gets you started. A background scan finishes the sweep.</p>
              <h3>A listing is not a free pass.</h3><p>By default, a listing with a bad signature, a broken format, or a stale timestamp is ignored. A listing is the provider’s claim about what it offers, not proof of quality.</p>
              <h3>Bootstrap is a door, not a gateway.</h3><p>New nodes join through Antseed’s bootstrap servers. Those servers only help you find peers. Your requests never pass through them, and you can point your node at other bootstrap servers.</p>
              <DocLink to="/docs/discovery">Read the discovery protocol</DocLink>
            </Reveal>
          </div>
        </Chapter>

        <Chapter id="routing" number="02" title="The buyer is the router." intro="Your machine builds its own picture of the network and decides which provider to use. There is no Antseed server making that choice for you.">
          <Reveal className={styles.funnel}>
            {[['12', 'Found', 'Signed provider listings'], ['08', 'Compatible', 'Offer the service you asked for'], ['04', 'Eligible', 'Pass your trust and allow/block rules'], ['01', 'Selected', 'Ready first, then cheapest']].map(([count, label, description]) => <div key={label}><strong>{count}</strong><h3>{label}</h3><p>{description}</p></div>)}
          </Reveal>
          <p className={styles.finePrint}>Illustrative candidates, not live network counts.</p>
          <div className={styles.textColumns}><div><h3>Policy lives on your device.</h3><p>Your minimum trust level and allow/block lists decide who is eligible. Among eligible, ready providers, the lowest advertised price wins, with a blended score to break ties. Pinned providers and ongoing conversations can override the order.</p><p>A preferred maximum price nudges expensive providers down the list. A hard price cap is a separate setting that blocks anything above it.</p></div><div><h3>Failures stay local.</h3><p>If a provider fails for you, your device cools it down for a while and prefers others. Nobody is banned network-wide, and other buyers make their own calls.</p></div><div><h3>Swap the decision layer.</h3><p>Router plugins let you change how providers are chosen while keeping the same discovery, transport, and payment layers underneath.</p><DocLink to="/docs/router-api">Explore router plugins</DocLink></div></div>
        </Chapter>

        <Chapter id="transport" number="03" dark title="After discovery, go direct." intro="Once a provider is chosen, your device talks to it directly. Antseed does not sit in between. The connection is encrypted, and both sides prove who they are.">
          <Reveal className={styles.transportDiagram}><div><span>01 / BUYER</span><strong>Your machine</strong><small>Your rules · your history</small></div><div className={styles.encryptedPipe}><span>X25519 / HKDF-SHA256 / AES-256-GCM</span><div><i /><i /><i /></div><small>Requests → &nbsp; ← streamed responses</small></div><div><span>02 / PROVIDER</span><strong>Selected node</strong><small>Runs the model · streams the answer</small></div></Reveal>
          <div className={styles.boundaries}>{[['On your machine', 'Routing preferences, local history, and your allow/block rules.'], ['Between the peers', 'Requests and responses. The provider you chose can read the request it serves.'], ['On Base', 'Deposits, payment authorizations, usage totals, stake, and rewards. Prompts and outputs never go on-chain.']].map(([title, text]) => <div key={title}><h3>{title}</h3><p>{text}</p></div>)}</div>
          <p className={styles.transportNote}>Encrypted TCP is used whenever the provider supports it, with WebRTC as an alternative. Older unencrypted connections still work for compatibility unless you require encryption. Encryption protects traffic in transit. It does not hide anything from the provider you chose, and it does not promise anonymity or no logging.</p>
          <DocLink to="/docs/transport">How the connection works</DocLink>
        </Chapter>

        <Chapter id="payments" number="04" title="Pay as you go. Not a transaction per token." intro="Base holds the money and records the final settlement. Everything in between is a signature from your device, so there is no on-chain transaction per request.">
          <div className={styles.split}><Reveal className={styles.prose}><h3>Reserve. Authorize. Settle.</h3><p>Before paid service starts, you sign a reservation that caps what the provider can collect. After each response, you sign the new running total. When the channel closes, the provider is paid that total and the unused reservation goes back to you.</p><p>Authorizations can include a little headroom so streaming does not stall. The signed total can run slightly ahead of measured usage, but never beyond the reservation.</p><h3>Money and logic live in separate contracts.</h3><p>One contract holds the USDC. Another handles reservations and settlement without ever holding funds. Both check your signature and enforce the cap.</p><h3>Metering guides what you sign.</h3><p>Your device uses the provider’s usage report and its own estimates to decide what to authorize. Settlement checks for a valid signature, not for the quality of the output.</p><p>The contract source defaults to a 2% protocol fee, and the owner can set it up to 10%. The live setting can differ. USDC is the settlement currency. The desktop app can also fund by card where available.</p><DocLink to="/docs/payments">How payments work</DocLink></Reveal><Reveal><PaymentChannel /></Reveal></div>
        </Chapter>

        <Chapter id="trust" number="05" title="Trust you can check." intro="Anyone can join, so a name is not enough. Your device scores providers from their settled history, recent usage, locked ANTS backing, and verified identity.">
          <Reveal className={styles.trustGrid}>{[['60', 'History', 'Completed channels and settled USDC volume.'], ['15', 'Usage', 'Share of recognized usage in the last epoch.'], ['5', 'Backing', 'Share of locked ANTS behind providers this epoch.'], ['20', 'Identity', 'Verified GitHub account or domain.']].map(([weight, title, text]) => <div key={title}><span>UP TO {weight} POINTS</span><h3>{title}</h3><p>{text}</p><div className={styles.weightTrack}><i style={{width: `${Number(weight) / 60 * 100}%`}} /></div></div>)}</Reveal>
          <div className={styles.trustFooter}><p><strong>Public signals, your decision.</strong> Your device combines these scores with your own settings and recent failures. Proven wash trading sets the score to zero. A high score is a good sign, not a guarantee of quality.</p><DocLink to="/docs/reputation">How trust is computed</DocLink></div>
        </Chapter>

        <Chapter id="incentives" number="06" title="Rewards for real work." intro="USDC pays for the work. ANTS rewards recognized usage and providers who lock backing behind their service. Two separate systems with two separate jobs.">
          <Reveal className={styles.incentiveLoop}>{[['01', 'Deliver a service', 'A buyer pays for usage.'], ['02', 'Settle in USDC', 'The payment goes on record.'], ['03', 'Recognize the usage', 'Eligibility rules apply.'], ['04', 'Allocate ANTS', 'Rewards follow usage and backing.']].map(([number, title, text]) => <div key={number}><span>{number}</span><h3>{title}</h3><p>{text}</p></div>)}</Reveal>
          <div className={styles.textColumns}><div><h3>Stake is long-term backing.</h3><p>Providers lock ANTS behind their service. That is separate from the USDC buyers deposit to pay for it.</p></div><div><h3>Not all volume earns rewards.</h3><p>Usage must pass eligibility rules. A payment can settle without earning ANTS, and losing a reward never reverses a payment.</p></div><div><h3>Budgets have limits.</h3><p>Rewards depend on activity and configured caps. Anything left unallocated follows set remainder and burn rules. Payouts are not guaranteed.</p><DocLink to="/docs/recognized-usage">How rewards work</DocLink></div></div>
        </Chapter>

        <Chapter id="resilience" number="07" title="Failure is part of the plan." intro="Independent providers go offline, fail requests, or publish bad data. What happens next matters as much as the happy path.">
          <div className={styles.failureList}>{[
            ['A provider disappears.', 'Your device moves on to another eligible provider. To unlock the money reserved for that channel, your account requests a close, waits 15 minutes, and withdraws. The funds return to your deposit balance.'],
            ['A provider keeps failing.', 'Your device cools it down and prefers others. No central operator has to step in.'],
            ['A listing is forged or stale.', 'Signature, format, and freshness checks drop it before it is ever considered.'],
            ['Infrastructure goes down.', 'Other bootstrap servers can still get you into the network. Settlement still needs Base and a working RPC endpoint, so peer-to-peer does not mean zero dependencies.'],
            ['Contract rules change.', 'Contract owners keep admin powers: pausing channels, setting the fee, and updating addresses. Peer-to-peer delivery does not make the settlement layer immutable.'],
          ].map(([title, text], index) => <Reveal key={title} className={styles.failure}><span>0{index + 1}</span><h3>{title}</h3><p>{text}</p></Reveal>)}</div>
          <DocLink to="/docs/security">Where the security boundaries are</DocLink>
        </Chapter>

        <Chapter id="protocol" number="08" dark title="Every layer is open." intro="Discovery, encrypted transport, metering, settlement, and reputation, all open source. Read the spec, inspect the code, and build on the same pieces.">
          <div className={styles.stack}>{[
            ['05', 'Reputation', 'Trust scoring and identity signals', 'reputation', 'reputation'],
            ['04', 'Payments', 'USDC channels and settlement', 'payments', 'payments'],
            ['03', 'Metering', 'Counting usage and signing receipts', 'metering', 'metering'],
            ['02', 'Transport', 'Verified peers and encrypted traffic', 'transport', 'p2p'],
            ['01', 'Discovery', 'Finding peers and signed listings', 'discovery', 'discovery'],
          ].map(([number, title, description, doc, directory]) => <div key={number}><span>{number}</span><h3>{title}</h3><p>{description}</p><Link to={`/docs/${doc}`}>Spec ↗</Link><a href={`${SOURCE}/packages/node/src/${directory}`}>Source ↗</a></div>)}</div>
          <div className={styles.closing}><h3>Run a node. Build a provider.<br />Make the network your own.</h3><div className={styles.ctas}><Button to="/docs/overview" variant="white" size="lg" arrow>Read the protocol</Button><Button to="/providers" variant="light" size="lg">Become a provider</Button></div><p>Open source · Independent peers · USDC settlement on Base</p></div>
        </Chapter>
      </main>
    </Layout>
  );
}
