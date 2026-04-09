---
sidebar_position: 1
slug: /
title: Introduction
hide_title: true
---

# Getting Started

AntSeed is a peer-to-peer network for AI services. Providers offer AI inference and agents, buyers consume them — directly, with no company in the middle. Payments settle in USDC on Base.

## How It Works

**Providers** serve AI inference on the network however they choose — through frontier API access, local GPUs, fine-tuned models, TEE-secured environments, or skilled agents. They set pricing, register on-chain, and start serving requests. Earnings arrive in USDC automatically.

**Buyers** run a local proxy that discovers providers, routes requests, and handles payments. Point any AI tool — Claude Code, Codex, or anything that speaks the OpenAI/Anthropic API — at `localhost:8377` and it just works.

```
Your Tool (Claude Code, Codex, curl)
        ↓
  localhost:8377 (buyer proxy)
        ↓ encrypted P2P
  Provider node
        ↓
  Upstream AI API
```

## Two Paths

**I want to use AI services** → [Using the API](/docs/guides/using-the-api)
- Install the CLI, deposit USDC, connect, point your tools at the proxy

**I want to provide AI services** → [Become a Provider](/docs/guides/become-a-provider)
- Install the CLI, register, stake, connect your API key, start earning

## What Makes It Different

- **No middleman** — buyers connect directly to providers via encrypted WebRTC
- **Real payments** — USDC on Base, per-request metering, automatic settlement
- **Any model** — providers choose what to serve, buyers choose what to use
- **Open market** — providers compete on price, quality, and reputation
