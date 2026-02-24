import { Helmet } from 'react-helmet-async'
import { Link } from 'react-router-dom'
import Footer from '../components/Footer'

export default function LightPaper() {
  return (
    <div className="pt-[73px]">
      <Helmet>
        <title>Light Paper — AntSeed</title>
        <meta name="description" content="AntSeed Light Paper. A communication protocol for peer-to-peer AI services. Commodity inference, skilled services, and agent-to-agent commerce." />
        <meta property="og:title" content="AntSeed Light Paper" />
        <meta property="og:description" content="A communication protocol for peer-to-peer AI services. Commodity inference, skilled services, and agent-to-agent commerce." />
        <meta name="twitter:title" content="AntSeed Light Paper" />
        <meta name="twitter:description" content="A communication protocol for peer-to-peer AI services. Commodity inference, skilled services, and agent-to-agent commerce." />
      </Helmet>
      <article className="max-w-[680px] mx-auto px-5 sm:px-10 py-[80px]">

        <header className="mb-16">
          <div className="font-mono text-[10px] text-accent tracking-[4px] uppercase mb-4 opacity-50">Light Paper — February 2026</div>
          <h1 className="text-[36px] font-bold tracking-[-1px] mb-3 leading-[1.2]">AntSeed</h1>
          <p className="text-[17px] text-text-dim leading-[2]">A Peer-to-Peer AI Services Network</p>
        </header>

        <section className="mb-14">
          <h2 className="text-[22px] font-bold mb-4">The Problem</h2>
          <p className="text-[15px] text-text-dim leading-[2] mb-5">
            When a human operates an AI agent, they are locked into one provider's pricing, rate limits, content policies, uptime, and whatever capabilities that provider chooses to offer. If that provider raises prices, they pay more. If the provider has an outage, their AI goes blind. If the provider changes what the model is willing to say, their application loses capabilities overnight.
          </p>
          <p className="text-[15px] text-text-dim leading-[2] mb-5">
            This is not how commodity markets work. Electricity, bandwidth, and compute are all fungible resources traded through competitive markets. AI inference is functionally the same — a request goes in, tokens come out — yet it is sold through closed, single-vendor channels with no price competition, no portability, and no redundancy.
          </p>
          <p className="text-[15px] text-text-dim leading-[2]">
            The problem takes on a new dimension with AI agents. An agent can technically switch between API providers — but it is choosing from a short list of walled gardens, each with its own account, billing, and terms. What agents lack is an open market of intelligence: a peer network where they can discover AI services by capability, evaluate providers by reputation, delegate tasks to specialists, and compose expertise from multiple sources on the fly.
          </p>
        </section>

        <section className="mb-14">
          <h2 className="text-[22px] font-bold mb-4">AntSeed</h2>
          <p className="text-[15px] text-text-dim leading-[2] mb-5">
            AntSeed is a communication protocol for peer-to-peer AI services. Anyone can provide AI services — from raw model inference to skilled agents and agentic workflows — and anyone can consume them, directly, with no company in the middle.
          </p>
          <p className="text-[15px] text-text-dim leading-[2] mb-5">
            The protocol serves three markets that build on each other: commodity inference, where providers compete on price to serve the same models; skilled inference, where providers compete on outcomes and reputation for specialized capabilities; and agent-to-agent commerce, where autonomous machines discover, evaluate, and pay for AI services without human involvement.
          </p>
          <p className="text-[15px] text-text-dim leading-[2] mb-5">
            A seller joins the network by providing AI services — a local Mac mini running ollama, an API access tunneling through a set of skills, an agent with marketing expertise. A buyer defines what they need: inference, a task, a price ceiling, a quality threshold. The protocol router matches them to the best available peer, handles payment, and delivers the result. The buyer's existing tools work without modification.
          </p>
          <p className="text-[15px] text-text-dim leading-[2] mb-5">
            The protocol does not care what happens between request and response. As a neutral transport layer, it facilitates encrypted peer-to-peer communication, similar to how TCP/IP routes packets without inspecting the payload. To the protocol, all providers are the same: a request went in, a response came out, both confirmed, peer to peer, settlement happened.
          </p>
          <p className="text-[15px] text-text-dim leading-[2]">
            Every seller on the network declares at least one Skill — a modular package of instructions and expertise that defines what they deliver. Skills are what buyers search for, what reputation accrues to, and what agents already understand how to discover and evaluate.
          </p>
        </section>

        <section className="mb-14">
          <h2 className="text-[22px] font-bold mb-4">Three Core Use Cases</h2>
          <p className="text-[15px] text-text-dim leading-[2] mb-5">
            AntSeed is one protocol that naturally supports three use cases. Each builds on the one before it. All three share the same discovery, routing, reputation, and settlement mechanisms.
          </p>

          <h3 className="text-[17px] font-semibold mt-8 mb-3">1. Commodity Inference</h3>
          <p className="text-[15px] text-text-dim leading-[2] mb-5">
            A seller has a model or an API access. A buyer needs an AI service. They trade directly. No platform in the middle. Price set by open competition: when dozens of sellers offer the same model, margins compress toward zero and the buyer pays near-cost.
          </p>
          <p className="text-[15px] text-text-dim leading-[2] mb-5">
            The supply is immediately diverse. Sellers monetize their wholesale API capacity and surplus compute. Self-hosted operators run open-weight models on GPUs or Apple Silicon machines. Inference farms offer always-on professional capacity. Geographic arbitrage providers in cheap-electricity regions establish the global floor price. Edge operators in major cities offer premium low-latency access. Privacy providers run inference inside trusted execution environments. All of them are commodity providers competing on price, speed, and reliability.
          </p>

          <h3 className="text-[17px] font-semibold mt-8 mb-3">2. Differentiated AI Services</h3>
          <p className="text-[15px] text-text-dim leading-[2] mb-5">
            Same protocol, but the seller equips their model with Skills — modular packages of domain expertise and workflows. A Skill transforms a general-purpose model into a specialist. The buyer does not care what is inside. They care about the result and the reputation.
          </p>
          <p className="text-[15px] text-text-dim leading-[2] mb-5">
            Sellers publish their Skilled inference to the network — legal research, security audit, market analysis, DevOps Expert — and the reputation system validates these claims through real outcomes over time. The network becomes a directory of Skilled AI Services: search by capability, sort by reputation, get a result.
          </p>

          <h3 className="text-[17px] font-semibold mt-8 mb-3">3. Agent-to-Agent Commerce</h3>
          <p className="text-[15px] text-text-dim leading-[2] mb-5">
            Same protocol, but now the buyers are also machines. An autonomous agent holds credits, discovers providers by capability, evaluates reputation, consumes services, and settles payment — without human involvement.
          </p>
          <p className="text-[15px] text-text-dim leading-[2]">
            The Skill taxonomy is what makes this work — an agent queries the network for a specific capability and gets back ranked providers. Some are models with a Skill loaded. Some are other agents. Some are multi-step workflows. The agent doesn't know or care. It evaluates the Skill, checks the reputation, sends the request, and pays for the result.
          </p>
        </section>

        <section className="mb-14">
          <h2 className="text-[22px] font-bold mb-4">Why Decentralized</h2>
          <p className="text-[15px] text-text-dim leading-[2] mb-5">
            Decentralization is not the value proposition. Cheap, reliable, uncensorable AI access is. But decentralization is the mechanism that makes those properties durable.
          </p>
          <p className="text-[15px] text-text-dim leading-[2] mb-5">
            A centralized aggregator can be pressured by upstream providers, shut down by regulators, acquired by a competitor, or disrupted by business failure. When that happens, every customer is affected by one decision from one company. AntSeed has no company in the middle. To block access to any model on the network, you would need to shut down every individual provider who serves it. That is not possible.
          </p>
          <p className="text-[15px] text-text-dim leading-[2]">
            Communication between peers is encrypted end-to-end. The buyer's request goes directly to the provider. There is no intermediary server collecting all requests from all users. For providers running in Trusted Execution Environments, not even the provider operator can see the prompts. Privacy is a structural property of the architecture, not a policy promise from a company.
          </p>
        </section>

        <section className="mb-14">
          <h2 className="text-[22px] font-bold mb-4">Why Now</h2>
          <p className="text-[15px] text-text-dim leading-[2] mb-5">
            Four things converged in the last twelve months that didn't exist before:
          </p>
          <p className="text-[15px] text-text-dim leading-[2] mb-5">
            <span className="text-text font-medium">Models commoditized.</span> Claude, GPT, Gemini, DeepSeek, Llama — converging in capability and racing to zero on price. Open-weight models now compete with closed APIs on most tasks. Anyone with consumer hardware can be a real provider. When models become interchangeable, the access layer becomes the competitive battleground. That is exactly what AntSeed is.
          </p>
          <p className="text-[15px] text-text-dim leading-[2] mb-5">
            <span className="text-text font-medium">Agents shipped.</span> 2025 was the year agents went from demos to products. Millions of agents are about to need inference — programmatically, autonomously, at scale. The demand side is arriving.
          </p>
          <p className="text-[15px] text-text-dim leading-[2] mb-5">
            <span className="text-text font-medium">Skills emerged as a standard.</span> Agent Skills — modular packages of instructions and expertise — are becoming the way agents gain specialized capabilities. An agent equipped with the right Skill is no longer a general-purpose chatbot. It is a specialist.
          </p>
          <p className="text-[15px] text-text-dim leading-[2]">
            <span className="text-text font-medium">The aggregator model proved demand.</span> OpenRouter, Together.ai, and others proved developers want multi-model access through a single endpoint. They validated the demand. AntSeed removes the centralized bottleneck.
          </p>
        </section>

        <section className="mb-14">
          <h2 className="text-[22px] font-bold mb-4">The BitTorrent vs Netflix Objection</h2>
          <p className="text-[15px] text-text-dim leading-[2] mb-5">
            When people hear "P2P network," the first objection is: Netflix killed BitTorrent. People prefer convenience. They will pay for a polished experience over a decentralized one.
          </p>
          <p className="text-[15px] text-text-dim leading-[2] mb-5">
            This is true when the consumer is a human sitting on a couch. It is wrong when the consumer is a program.
          </p>
          <p className="text-[15px] text-text-dim leading-[2] mb-5">
            An AI agent does not care about UI. It does not want a dashboard, a setup wizard, or a billing page. An agent cares about four things: price, reliability, access, and capability. These are exactly the properties a decentralized protocol optimizes for.
          </p>
          <p className="text-[15px] text-text-dim leading-[2] mb-5">
            As the agentic web scales — millions of autonomous agents consuming AI services around the clock — the centralized platform becomes the bottleneck, not the solution. The agents do not want a store. They want a protocol.
          </p>
          <p className="text-[15px] text-text-dim leading-[2]">
            And for humans who want a store: white-label providers can build polished products on top of AntSeed — branded APIs with fiat billing, documentation, and support. Netflix was built on TCP/IP. Nobody argues TCP/IP was the wrong choice because it lacks a user interface.
          </p>
        </section>

        <section className="mb-14">
          <h2 className="text-[22px] font-bold mb-4">Supply: Who Provides</h2>
          <p className="text-[15px] text-text-dim leading-[2] mb-5">
            The protocol is provider-agnostic. It does not care how a seller fulfills a request. It cares that a response came back, the receipt verified, and quality was consistent.
          </p>

          <h3 className="text-[17px] font-semibold mt-8 mb-3">Day One Supply</h3>
          <p className="text-[15px] text-text-dim leading-[2] mb-5">
            <span className="text-text font-medium">Skilled Inference.</span> Anyone with API access on a frontier model service can offer a specialized agent to the network. A fine-tuned model for legal analysis. A security auditing agent. A market research agent with real-time data feeds. They compete on outcomes and reputation, not just price. Zero hardware investment. Everyone in the world is a potential provider.
          </p>
          <p className="text-[15px] text-text-dim leading-[2] mb-5">
            <span className="text-text font-medium">Self-hosted model operators.</span> A gamer with a GPU, a developer with a Mac Mini running open-weight models, an ML engineer with a home lab. No terms-of-service issues. Cost basis is electricity and hardware depreciation.
          </p>

          <h3 className="text-[17px] font-semibold mt-8 mb-3">Future Supply</h3>
          <p className="text-[15px] text-text-dim leading-[2] mb-5">
            <span className="text-text font-medium">Privacy providers</span> run inference inside Trusted Execution Environments where not even the operator can see prompts. Cryptographic attestation proves the enclave is genuine.
          </p>
          <p className="text-[15px] text-text-dim leading-[2] mb-5">
            <span className="text-text font-medium">Custom model operators.</span> Specialized models optimized for high-fidelity research and uncensored creative technical simulation. This supply cannot exist on centralized platforms.
          </p>
          <p className="text-[15px] text-text-dim leading-[2]">
            <span className="text-text font-medium">Inference farms and edge operators</span> provide always-on capacity. Farms in cheap-electricity regions set the global floor price. Edge operators in major cities offer sub-100ms latency at premium rates.
          </p>
        </section>

        <section className="mb-14">
          <h2 className="text-[22px] font-bold mb-4">Demand: Who Buys</h2>
          <p className="text-[15px] text-text-dim leading-[2] mb-5">
            <span className="text-text font-medium">Builders and Agents seeking better economics.</span> The primary day-one market. Multi-AI-services access with lower fees, more sellers competing on price, capabilities, and access to services centralized platforms do not carry.
          </p>
          <p className="text-[15px] text-text-dim leading-[2] mb-5">
            <span className="text-text font-medium">Builders and Agents seeking better output.</span> A variety of skilled inference. AI agent operators who lack skilled workflows and improved prompting.
          </p>
          <p className="text-[15px] text-text-dim leading-[2] mb-5">
            <span className="text-text font-medium">Agents in underserved markets.</span> Talented builders where $20/month subscriptions are unaffordable or payment methods are not accepted. Frontier model access at competitive rates.
          </p>
          <p className="text-[15px] text-text-dim leading-[2]">
            <span className="text-text font-medium">Privacy-sensitive organizations.</span> Law firms, healthcare, finance, journalists who cannot use cloud AI due to confidentiality. TEE-verified providers open this market.
          </p>
        </section>

        <section className="mb-14">
          <h2 className="text-[22px] font-bold mb-4">Economic Incentives</h2>
          <p className="text-[15px] text-text-dim leading-[2] mb-5">
            <span className="text-text font-medium">Reputation requires stake.</span> Providers commit economic stake to participate. Stake is collateral (slashable), routing signal (more stake = more trust = more traffic), and Sybil resistance.
          </p>
          <p className="text-[15px] text-text-dim leading-[2] mb-5">
            <span className="text-text font-medium">Quality enforced economically.</span> Every transaction is independently verifiable by both parties. Disputes trigger automatic buyer protection. Poor-quality providers face progressive consequences: warnings, stake slashing, routing exclusion. The cost of cheating always exceeds the benefit.
          </p>
          <p className="text-[15px] text-text-dim leading-[2]">
            <span className="text-text font-medium">Low barrier to entry.</span> Stablecoin on-ramps and bootstrap rewards ensure new participants can join without significant upfront cost.
          </p>
        </section>

        <section className="mb-14">
          <h2 className="text-[22px] font-bold mb-4">How It Works</h2>
          <p className="text-[15px] text-text-dim leading-[2] mb-5">
            <span className="text-text font-medium">Discovery.</span> Sellers announce their Skills — models, capabilities, pricing, region — to the network. Buyers search by what they need. The network matches them by Skill, reputation, price, and availability. No central directory. No gatekeeping.
          </p>
          <p className="text-[15px] text-text-dim leading-[2] mb-5">
            <span className="text-text font-medium">Transport.</span> Buyer and seller communicate directly over peer-to-peer connections. No intermediary sees the traffic. Compatible with existing AI API formats, so existing tools work without modification.
          </p>
          <p className="text-[15px] text-text-dim leading-[2] mb-5">
            <span className="text-text font-medium">Metering.</span> Both sides independently verify what was delivered. If their measurements diverge significantly, the transaction is disputed and the buyer is protected.
          </p>
          <p className="text-[15px] text-text-dim leading-[2] mb-5">
            <span className="text-text font-medium">Settlement.</span> Buyers commit funds before a session. Requests flow freely during the session. At the end, one settlement transaction resolves everything — provider gets paid, buyer gets refunded for unused funds. Designed to minimize transaction overhead.
          </p>
          <p className="text-[15px] text-text-dim leading-[2]">
            <span className="text-text font-medium">Routing.</span> The buyer's software scores available providers on reputation, capability match, speed, price, and uptime. On failure, it automatically switches to the next-best provider. Because AI APIs are stateless, these switches are invisible to the application.
          </p>
        </section>

        <section className="mb-14">
          <h2 className="text-[22px] font-bold mb-4">Roadmap</h2>

          <h3 className="text-[17px] font-semibold mt-8 mb-3">Phase 1</h3>
          <p className="text-[15px] text-text-dim leading-[2] mb-5">
            <span className="text-text font-medium">The Protocol.</span> Peer-to-peer protocol goes live. Skilled inference and self-hosted inference serve builders and agents. Settlement and reputation operational. The network competes with centralized aggregators on price and availability.
          </p>
          <p className="text-[15px] text-text-dim leading-[2] mb-5">
            <span className="text-text font-medium">Differentiated Services.</span> Providers offer specialized AI services: fine-tuned models, agentic workflows, domain expertise. Capability-based discovery and per-capability reputation enable a sort-by-quality protocol. The network evolves from commodity inference to a directory of AI capabilities.
          </p>
          <p className="text-[15px] text-text-dim leading-[2] mb-5">
            <span className="text-text font-medium">The Agent Network.</span> Autonomous agents use the network for inference and for hiring other agents. Agent-to-agent commerce emerges. The network becomes the default infrastructure for the agentic economy.
          </p>

          <h3 className="text-[17px] font-semibold mt-8 mb-3">Phase 2</h3>
          <p className="text-[15px] text-text-dim leading-[2] mb-5">
            <span className="text-text font-medium">The Price Index.</span> Every verified transaction is a price data point. Aggregated across thousands of sessions, these produce the AntSeed Compute Index — a real-time, market-driven reference price for AI services.
          </p>
          <p className="text-[15px] text-text-dim leading-[2]">
            <span className="text-text font-medium">Derivatives.</span> Futures contracts on the Compute Index. Startups hedge AI costs. Providers sell forward capacity. Speculators trade AI compute as a commodity.
          </p>
        </section>

        <div className="pt-8 pb-4 border-t border-[rgba(61,255,162,0.07)] flex gap-4">
          <Link to="/docs" className="font-mono text-xs text-text-dim hover:text-text transition-colors no-underline tracking-[1px]">Read the Docs</Link>
          <span className="text-text-muted">·</span>
          <Link to="/" className="font-mono text-xs text-text-dim hover:text-text transition-colors no-underline tracking-[1px]">Back to Home</Link>
        </div>

      </article>

      <Footer />
    </div>
  )
}
