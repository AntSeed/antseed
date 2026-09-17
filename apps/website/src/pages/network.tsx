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
  {name: 'Discover', target: 'discovery', label: '01 / LOOKUP', title: 'Find peers first. Match services locally.', detail: 'Query the wildcard, then subnet topics to enumerate peer endpoints. Fetch each endpoint’s signed metadata; service catalogs live there, not in per-service DHT topics.', wire: 'wildcard → subnets → endpoints → GET /metadata'},
  {name: 'Verify', target: 'discovery', label: '02 / IDENTITY', title: 'An advertisement with a signature.', detail: 'Validate metadata schema, freshness, and signature. Match the requested service against the verified catalog before ranking eligible offers.', wire: 'verify metadata → filter catalog → candidate offers'},
  {name: 'Rank', target: 'routing', label: '03 / LOCAL POLICY', title: 'Your machine chooses the route.', detail: 'Trust and allow/block rules gate eligibility. The shared model ranker prefers ready peers, then lower advertised prices; its blended score breaks price ties. Explicit pins and conversation affinity can affect the final choice.', wire: 'eligibility → cooldown status → price → tie-breaks'},
  {name: 'Connect', target: 'transport', label: '04 / DIRECT TRANSPORT', title: 'Two peers. One encrypted channel.', detail: 'Modern nodes prefer mutually authenticated encrypted TCP. WebRTC DataChannels provide another supported transport.', wire: 'X25519 → HKDF-SHA256 → AES-256-GCM'},
  {name: 'Stream', target: 'transport', label: '05 / DELIVERY', title: 'The response takes the peer connection.', detail: 'For paid delivery, a reservation is established before service. API requests and streaming responses then travel as binary frames between the buyer and the selected provider.', wire: 'reserved budget → HttpRequest → HttpResponseChunk'},
  {name: 'Authorize', target: 'payments', label: '06 / OFFCHAIN', title: 'A signature, not a transaction per token.', detail: 'The buyer updates cumulative spending authorizations after responses and when additional headroom is needed. The reserved budget bounds spending, but a signature is not proof of delivered output.', wire: 'response accounting → SpendingAuth → next request'},
  {name: 'Settle', target: 'payments', label: '07 / BASE', title: 'Service delivered. USDC settled.', detail: 'The provider submits the latest authorization to settle or close the channel. Settlement also creates public economic history.', wire: 'latest authorization → Base → provider payout'},
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
  ['ENUMERATING PEERS', 'Wildcard + subnets → peer endpoints'],
  ['CHECKING ADVERTISEMENTS', 'Identity recovered · metadata fresh'],
  ['LOCAL ROUTE SELECTED', 'Peer 02 matches this buyer’s policy'],
  ['ENCRYPTED CHANNEL OPEN', 'Ephemeral keys · authenticated peers'],
  ['RESPONSE STREAMING', 'Output travels directly to the buyer'],
  ['SPENDING AUTHORIZED', 'Illustrative authorization: 0.047 USDC'],
  ['SETTLEMENT CONFIRMED', 'Base records the authorized payment'],
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
        <span className={styles.sceneFootnote}>{direct ? 'Inference bypasses the discovery layer.' : 'DHT: endpoints. Metadata: services. Buyer: selection.'}</span>
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
      <div className={styles.budget}><span>ReserveAuth / maximum budget</span><strong>2.00 <small>USDC</small></strong></div>
      <div className={styles.authorizations}>
        {[1, 2, 3].map((request) => <div key={request} className={request <= requestCount ? styles.signed : ''}><span>Request 0{request}</span><code>{(EXAMPLE_AUTH_MICROS[request] / 1_000_000).toFixed(3)} USDC</code><span>{request <= requestCount ? 'Signed ✓' : 'Waiting'}</span></div>)}
      </div>
      <div className={styles.settlement} aria-live="polite" aria-atomic="true"><span>{settled ? 'Gross settled amount' : 'Latest cumulative authorization'}</span><strong>{amount} <small>USDC</small></strong><p>{settled ? `${(payoutMicros / 1_000_000).toFixed(6)} to provider · ${(feeMicros / 1_000_000).toFixed(6)} protocol fee` : 'Each signature authorizes a cumulative total. Totals are not added together; settlement charges only the increase over the amount already settled.'}</p></div>
      <div className={styles.demoActions}>
        <button type="button" disabled={settled || requestCount === 3} onClick={() => setRequestCount(requestCount + 1)}>Send request <ArrowRight size={16} /></button>
        <button type="button" disabled={settled || requestCount === 0} onClick={() => setSettled(true)}>Close & settle</button>
        <button type="button" onClick={() => {setRequestCount(0); setSettled(false);}}>Reset</button>
      </div>
      <p className={styles.finePrint}>{settled ? `${((2_000_000 - amountMicros) / 1_000_000).toFixed(3)} USDC of the reservation is released back to the buyer’s available deposit.` : 'Simulation only. One final settlement, no interim settlements or extra headroom.'} This example uses the source default of {EXAMPLE_FEE_BPS / 100}% and assumes a configured protocol reserve. It does not read the deployed fee.</p>
    </div>
  );
}

export default function NetworkPage() {
  const [motionPaused, setMotionPaused] = useState(false);
  return (
    <Layout title="The peer-to-peer AI protocol" description="Inside Antseed: BitTorrent DHT discovery, buyer-owned routing, direct encrypted transport, and buyer-authorized USDC settlement on Base.">
      <Head><link rel="canonical" href="https://antseed.com/network/" /></Head>
      <main className={`${styles.page} ${motionPaused ? styles.paused : ''}`}>
        <header className={styles.hero}>
          <div className={styles.inner}>
            <div className={styles.heroTop}><Eyebrow>ANTSEED / NETWORK PROTOCOL</Eyebrow><button type="button" className={styles.motionToggle} aria-pressed={motionPaused} onClick={() => setMotionPaused(!motionPaused)}>{motionPaused ? 'Resume motion' : 'Pause motion'}</button></div>
            <Reveal><h1>Antseed Network.<br /><span>Not another API gateway.</span></h1><p className={styles.heroLead}>A peer-to-peer protocol for buying intelligence. Discover peers through a BitTorrent DHT, inspect signed service catalogs, choose a route on your machine, and settle authorized spending in USDC on Base.</p></Reveal>
            <div className={styles.ctas}><Button href="#discovery" size="lg" arrow>Follow a request</Button><Button href={SOURCE} variant="ghost" size="lg">Inspect the source</Button></div>
            <RequestTrace motionPaused={motionPaused} />
            <div className={styles.heroFooter}><span>Discovery is distributed.</span><span>Routing is local.</span><span>Delivery is direct.</span><span>Settlement is onchain.</span></div>
          </div>
        </header>

        <nav className={styles.chapterNav} aria-label="Protocol chapters"><div>{['discovery', 'routing', 'transport', 'payments', 'trust', 'incentives', 'resilience', 'protocol'].map((chapter, index) => <a key={chapter} href={`#${chapter}`}><span>0{index + 1}</span>{chapter}</a>)}</div></nav>

        <Chapter id="discovery" number="01" title="Discover peers. Read catalogs. Match locally." intro="Antseed uses BitTorrent’s BEP-5 discovery primitive to find peer endpoints. The DHT does not index individual models or carry prompts. Service catalogs arrive separately in signed metadata.">
          <div className={styles.split}>
            <Reveal className={styles.discoveryPanel}>
              <div className={styles.panelBar}><span>DISCOVERY / PEER ENUMERATION</span><span>Current protocol</span></div>
              <div className={styles.topic}>
                <span>01 / Wildcard lookup</span><code>SHA1("antseed:*")</code>
                <span>02 / Sequential subnet lookups</span><code>SHA1("antseed:subnet:0")</code><small>Repeat for subnet indexes 0 through 15.</small>
                <div className={styles.shards}>{Array.from({length: 16}, (_, index) => <i key={index} style={{'--delay': `${index * 0.13}s`} as CSSProperties}>{index}</i>)}</div>
                <small>Each seller announces one subnet, assigned from its peer ID. Buyers scan the subnets to enumerate peers.</small>
                <span className={styles.downArrow}>↓ Deduplicate host:port endpoints</span>
                <code>GET /metadata → verify → filter services</code>
              </div>
              <div className={styles.metadata}><span>SIGNED PROVIDER METADATA</span><dl><div><dt>Services</dt><dd>Models + capabilities</dd></div><div><dt>Offer</dt><dd>Pricing + current load</dd></div><div><dt>Endpoint</dt><dd>Public peer address</dd></div><div><dt>Identity</dt><dd>Signature + timestamp</dd></div></dl></div>
            </Reveal>
            <Reveal className={styles.prose}>
              <h3>Peer discovery, not a model index.</h3><p>Every seller announces <code>antseed:*</code>, one of 16 <code>antseed:subnet:&#123;index&#125;</code> topics, and <code>antseed:peer:&#123;peerId&#125;</code>. Configured offerings can also announce capability topics. There are no per-service or per-provider-name announcements.</p>
              <h3>Enumerate once. Filter the catalog locally.</h3><p>General discovery queries the wildcard first, then subnet topics sequentially. Foreground scans can stop at a time budget; background discovery completes the sweep. Buyers deduplicate endpoints, retrieve signed metadata, and filter its service catalog locally.</p><p>Keeping model names out of DHT announcements prevents the announcement count from growing with a seller’s catalog. A known peer can be resolved directly through its per-peer topic.</p>
              <h3>An announcement is not a free pass.</h3><p>Default discovery settings validate metadata schema, signature, and freshness before accepting an offer. SDK options can relax signature and freshness checks. Capability declarations are provider claims, not proof of model quality.</p>
              <h3>Bootstrap is an entrance, not a gateway.</h3><p>Default nodes join through Antseed bootstrap infrastructure. Those endpoints help establish discovery; they do not carry inference traffic. Bootstrap endpoints are configurable.</p>
              <DocLink to="/docs/discovery">Read the discovery protocol</DocLink>
            </Reveal>
          </div>
        </Chapter>

        <Chapter id="routing" number="02" title="The buyer is the router." intro="Your machine builds its own view of the network. It decides which providers are eligible and which offer to use. There is no hosted Antseed routing API making that decision.">
          <Reveal className={styles.funnel}>
            {[['12', 'Discovered', 'Signed service advertisements'], ['08', 'Compatible', 'Service and protocol match'], ['04', 'Eligible', 'Trust + allow/block policy'], ['01', 'Selected', 'Ready peers, then price']].map(([count, label, description]) => <div key={label}><strong>{count}</strong><h3>{label}</h3><p>{description}</p></div>)}
          </Reveal>
          <p className={styles.finePrint}>Illustrative candidates, not live network counts.</p>
          <div className={styles.textColumns}><div><h3>Policy belongs at the edge.</h3><p>Minimum trust and allow/block lists gate eligibility. Among eligible, ready peers, the shared ranker prefers lower advertised input-plus-output pricing, or the image-unit price. Its blended score breaks price ties. Pins and conversation affinity can override this ordering.</p><p>The routing preference for maximum input price is a scoring penalty, not a hard cap. The router’s separate <code>maxPricing</code> policy enforces hard price limits.</p></div><div><h3>Failures stay contextual.</h3><p>Cooldowns and recent errors affect your local route selection. A failed request is not a network-wide ban, and independent buyers can make different choices.</p></div><div><h3>Replace the decision layer.</h3><p>Router plugins let builders extend eligibility and provider selection. The buyer proxy also applies its shared model-routing policy, using the same discovery, transport, and payment layers.</p><DocLink to="/docs/router-api">Explore router plugins</DocLink></div></div>
        </Chapter>

        <Chapter id="transport" number="03" dark title="After discovery, take the direct path." intro="The selected provider receives the request. Antseed does not need to sit between you. Modern peers establish an authenticated encrypted connection and stream API-compatible traffic as binary frames.">
          <Reveal className={styles.transportDiagram}><div><span>01 / BUYER</span><strong>Your machine</strong><small>Routing policy · local state</small></div><div className={styles.encryptedPipe}><span>X25519 / HKDF-SHA256 / AES-256-GCM</span><div><i /><i /><i /></div><small>Requests → &nbsp; ← streamed responses</small></div><div><span>02 / PROVIDER</span><strong>Selected node</strong><small>Service execution · response</small></div></Reveal>
          <div className={styles.boundaries}>{[['On your machine', 'Routing preferences, local history, and provider allow/block rules.'], ['Between the peers', 'Requests, response chunks, and protocol messages. The provider can read the request it serves.'], ['On Base', 'Deposits, payment authorizations submitted for settlement, usage accounting, stake, and rewards. Prompts and outputs are not written to Base.']].map(([title, text]) => <div key={title}><h3>{title}</h3><p>{text}</p></div>)}</div>
          <p className={styles.transportNote}>Encrypted TCP is preferred when advertised; WebRTC DataChannels use DTLS and can use configured TURN relays. Legacy plaintext TCP remains a compatibility path unless secure transport is required. Transport encryption protects traffic between peers, not against the selected provider, and does not guarantee anonymity or no logging.</p>
          <DocLink to="/docs/transport">Inspect the transport and handshake</DocLink>
        </Chapter>

        <Chapter id="payments" number="04" title="Continuous usage. Not a transaction per token." intro="Base handles custody and final settlement. The high-frequency request path stays peer-to-peer, using cumulative buyer signatures instead of an onchain transaction for every request.">
          <div className={styles.split}><Reveal className={styles.prose}><h3>Reserve. Authorize. Settle.</h3><p>A buyer signs <code>ReserveAuth</code> to authorize a reservation before paid service. Subsequent <code>SpendingAuth</code> messages sign cumulative spending and a hash of usage metadata. Settlement charges the increase over the already-settled amount. Closing releases the unused reservation.</p><p>Authorizations can include bounded headroom for continued service. Signed spending is therefore not always identical to measured usage, and a provider can submit any valid authorization within the channel’s bounds.</p><h3>Separate custody from channel logic.</h3><p><code>AntseedDeposits</code> holds USDC. <code>AntseedChannels</code> manages reservations and settlement without holding the token. Contracts verify the buyer’s signature and enforce the channel’s reserved ceiling.</p><h3>Metering informs authorization.</h3><p>The buyer uses reported usage, local estimates, and unit-billing rules to decide what to authorize. Seller-side metering can persist signed receipts. Settlement verifies a spending signature, not a proof of output quality or independently verified inference.</p><p>The source contract defaults to a 2% protocol fee, configurable by its owner up to 10%. The deployed setting can differ. USDC is the settlement asset; desktop funding also offers card checkout where supported.</p><DocLink to="/docs/payments">Read the payment lifecycle</DocLink></Reveal><Reveal><PaymentChannel /></Reveal></div>
        </Chapter>

        <Chapter id="trust" number="05" title="Trust with a trail you can inspect." intro="Open participation needs more than a display name. Buyers compute trust from settled history, recognized activity, seller-pool backing, and verified identity signals.">
          <Reveal className={styles.trustGrid}>{[['60', 'History', 'Closed-channel count and settled USDC volume.'], ['15', 'Usage', 'Share of recognized usage in the last complete epoch.'], ['5', 'Power', 'Share of lock-weighted seller-pool power in the current epoch.'], ['20', 'Identity', 'Verified GitHub or domain history.']].map(([weight, title, text]) => <div key={title}><span>UP TO {weight} POINTS</span><h3>{title}</h3><p>{text}</p><div className={styles.weightTrack}><i style={{width: `${Number(weight) / 60 * 100}%`}} /></div></div>)}</Reveal>
          <div className={styles.trustFooter}><p><strong>Public signals, local decisions.</strong> Buyers combine these signals with their own routing preferences and runtime failures. A proven wash-trading flag zeros the trust score; a high score is not a cryptographic proof of output quality.</p><DocLink to="/docs/reputation">How trust is computed</DocLink></div>
        </Chapter>

        <Chapter id="incentives" number="06" title="Reward participation. Not just announcements." intro="USDC pays for authorized work. ANTS is a separate incentive layer for recognized usage and locked provider backing. These are different accounting systems, with different jobs.">
          <Reveal className={styles.incentiveLoop}>{[['01', 'Deliver a service', 'A buyer authorizes paid usage.'], ['02', 'Settle in USDC', 'Payment creates economic history.'], ['03', 'Recognize activity', 'Eligibility and points policies apply.'], ['04', 'Allocate rewards', 'Usage and pool power inform ANTS rewards.']].map(([number, title, text]) => <div key={number}><span>{number}</span><h3>{title}</h3><p>{text}</p></div>)}</Reveal>
          <div className={styles.textColumns}><div><h3>Stake is durable backing.</h3><p>Locked ANTS positions contribute seller-pool power. This is distinct from the USDC deposit used to pay for services.</p></div><div><h3>Not all volume earns rewards.</h3><p>Usage passes through eligibility and points policies. Payments can settle without earning rewards; a reward exclusion does not itself reverse a payment.</p></div><div><h3>Budgets are bounded.</h3><p>Reward allocations depend on activity and configured limits. Unallocated emissions follow explicit remainder and burn rules. Payouts are not guaranteed.</p><DocLink to="/docs/recognized-usage">Explore usage and incentives</DocLink></div></div>
        </Chapter>

        <Chapter id="resilience" number="07" title="Failure is part of the protocol." intro="Independent peers can go offline, fail requests, or advertise bad data. Recovery paths matter as much as the happy path.">
          <div className={styles.failureList}>{[
            ['A provider disappears.', 'Choose another eligible peer for subsequent requests, subject to pins and routing policy. To unlock a channel, the buyer’s configured deposits operator calls requestClose(), waits the 15-minute grace period, then calls withdraw(). Remaining funds return to the buyer’s deposit balance, not automatically to an external wallet.'],
            ['A peer repeatedly fails.', 'Local failure signals and cooldowns deprioritize it. This does not require a central operator to remove the peer for everyone.'],
            ['Metadata is forged or stale.', 'Under the default discovery configuration, signature, schema, and freshness checks reject invalid advertisements before they enter the buyer’s accepted candidate set.'],
            ['Infrastructure is unavailable.', 'Alternate configured bootstrap nodes can help discovery. Settlement still depends on Base and reachable RPC infrastructure; peer-to-peer does not mean dependency-free.'],
            ['Contract policy changes.', 'Contract owners retain administrative powers, including channel pause controls, fee configuration, and registry address updates. Peer-to-peer delivery does not make the settlement layer immutable or free of administrative trust.'],
          ].map(([title, text], index) => <Reveal key={title} className={styles.failure}><span>0{index + 1}</span><h3>{title}</h3><p>{text}</p></Reveal>)}</div>
          <DocLink to="/docs/security">Read the security boundaries</DocLink>
        </Chapter>

        <Chapter id="protocol" number="08" dark title="Every layer is inspectable." intro="The stack is the product: discovery, encrypted transport, metering, settlement, and reputation working together. Read the specification. Inspect the implementation. Build on the same primitives.">
          <div className={styles.stack}>{[
            ['05', 'Reputation', 'Trust scoring and identity signals', 'reputation', 'reputation'],
            ['04', 'Payments', 'USDC channels and settlement', 'payments', 'payments'],
            ['03', 'Metering', 'Usage accounting and signed receipts', 'metering', 'metering'],
            ['02', 'Transport', 'Peer authentication and encrypted framing', 'transport', 'p2p'],
            ['01', 'Discovery', 'DHT announcements and signed metadata', 'discovery', 'discovery'],
          ].map(([number, title, description, doc, directory]) => <div key={number}><span>{number}</span><h3>{title}</h3><p>{description}</p><Link to={`/docs/${doc}`}>Spec ↗</Link><a href={`${SOURCE}/packages/node/src/${directory}`}>Source ↗</a></div>)}</div>
          <div className={styles.closing}><h3>Run a node. Build a provider.<br />Make the network your own.</h3><div className={styles.ctas}><Button to="/docs/overview" variant="white" size="lg" arrow>Read the protocol</Button><Button to="/providers" variant="light" size="lg">Become a provider</Button></div><p>Open source · Independent peers · USDC settlement on Base</p></div>
        </Chapter>
      </main>
    </Layout>
  );
}
