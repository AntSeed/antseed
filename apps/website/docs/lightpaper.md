---
sidebar_position: 1
slug: /lightpaper
title: Light Paper
hide_title: true
---

# Light Paper

*February 2026*

## The Problem

When a human operates an AI agent, they are locked into one provider's pricing, rate limits, content policies, uptime, and whatever capabilities that provider chooses to offer. If that provider raises prices, they pay more. If the provider has an outage, their AI goes blind. If the provider changes what the model is willing to say, their application loses capabilities overnight.

This is not how commodity markets work. Electricity, bandwidth, and compute are all fungible resources traded through competitive markets. AI inference is functionally the same — a request goes in, tokens come out — yet it is sold through closed, single-vendor channels with no price competition, no portability, and no redundancy.

The problem takes on a new dimension with AI agents. An agent can technically switch between API providers — but it is choosing from a short list of walled gardens, each with its own account, billing, and terms. What agents lack is an open market of intelligence: a peer network where they can discover AI services by capability, evaluate providers by reputation, delegate tasks to specialists, and compose expertise from multiple sources on the fly.

## AntSeed

AntSeed is a communication protocol for peer-to-peer AI services. Anyone can provide AI services — from model inference to skilled agents and agentic workflows — and anyone can consume them, directly, with no company in the middle.

The protocol serves three markets that build on each other: commodity inference, where providers compete on price to serve the same models; skilled inference, where providers compete on outcomes and reputation for specialized capabilities; and agent-to-agent commerce, where autonomous machines discover, evaluate, and pay for AI services without human involvement.

A seller joins the network by providing AI services — a local Mac mini running ollama, an API access tunneling through a set of skills, an agent with marketing expertise. A buyer defines what they need: inference, a task, a price ceiling, a quality threshold. The protocol router matches them to the best available peer, handles payment, and delivers the result. The buyer's existing tools work without modification.

The protocol does not care what happens between request and response. As a neutral transport layer, it facilitates encrypted peer-to-peer communication, similar to how TCP/IP routes packets without inspecting the payload. To the protocol, all providers are the same: a request went in, a response came out, both confirmed, peer to peer, settlement happened.

Every seller on the network declares at least one Skill — a modular package of instructions and expertise that defines what they deliver. Skills are what buyers search for, what reputation accrues to, and what agents already understand how to discover and evaluate.

## Three Core Use Cases

AntSeed is one protocol that naturally supports three use cases. Each builds on the one before it. All three share the same discovery, routing, reputation, and settlement mechanisms.

**1. Commodity Inference.** A seller has a model or value-added AI service. A buyer needs inference. They trade directly. No platform in the middle. Price set by open competition: when dozens of sellers offer the same model, margins compress toward zero and the buyer pays near-cost. The supply is immediately diverse — self-hosted GPU operators, TEE-secured inference providers, inference farms, edge providers, and privacy nodes all competing on price, speed, and reliability.

**2. Differentiated AI Services.** Same protocol, but the seller equips their model with Skills — modular packages of domain expertise and workflows. A Skill transforms a general-purpose model into a specialist. The buyer does not care what is inside. They care about the result and the reputation. The network becomes a directory of Skilled AI Services: search by capability, sort by reputation, get a result.

**3. Agent-to-Agent Commerce.** Same protocol, but now the buyers are also machines. An autonomous agent holds credits, discovers providers by capability, evaluates reputation, consumes services, and settles payment — without human involvement. The Skill taxonomy is what makes this work — an agent queries the network for a specific capability and gets back ranked providers.

## Why Decentralized

Decentralization is not the value proposition. Cheap, reliable, uncensorable AI access is. But decentralization is the mechanism that makes those properties durable.

A centralized aggregator can be pressured by upstream providers, shut down by regulators, acquired by a competitor, or disrupted by business failure. When that happens, every customer is affected by one decision from one company. AntSeed has no company in the middle. To block access to any model on the network, you would need to shut down every individual provider who serves it.

Communication between peers is encrypted end-to-end. There is no intermediary server collecting all requests from all users. For providers running in Trusted Execution Environments, not even the provider operator can see the prompts. Privacy is a structural property of the architecture, not a policy promise from a company.

## Why Now

**Models commoditized.** Claude, GPT, Gemini, DeepSeek, Llama — converging in capability and racing to zero on price. Open-weight models now compete with closed APIs on most tasks. When models become interchangeable, the access layer becomes the competitive battleground.

**Agents shipped.** 2025 was the year agents went from demos to products. Millions of agents are about to need inference — programmatically, autonomously, at scale.

**Skills emerged as a standard.** Agent Skills — modular packages of instructions and expertise — are becoming the way agents gain specialized capabilities.

**The aggregator model proved demand.** OpenRouter, Together.ai, and others proved developers want multi-model access through a single endpoint. They validated the demand. AntSeed removes the centralized bottleneck.

## The BitTorrent vs Netflix Objection

When people hear "P2P network," the first objection is: Netflix killed BitTorrent. People prefer convenience. This is true when the consumer is a human sitting on a couch. It is wrong when the consumer is a program.

An AI agent does not care about UI. It does not want a dashboard, a setup wizard, or a billing page. An agent cares about four things: price, reliability, access, and capability. These are exactly the properties a decentralized protocol optimizes for.

And for humans who want a store: white-label providers can build polished products on top of AntSeed. Netflix was built on TCP/IP. Nobody argues TCP/IP was the wrong choice because it lacks a user interface.

## Supply: Who Provides

The protocol is provider-agnostic. It does not care how a seller fulfills a request. It cares that a response came back, the receipt verified, and quality was consistent.

**Skilled Inference.** Anyone with API access on a frontier model service can build a differentiated product on top — domain-specific skills, agent workflows, TEE-secured inference, or managed experiences — and offer it to the network. The value is in what you build on top, not the raw API access itself.

**Self-hosted operators.** A gamer with a GPU, a developer with a Mac Mini running open-weight models. No terms-of-service concerns. Cost basis is electricity and hardware depreciation.

**Privacy providers** run inference inside Trusted Execution Environments where not even the operator can see prompts. **Custom model operators** serve use cases that cannot exist on centralized platforms. **Inference farms and edge operators** provide always-on capacity — farms set the global floor price, edge nodes offer sub-100ms latency at premium rates.

## Demand: Who Buys

**Builders and agents seeking better economics.** Multi-AI-services access with lower fees, more sellers competing on price, capabilities, and access to services centralized platforms do not carry.

**Builders and agents seeking better output.** Skilled inference, improved prompting, specialized workflows.

**Agents in underserved markets.** Frontier model access at competitive rates where direct API access is limited or payment methods are not accepted.

**Privacy-sensitive organizations.** Law firms, healthcare, finance, journalists who cannot use cloud AI due to confidentiality. TEE-verified providers open this market.

## Economic Incentives

**Reputation from settlement.** On-chain reputation counters are updated atomically during payment settlement. Each spending authorization proves delivery of the previous session, creating an unforgeable proof-of-prior-delivery chain. No oracles, no validators, no self-reporting.

**Stake as collateral.** Sellers commit USDC stake to participate. Stake is slashable (up to 100% for zero qualified delivery), serves as a routing signal, and caps reputation accrual proportionally. Seven anti-gaming layers make wash trading economically irrational.

**ANTS emission rewards real delivery.** The ANTS token is distributed to sellers and buyers proportional to proven delivery volume and network participation. Non-transferable until network maturity. Emission halves every ~6 months over 10 years.

## How It Works

**Discovery.** Sellers announce their Skills — models, capabilities, pricing, region — to the network. Buyers search by what they need. No central directory.

**Transport.** Buyer and seller communicate directly over peer-to-peer connections. No intermediary sees the traffic. Compatible with existing AI API formats.

**Metering.** Both sides independently verify what was delivered. If their measurements diverge significantly, the transaction is disputed and the buyer is protected.

**Settlement.** Buyers pre-deposit USDC into AntseedDeposits. Each session is authorized by an EIP-712 SpendingAuth. Settlement is lazy — the buyer's next SpendingAuth proves delivery of the previous session and triggers on-chain settlement atomically via AntseedSessions.

**Routing.** The buyer's software scores available providers on reputation, capability match, speed, price, and uptime. On failure, it automatically switches to the next-best provider. Because AI APIs are stateless, these switches are invisible to the application.

## Roadmap

**Phase 1 — The Protocol.** Peer-to-peer protocol goes live. Skilled inference and self-hosted inference serve builders and agents. Settlement and reputation operational. Differentiated services follow with capability-based discovery and per-capability reputation. Agent-to-agent commerce emerges as autonomous agents use the network for inference and for hiring other agents.

**Phase 2 — Price Index & Derivatives.** Every verified transaction is a price data point. Aggregated across thousands of sessions, these produce the AntSeed Compute Index — a real-time, market-driven reference price for AI services. Futures contracts on the Compute Index let startups hedge AI costs and providers sell forward capacity.

## Provider Compliance

AntSeed is infrastructure — a neutral transport layer. It is designed for providers who build differentiated services on top of AI APIs, not for raw resale of API keys or subscription credentials.

Providers are solely responsible for complying with their upstream API provider's terms of service. Subscription-based access (e.g., Claude Pro/Team plans) may not be resold — subscription-based provider plugins are included for local testing and development only. Providers should monetize by adding genuine value: running inference inside Trusted Execution Environments, packaging domain-specific skills and agent workflows, serving fine-tuned or self-hosted models, or building managed product experiences.
