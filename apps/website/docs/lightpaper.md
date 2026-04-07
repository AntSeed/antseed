---
sidebar_position: 1
slug: /lightpaper
title: Light Paper
hide_title: true
---

# Light Paper

*April 2026*

## The Thesis

Open-source AI models are getting more powerful every quarter. They are also getting smaller and easier to run. Models that required a data center two years ago now run on a single GPU. Models that required a GPU will soon run on a laptop. The result: more providers can offer top-tier open-source models, from inference companies and GPU operators to individuals running models at home.

This is the trend AntSeed is built on. As open-source models close the gap with closed APIs, the number of people and organizations capable of serving high-quality inference explodes. A peer-to-peer network turns that growing supply into a global, open market. More providers means more competition. More competition means lower prices. Smaller providers who could never compete with centralized platforms can now reach buyers directly.

## The Problem

Today, if you want multi-model AI access through a single endpoint, you have one real option: OpenRouter. OpenRouter is a centralized aggregator. It decides which providers get listed. It decides which models are available. Every request passes through their servers. It holds provider earnings until payout. It requires KYC. It is a gatekeeper dressed as infrastructure.

This is not how commodity markets work. Electricity, bandwidth, and compute are fungible resources traded through competitive markets. AI inference is the same, a request goes in, tokens come out, yet it is sold through closed, single-vendor channels with no price competition, no portability, and no redundancy.

The problem compounds with AI agents. An agent can technically switch between API providers, but it is choosing from a short list of walled gardens, each with its own account, billing, and terms. What agents need is an open market for intelligence: a peer-to-peer network where they can discover AI services by capability, evaluate providers by reputation, and settle payment, without asking anyone for permission.

## AntSeed

AntSeed is a communication protocol for peer-to-peer AI services. Anyone can provide AI services, from model inference to specialized agents and routing services, and anyone can consume them, directly, with no company in the middle.

The protocol does not care what happens between request and response. It is a neutral transport layer: direct peer-to-peer communication. A request went in, a response came out, both sides confirmed, settlement happened.

### Two Layers. One Protocol.

**Layer 1: Unstoppable Infrastructure.** Open source. Peer-to-peer. Anonymous. Always on. No login. No central point that can be shut down. Discovery via BitTorrent DHT. Transport via WebRTC. The network routes around failures. To block access to any service, you would need to shut down every individual provider who serves it.

**Layer 2: An Open Marketplace for AI Services.** Gasless payments. On-chain stats. Cumulative payment channels. Any provider. Any service. Set your own price. Buyers deposit USDC. Providers settle via cryptographic vouchers. Every settlement is recorded on-chain.

## Three Ways to Provide

All three expose a standard API. What runs behind it is entirely the provider's business.

**Raw Inference.** Serve a model, a fine-tune, a local GPU, an open-weight model on a Mac Mini, or proxy an existing API with added value. Set the price per token. Buyers route based on price, latency, and on-chain reputation. When dozens of sellers offer the same model, margins compress toward zero and the buyer pays near-cost.

**Routing Service.** Build specialized routing logic and offer it on the network. Latency-optimized, cost-minimizing, TEE-only, jurisdiction-aware. Earn on every request routed without running a single model. No model infrastructure required.

**AI Agent.** Wrap domain knowledge as a named, always-on service. System prompt, RAG sources, and toolchain stay private. Buyers pay for the expertise, not just the tokens. The network becomes a directory of specialized AI services: search by capability, sort by reputation, get a result.

## Why Decentralized

Decentralization is not the value proposition. Cheap, reliable, uncensorable AI access is. Decentralization is the mechanism that makes those properties durable.

A centralized aggregator can be pressured by upstream providers, shut down by regulators, acquired by a competitor, or disrupted by business failure. When that happens, every customer is affected by one decision from one company. AntSeed has no company in the middle.

Buyers are anonymous by default. No account, no sign-up, no identity. Just a wallet. Providers can operate anonymously too, though most will choose to build a public reputation. For providers running in Trusted Execution Environments, not even the provider operator can see the prompts. Privacy is a structural property of the architecture, not a policy promise.

## Why Now

**Models commoditized.** Claude, GPT, Gemini, DeepSeek, Llama, converging in capability and racing to zero on price. Open-weight models compete with closed APIs on most tasks. When models become interchangeable, the access layer becomes the competitive battleground.

**Open-source inference is everywhere.** Ollama, vLLM, consumer GPUs, and cloud GPU rentals have made serving open-source models trivial. Every new provider is a potential AntSeed seller.

**Agents are deployed.** Agents are no longer demos. Claude Code, Codex, and hundreds of autonomous workflows are in production, consuming inference programmatically, at scale.

**Payment rails are ready.** USDC on Base is fast, cheap, and widely held. EIP-712 signatures enable gasless authorization. The infrastructure for machine-to-machine payments exists.

**The aggregator model proved demand.** OpenRouter, Together.ai, and others proved developers want multi-model access through a single endpoint. They validated the demand. AntSeed removes the centralized bottleneck.

## How Payments Work

AntSeed uses cumulative payment channels settled on Base. Two contracts handle the money: **AntseedDeposits** (holds funds) and **AntseedChannels** (manages session lifecycle, holds no funds). Channels is swappable — it can be redeployed without touching buyer balances.

### Deposit and Reserve

Buyers deposit USDC into AntseedDeposits. When a buyer wants to use a provider, they sign a **ReserveAuth** — an EIP-712 authorization that binds a channel ID, a maximum amount, and a deadline. The seller submits this signature on-chain, and the Deposits contract locks the authorized amount from the buyer's balance.

First-time sessions are hard-capped at **$1 USDC**. This minimizes risk when neither party has history with the other.

### Cumulative SpendingAuth

During a session, the buyer signs a **SpendingAuth** after each request. Each SpendingAuth contains a cumulative amount — the total USDC authorized so far — and a metadata hash covering token counts and request details. The seller can submit any SpendingAuth to settle the delta since the last on-chain checkpoint. The channel stays open for more requests.

This is a cumulative voucher model: only the latest SpendingAuth matters. If the buyer signs authorizations for $0.05, then $0.12, then $0.18, the seller only needs to submit the $0.18 signature to collect the full amount.

### Close and Refund

The seller calls **close** with the final SpendingAuth. The contract settles the remaining delta to the seller and releases unspent funds back to the buyer's deposit balance.

If the seller disappears, the buyer (via their authorized operator wallet) calls **requestClose**. After a 15-minute grace period — during which the seller can still submit a final SpendingAuth — the buyer calls **withdraw** to reclaim the locked funds.

### Top Up

When a session needs more budget, the seller can **topUp** the channel. This requires at least 85% of the current deposit to be settled (proven via SpendingAuth), plus a new ReserveAuth from the buyer for the higher ceiling. The channel continues without interruption.

### Credit Limits

Deposit balances are subject to credit limits that grow with usage. New buyers start with a $10 limit. Each unique seller interaction adds $5, and each day of history adds $0.50, up to a $50 maximum. This prevents abuse while rewarding active participation.

### On-Chain Stats

Every settlement updates per-agent counters: channel count, ghost count (channels where the seller never delivered), total USDC volume, and last settlement timestamp. These stats are unforgeable — they can only be incremented through actual on-chain state transitions. Routers use these stats to score providers.

### Buyer Safety

The buyer never needs gas. All on-chain actions are either seller-initiated (reserve, settle, close) or operator-initiated (requestClose, withdraw). The buyer's hot wallet only signs EIP-712 messages — it never holds ETH, receives USDC, or submits transactions.

## Who Buys

**Developers and agents seeking better economics.** Multi-model access with lower fees, more sellers competing on price, and access to services centralized platforms do not carry.

**Developers and agents seeking better output.** Specialized providers, improved prompting, domain-specific workflows, capabilities that commodity inference alone cannot deliver.

**Everyday users.** AntStation brings the open market to non-technical users through chat and co-work interfaces, powered by the same P2P network underneath.

**Privacy-sensitive organizations.** Law firms, healthcare, finance, journalists who cannot use cloud AI due to confidentiality. TEE-verified providers open this market. Privacy is enforced by hardware, not policy.

**Users in underserved markets.** Frontier model access at competitive rates where direct API access is limited or payment methods are not accepted.
