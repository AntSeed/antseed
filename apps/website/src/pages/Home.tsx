import { useEffect, useRef, useState } from 'react'
import { Helmet } from 'react-helmet-async'
import { Link } from 'react-router-dom'
import { AntMarkFull } from '../components/AntMark'
import Footer from '../components/Footer'

function useReveal() {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) entry.target.classList.add('visible')
        })
      },
      { threshold: 0.1 }
    )
    el.querySelectorAll('.reveal').forEach((child) => observer.observe(child))
    return () => observer.disconnect()
  }, [])
  return ref
}

function InstallBox() {
  const [copied, setCopied] = useState(false)
  const handleCopy = () => {
    navigator.clipboard.writeText('npm install -g antseed-cli')
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }
  return (
    <button
      onClick={handleCopy}
      className="inline-flex items-center gap-3 bg-bg-2 border border-border rounded-md px-6 py-3 font-mono text-sm cursor-pointer hover:border-accent transition-colors"
    >
      <span className="text-accent">$</span>
      <span className="text-text">npm install -g antseed-cli</span>
      <span className={`text-xs ml-4 transition-colors ${copied ? 'text-accent' : 'text-text-muted hover:text-accent'}`}>
        {copied ? 'copied!' : 'copy'}
      </span>
    </button>
  )
}

function Hero() {
  return (
    <div className="min-h-screen flex flex-col justify-center items-center text-center px-5 sm:px-10 pt-[120px] pb-20 relative">
      <div className="relative z-[2]">
        <div className="flex justify-center mb-10 opacity-0 animate-fade-up-1">
          <div className="animate-float">
            <AntMarkFull size={100} />
          </div>
        </div>

        <div className="font-mono text-[13px] text-text-dim tracking-[4px] uppercase mb-6 opacity-0 animate-fade-up-1">
          A Peer-to-Peer AI Services Network
        </div>

        <h1 className="text-[clamp(44px,6vw,72px)] font-bold leading-[1.1] tracking-[-2px] mb-6 opacity-0 animate-fade-up-2">
          Your AI tools,<br /><span className="text-accent">unstoppable.</span>
        </h1>

        <p className="text-[15px] text-text-dim max-w-[560px] mx-auto mb-12 leading-[2] opacity-0 animate-fade-up-3">
          An open market for machines to trade intelligence. Agents discover, carry, and deliver AI services peer-to-peer. Everyone profits. No one controls.
        </p>

        <div className="flex gap-3 justify-center flex-wrap opacity-0 animate-fade-up-4">
          <Link to="/docs/lightpaper" className="font-mono text-xs font-medium px-7 py-3 bg-accent text-bg rounded-md transition-colors hover:bg-accent-dim no-underline tracking-[1px]">
            Light Paper
          </Link>
          <Link to="/docs" className="font-mono text-xs font-medium px-7 py-3 bg-transparent text-text-dim border border-[rgba(61,255,162,0.09)] rounded-md hover:border-accent hover:text-text transition-all no-underline tracking-[1px]">
            Read the Docs
          </Link>
        </div>

        <div className="mt-12 opacity-0 animate-fade-up-5">
          <InstallBox />
        </div>
      </div>
    </div>
  )
}



function HowItWorks() {
  const steps = [
    {
      step: '01',
      title: 'Install the daemon',
      desc: 'One command. Runs as a background service. Exposes an API-compatible endpoint on localhost. Your existing tools work without modification.',
    },
    {
      step: '02',
      title: 'Set your preferences',
      desc: 'Tell AntSeed what you care about: cheapest price, lowest latency, specific capabilities, TEE privacy, minimum provider reputation. The router scores all available providers and picks the best match in real time.',
    },
    {
      step: '03',
      title: 'Never stop working',
      desc: 'Hit a rate limit? Provider down? AntSeed detects it instantly and reroutes to the next best provider. Automatic failover across a decentralized network. Zero data loss on switch.',
    },
  ]

  return (
    <section id="how" className="py-[120px] px-5 sm:px-10 max-w-[1200px] mx-auto">
      <div className="reveal">
        <div className="font-mono text-[10px] text-accent tracking-[4px] uppercase mb-9 opacity-50">How It Works</div>
        <div className="text-[28px] font-bold tracking-[-0.5px] mb-2 leading-[1.3]">Install. Route. Unstoppable.</div>
        <div className="text-[15px] text-text-dim max-w-[640px] leading-[2] mb-12">
          AntSeed runs as a local proxy. Your tools send requests to localhost. The protocol handles everything else.
        </div>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-px reveal">
        {steps.map((s) => (
          <div key={s.step} className="bg-bg-2 p-10 relative hover:bg-bg-3 transition-colors">
            <div className="absolute top-5 right-6 font-mono text-[48px] font-bold text-accent opacity-[0.07]">{s.step}</div>
            <h3 className="font-mono text-[13px] font-medium text-accent tracking-[1px] mb-3">{s.title}</h3>
            <p className="text-sm text-text-dim leading-[1.8]">{s.desc}</p>
          </div>
        ))}
      </div>
    </section>
  )
}

function SupplySources() {
  const sources = [
    { name: 'Skilled Inference', tier: 'Differentiated · Reputation-based', desc: 'Anyone with frontier model API access can offer specialized agents with Skills — legal research, security audit, market analysis. Compete on outcomes, not just price.' },
    { name: 'Self-Hosted Operators', tier: 'Low cost · Variable uptime', desc: 'A gamer with a GPU, a developer with a Mac Mini running open-weight models. No terms-of-service issues. Cost basis is electricity and hardware depreciation.' },
    { name: 'Inference Farms', tier: 'Mid cost · 24/7 reliability', desc: 'Professional operators running optimized stacks at scale. Always on, high throughput, high stake. Farms in cheap-electricity regions set the global floor price.' },
    { name: 'Privacy / TEE Nodes', tier: 'Premium · Cryptographic proof', desc: 'Trusted Execution Environments where not even the operator can see prompts. Cryptographic attestation proves the enclave is genuine.' },
    { name: 'Custom Model Operators', tier: 'Premium · Unique capabilities', desc: 'Models serving use cases that cannot exist on centralized platforms — security research, red-teaming, unrestricted creative work.' },
    { name: 'Edge Providers', tier: 'Premium · Sub-100ms latency', desc: 'Metro-located nodes optimized for speed. For real-time coding assistants, chatbots, and agentic chains where every millisecond matters.' },
  ]

  return (
    <section id="supply" className="py-[120px] px-5 sm:px-10 max-w-[1200px] mx-auto">
      <div className="reveal">
        <div className="font-mono text-[10px] text-accent tracking-[4px] uppercase mb-9 opacity-50">Supply</div>
        <div className="text-[28px] font-bold tracking-[-0.5px] mb-2 leading-[1.3]">
          Anyone can provide.<br />No partnership required.
        </div>
        <div className="text-[15px] text-text-dim max-w-[640px] leading-[2] mb-12">
          The protocol is provider-agnostic. It does not care how a seller fulfills a request. It cares that a response came back, the receipt verified, and quality was consistent.
        </div>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-px reveal">
        {sources.map((s) => (
          <div key={s.name} className="bg-bg-2 py-9 px-9 border-l-2 border-l-transparent hover:border-l-accent hover:bg-bg-3 transition-all">
            <h3 className="text-base font-semibold mb-1.5">{s.name}</h3>
            <div className="font-mono text-[11px] text-accent tracking-[1px] uppercase mb-3 opacity-60">{s.tier}</div>
            <p className="text-sm text-text-dim leading-[1.8]">{s.desc}</p>
          </div>
        ))}
      </div>
    </section>
  )
}

function ThreeMarkets() {
  const markets = [
    {
      num: '01',
      title: 'Commodity Inference',
      desc: 'A seller has a model or API access. A buyer needs inference. They trade directly. Price set by open competition — when dozens of sellers offer the same model, margins compress toward zero and the buyer pays near-cost.',
    },
    {
      num: '02',
      title: 'Differentiated AI Services',
      desc: 'Same protocol, but the seller equips their model with Skills — modular packages of domain expertise and workflows. The buyer does not care what is inside. They care about the result and the reputation.',
    },
    {
      num: '03',
      title: 'Agent-to-Agent Commerce',
      desc: 'Same protocol, but now the buyers are also machines. An autonomous agent holds credits, discovers providers by capability, evaluates reputation, consumes services, and settles payment — without human involvement.',
    },
  ]

  return (
    <section className="py-[120px] px-5 sm:px-10 max-w-[1200px] mx-auto">
      <div className="reveal">
        <div className="font-mono text-[10px] text-accent tracking-[4px] uppercase mb-9 opacity-50">Three Markets</div>
        <div className="text-[28px] font-bold tracking-[-0.5px] mb-2 leading-[1.3]">
          One protocol.<br />Three use cases.
        </div>
        <div className="text-[15px] text-text-dim max-w-[640px] leading-[2] mb-12">
          Each builds on the one before it. All three share the same discovery, routing, reputation, and settlement mechanisms.
        </div>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-px reveal">
        {markets.map((m) => (
          <div key={m.num} className="bg-bg-2 p-10 relative hover:bg-bg-3 transition-colors">
            <div className="absolute top-5 right-6 font-mono text-[48px] font-bold text-accent opacity-[0.07]">{m.num}</div>
            <h3 className="font-mono text-[13px] font-medium text-accent tracking-[1px] mb-3">{m.title}</h3>
            <p className="text-sm text-text-dim leading-[1.8]">{m.desc}</p>
          </div>
        ))}
      </div>
    </section>
  )
}

function Roadmap() {
  const phases = [
    { label: 'Phase 1a', title: 'The Protocol', desc: 'P2P protocol goes live. Commodity inference and skilled services serve builders and agents. Settlement and reputation operational.', active: true },
    { label: 'Phase 1b', title: 'Differentiated Services', desc: 'Providers offer specialized AI services: fine-tuned models, agentic workflows, domain expertise. Capability-based discovery and per-skill reputation.' },
    { label: 'Phase 1c', title: 'Agent Network', desc: 'Autonomous agents use the network for inference and for hiring other agents. Agent-to-agent commerce emerges.' },
    { label: 'Phase 2', title: 'Price Index & Derivatives', desc: 'The AntSeed Compute Index — real-time pricing from verified transactions. Futures contracts let startups hedge AI costs and providers sell forward capacity.' },
  ]

  return (
    <section id="roadmap" className="py-[120px] px-5 sm:px-10 max-w-[1200px] mx-auto border-t border-[rgba(61,255,162,0.03)]">
      <div className="reveal">
        <div className="font-mono text-[10px] text-accent tracking-[4px] uppercase mb-9 opacity-50">Roadmap</div>
        <div className="text-[28px] font-bold tracking-[-0.5px] mb-12 leading-[1.3]">
          From marketplace to commodity standard.
        </div>
      </div>
      <div className="flex flex-wrap reveal">
        {phases.map((p) => (
          <div key={p.label} className="flex-[1_1_220px] px-6 mb-8 border-l border-[rgba(61,255,162,0.07)]">
            <div className="font-mono text-[11px] text-accent tracking-[2px] uppercase mb-2 opacity-60">{p.label}</div>
            <div className="text-base font-semibold mb-3">{p.title}</div>
            <p className="text-sm text-text-dim leading-[1.8]">{p.desc}</p>
          </div>
        ))}
      </div>
    </section>
  )
}

function CTASection() {
  return (
    <div className="py-[120px] px-5 sm:px-10 text-center border-t border-[rgba(61,255,162,0.03)]">
      <div className="reveal">
        <h2 className="text-[clamp(28px,4vw,44px)] font-bold tracking-[-1px] mb-4">
          Start providing. Start building.<br /><span className="text-accent">Start now.</span>
        </h2>
        <p className="text-[15px] text-text-dim mb-10">Everyone profits. No one controls.</p>
        <div className="flex gap-3 justify-center flex-wrap">
          <Link to="/docs" className="font-mono text-xs font-medium px-7 py-3 bg-accent text-bg rounded-md transition-colors hover:bg-accent-dim no-underline tracking-[1px]">
            Get Started
          </Link>
          <Link to="/docs/lightpaper" className="font-mono text-xs font-medium px-7 py-3 bg-transparent text-text-dim border border-[rgba(61,255,162,0.09)] rounded-md hover:border-accent hover:text-text transition-all no-underline tracking-[1px]">
            Light Paper
          </Link>
        </div>
      </div>
    </div>
  )
}

export default function Home() {
  const containerRef = useReveal()

  return (
    <div ref={containerRef}>
      <Helmet>
        <title>AntSeed — A Peer-to-Peer AI Services Network</title>
        <meta name="description" content="An open market for machines to trade intelligence. Agents discover, carry, and deliver AI services peer-to-peer. Everyone profits. No one controls." />
        <meta property="og:title" content="AntSeed — A Peer-to-Peer AI Services Network" />
        <meta property="og:description" content="An open market for machines to trade intelligence. Everyone profits. No one controls." />
        <meta name="twitter:title" content="AntSeed — A Peer-to-Peer AI Services Network" />
        <meta name="twitter:description" content="An open market for machines to trade intelligence. Everyone profits. No one controls." />
      </Helmet>
      <Hero />
      <HowItWorks />
      <SupplySources />
      <ThreeMarkets />
      <Roadmap />
      <CTASection />
      <Footer />
    </div>
  )
}
