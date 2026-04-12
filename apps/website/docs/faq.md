---
id: faq
title: Frequently Asked Questions
description: Common questions about AntSeed — the peer-to-peer AI services network. Covers privacy, models, pricing, setup, and how it compares to centralized AI APIs.
sidebar_position: 99
---

# Frequently Asked Questions

## General

### What is AntSeed?

AntSeed is a peer-to-peer network for AI services. It connects buyers who need AI services with providers who deliver them — specialized inference, domain expertise, autonomous agents. Directly, without a central platform in the middle.

Unlike centralized AI APIs, there is no single company routing your requests, storing your conversations, or controlling what you can access. The AntSeed protocol handles discovery, routing, reputation scoring, and payment settlement across a decentralized network of peers.

### How is this different from centralized AI chat products?

Centralized AI chat products are closed platforms built on top of a single provider's models. AntSeed is open infrastructure — a protocol layer that connects you with providers offering AI services. Not just models — expertise, agents, and specialized workflows.

The key difference: your requests don't go through a single company. They route peer-to-peer to whichever provider best matches your requirements for price, latency, privacy, reputation, and capability.

Your existing tools — [Claude Code](https://claude.ai/code), [Codex](https://github.com/openai/codex), or any OpenAI-compatible client — connect and work immediately without modification.

### Is AntSeed open source?

Yes. The full protocol, CLI, and node implementation are open source on [GitHub](https://github.com/AntSeed/antseed). Anyone can inspect the code, run a node, or build on top of the protocol.

### Who runs the network?

No one. The network is decentralized — it runs on the peers that join it. There is no company operating the routing layer. AntSeed (the team) builds the protocol and tools, but does not operate the network or sit between buyers and providers.

---

## Privacy

### Is my data private?

Privacy on AntSeed works in two layers:

**Layer 1 — Network anonymity (everyone gets this by default).** Requests go peer-to-peer, like a VPN for AI. Providers never know who you are — no accounts, no identity, no IP exposed. Your prompts travel directly to the provider with no corporate server in the middle.

**Layer 2 — TEE-verified providers.** These run inside Trusted Execution Environments (Intel TDX, AMD SEV) — hardware enclaves where not even the node operator can read your prompts. This is cryptographic proof, not a policy promise. TEE provider verification is being rolled out in a future release.

Payments are settled on-chain, so the money trail stays private too.

Most users are well-served by Layer 1 alone. Journalists, lawyers, security researchers, and anyone handling sensitive data will want Layer 2.

### Can providers see my prompts?

Standard providers can. TEE-verified providers cannot — the hardware prevents it even if the operator wanted to look. When paying for a TEE-verified request, you receive a cryptographic attestation proving the enclave was genuine.

### Does AntSeed log my requests?

AntSeed the protocol does not log requests. We don't operate the nodes — providers do. Each provider has their own data handling practices. For guaranteed no-logging, route to a TEE-verified provider.

---

## Services & Availability

### What services are available?

Any service a provider chooses to offer. Specialized inference, domain expertise, autonomous agents, uncensored models. The network is open — availability depends on who's online. See what's live right now on the [network page](/network).

### Can I use closed-source models like GPT-4?

If a provider offers access to GPT-4 or other closed-source models, you can access them through AntSeed. The protocol is model-agnostic. Availability depends on what providers choose to offer.

### What if a service goes offline?

AntSeed automatically detects provider failures and reroutes to the next best specialized service available. You never have to manually switch — failover is built into the routing layer.

---

## Setup & Usage

### Do I need to sign up or create an account?

No account required. Install the CLI, run `antseed buyer start`, and you are live on the network. Any tool that speaks the OpenAI API format works immediately.

### How do I install AntSeed?

```bash
npm install -g @antseed/cli
```

Then start the buyer proxy:

```bash
antseed buyer start --router local
```

See the [installation guide](/docs/install) for full details.

### Does it work with Claude Code, Codex, or other AI tools?

Yes. AntSeed is OpenAI API-compatible. Point your tool at the AntSeed endpoint and it works without any other changes — no code modifications needed.

### What operating systems are supported?

macOS (Apple Silicon and Intel), Windows, and Linux. The CLI runs anywhere Node.js runs.

---

## Providers & Economics

### Can I become a provider?

Yes. The network is open. Wrap your expertise in AI and sell it — video creation, legal analysis, code audits, uncensored inference, autonomous agents. It's your job to pick the models and workflows that deliver the best results. The network only measures delivery quality. No permission or partnership required.

See the [provider setup guide](/docs/guides/become-a-provider) to get started.

### How does pricing work?

Providers set their own prices. The routing layer scores all available providers by your preferences (cheapest, fastest, most private, highest reputation) and picks the best match. Prices are visible before routing.

### How do providers get paid?

Buyers pre-deposit USDC into the on-chain AntseedDeposits contract. Each session is authorized by an EIP-712 ReserveAuth that caps the seller's charge. The seller calls `reserve()` on AntseedChannels to lock funds. During the session, the buyer signs cumulative SpendingAuth messages that authorize spending. The seller calls `close()` with the buyer's latest SpendingAuth to settle and release remaining funds. If the seller disappears, anyone can call `requestTimeout()` after the session deadline passes, then `withdraw()` after a 15-minute grace period to release buyer funds. No invoicing, no monthly billing — automatic settlement per session.

---

## Still have questions?

Join the community on [Telegram](https://t.me/antseed) or open an issue on [GitHub](https://github.com/AntSeed/antseed).
