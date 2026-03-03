---
id: faq
title: Frequently Asked Questions
description: Common questions about AntSeed — the peer-to-peer AI services network. Covers privacy, models, pricing, setup, and how it compares to centralized AI APIs.
sidebar_position: 99
---

# Frequently Asked Questions

## General

### What is AntSeed?

AntSeed is a peer-to-peer network for AI services. It connects buyers who need AI inference with providers who offer it — directly, without a central platform in the middle.

Unlike centralized AI APIs (OpenAI, Anthropic, Google), there is no single company routing your requests, storing your conversations, or controlling which models you can access. The AntSeed protocol handles discovery, routing, reputation scoring, and payment settlement across a decentralized network of peers.

### How is this different from ChatGPT or Claude?

ChatGPT and Claude are centralized products built on top of AI models. AntSeed is open infrastructure — a protocol layer that gives you access to any model on the network, including Claude Sonnet, DeepSeek-R1, Llama 4, Qwen, Kimi, and more.

The key difference: your requests don't go through a single company. They route peer-to-peer to whichever provider best matches your requirements for price, latency, privacy, and capability.

Your existing tools — [Cursor](https://cursor.sh), [Claude Code](https://claude.ai/code), or any OpenAI-compatible client — connect and work immediately without modification.

### Is AntSeed open source?

Yes. The full protocol, CLI, and node implementation are open source on [GitHub](https://github.com/AntSeed/antseed). Anyone can inspect the code, run a node, or build on top of the protocol.

### Who runs the network?

No one. The network is decentralized — it runs on the peers that join it. There is no company operating the routing layer. AntSeed (the team) builds the protocol and tools, but does not operate the network or sit between buyers and providers.

---

## Privacy

### Is my data private?

Privacy on AntSeed works in layers:

**Layer 1 — Network anonymity (everyone gets this by default).** Like a VPN for AI, providers never know who you are. There are no accounts, no identity, and no way to link a request back to you. Your IP is not exposed to the provider you route to.

**Layer 2 — Provider trust.** Standard providers handle your data like any API service. They can see your prompts but have no identity to attach them to.

**Layer 3 — TEE-verified providers.** These run inside Trusted Execution Environments (Intel TDX, AMD SEV) — hardware enclaves where not even the node operator can read your prompts. This is cryptographic proof, not a policy promise. You pay a small premium; in return you get verifiable, hardware-level privacy.

Most users are well-served by Layer 1 alone. Journalists, lawyers, security researchers, and anyone handling sensitive data will want Layer 3.

### Can providers see my prompts?

Standard providers can. TEE-verified providers cannot — the hardware prevents it even if the operator wanted to look. When paying for a TEE-verified request, you receive a cryptographic attestation proving the enclave was genuine.

### Does AntSeed log my requests?

AntSeed the protocol does not log requests. We don't operate the nodes — providers do. Each provider has their own data handling practices. For guaranteed no-logging, route to a TEE-verified provider.

---

## Models & Availability

### What models are available?

Any model a provider offers. The network is open — any provider can list new models. See what's live right now on the [network page](/network).

### Can I use closed-source models like GPT-4?

If a provider offers access to GPT-4 or other closed-source models, you can access them through AntSeed. The protocol is model-agnostic. Availability depends on what providers choose to offer.

### What if a model goes offline?

AntSeed automatically detects provider failures and reroutes to the next best available provider. You never have to manually switch — failover is built into the routing layer.

---

## Setup & Usage

### Do I need to sign up or create an account?

No account required. Install the CLI, run `antseed connect`, and you are live on the network. Any tool that speaks the OpenAI API format works immediately.

### How do I install AntSeed?

```bash
npm install -g antseed
antseed connect
```

That's it. See the [installation guide](/docs/install) for full details.

### Does it work with Cursor, Claude Code, or other AI tools?

Yes. AntSeed is OpenAI API-compatible. Point your tool at the AntSeed endpoint and it works without any other changes — no code modifications needed.

### What operating systems are supported?

macOS (Apple Silicon and Intel), Windows, and Linux. The CLI runs anywhere Node.js runs.

---

## Providers & Economics

### Can I become a provider?

Yes. If you have GPU compute or API access to frontier models, you can offer inference on the network and earn from every request you serve. No permission or partnership required.

See the [provider setup guide](/docs/install) to get started.

### How does pricing work?

Providers set their own prices per million tokens. The routing layer scores all available providers by your preferences (cheapest, fastest, most private, highest reputation) and picks the best match. Prices are visible before routing.

### How do providers get paid?

Payment settlement is handled on-chain through the AntSeed smart contracts. Payments are escrowed per request and released upon verified completion. No invoicing, no monthly billing — automatic settlement per request.

---

## Still have questions?

Join the community on [Telegram](https://t.me/antseedai) or open an issue on [GitHub](https://github.com/AntSeed/antseed).
