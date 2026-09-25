import {useEffect, useState} from 'react';

import styles from './HeroAgentVisual.module.css';

const stages = ['Agent sends a request', 'Antseed routes to a provider', 'Model streams a response', 'Agent continues working'];
const agents = [
  {name: 'OpenClaw', logo: '/logos/openclaw.svg'},
  {name: 'Hermes', logo: '/logos/nousresearch.svg'},
  {name: 'Codex', logo: '/logos/openai.png'},
];

export function HeroAgentVisual({active}: {active: boolean}) {
  const [step, setStep] = useState(0);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const copyInstall = async () => {
    try {
      await navigator.clipboard.writeText('gh skill install AntSeed/antseed join-buyer');
      setCopied(true);
    } catch { /* Command remains selectable if clipboard access is unavailable. */ }
  };
  useEffect(() => {
    if (!active) return;
    setStep(0);
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const timer = window.setInterval(() => setStep(s => (s + 1) % stages.length), 2200);
    return () => window.clearInterval(timer);
  }, [active]);
  return <div className={`${styles.card} ${!active ? styles.paused : ''}`}>
    <div className={styles.top}><span><i /> Agents, connected.</span></div>
    <div className={styles.scene}>
      <svg viewBox="0 0 600 300" role="img" aria-label="Agent requests flow through Antseed to models, then responses return to the agents">
        <defs>
          <radialGradient id="agent-glow"><stop stopColor="#16a66a" stopOpacity=".16"/><stop offset="1" stopColor="#16a66a" stopOpacity="0"/></radialGradient>
        </defs>
        <circle cx="300" cy="150" r="130" fill="url(#agent-glow)" />
        {[65,150,235].map((y,i) => <g key={y}>
          <path className={styles.route} d={`M120 ${y} C210 ${y} 210 150 265 150 M335 150 C390 150 390 ${y} 465 ${y}`} />
          <path className={styles.packet} style={{animationDelay: `${i * .65}s`}} d={`M120 ${y} C210 ${y} 210 150 265 150 M335 150 C390 150 390 ${y} 465 ${y}`} />
          <path className={styles.response} style={{animationDelay: `${i * .65 + 2}s`}} d={`M120 ${y} C210 ${y} 210 150 265 150 M335 150 C390 150 390 ${y} 465 ${y}`} />
          <rect className={styles.node} x="20" y={y-27} width="100" height="54" rx="14" />
          <image href={agents[i].logo} x="60" y={y-22} width="20" height="20" />
          <text className={styles.text} x="70" y={y+19} textAnchor="middle">{agents[i].name}</text>
          <rect className={styles.node} x="465" y={y-27} width="115" height="54" rx="14" />
          <circle cx="522" cy={y-15} r="3" fill="#16a66a" />
          <text className={styles.text} x="522" y={y+13} textAnchor="middle">{['Reasoning','Coding','Fast models'][i]}</text>
        </g>)}
        <circle className={styles.ring} cx="300" cy="150" r="44" />
        <circle className={styles.hub} cx="300" cy="150" r="35" />
        <image href="/logo.svg" x="280" y="130" width="40" height="40" />
        <text className={styles.caption} x="300" y="222" textAnchor="middle">ANTSEED</text>
        <text className={styles.caption} x="70" y="292" textAnchor="middle">YOUR AGENTS</text>
        <text className={styles.caption} x="522" y="292" textAnchor="middle">AI MODELS</text>
      </svg>
    </div>
    <div className={styles.activity}><span className={styles.indicator} /><span key={step} className={styles.activityText}>{stages[step]}</span><span className={styles.steps}>{stages.map((_, i) => <i key={i} className={step === i ? styles.current : ''} />)}</span></div>
    <div data-agent-install key={active ? 'open' : 'closed'} className={styles.install}>
      <div className={styles.installHeader}><span>Install the agent skill</span><button type="button" onClick={copyInstall} aria-label="Copy agent skill install command" aria-live="polite">{copied ? 'Copied' : 'Copy'}</button></div>
      <pre className={styles.installCode}><code><span>gh skill install \\</span>{'\n'}<span>  AntSeed/antseed join-buyer</span></code></pre>
    </div>
  </div>;
}
