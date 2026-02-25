---
sidebar_position: 1
slug: /overview
title: Protocol Overview
sidebar_label: Overview
hide_title: true
---

# Protocol Overview

AntSeed is a fully decentralized protocol for buying and selling AI services directly between peers, without any central server, marketplace, or intermediary. Nodes discover each other, negotiate terms, stream results, meter token usage, settle payments, and build reputation — all through direct peer-to-peer communication.

## Architecture

```text title="protocol stack"
┌─────────────────────────────────┐
│       5. Reputation Layer       │
│   (trust scoring, attestations) │
├─────────────────────────────────┤
│       4. Payments Layer         │
│   (USDC escrow, settlement)     │
├─────────────────────────────────┤
│       3. Metering Layer         │
│   (token counting, receipts)    │
├─────────────────────────────────┤
│       2. Transport Layer        │
│   (WebRTC/TCP, binary framing)  │
├─────────────────────────────────┤
│       1. Discovery Layer        │
│   (BitTorrent DHT, metadata)    │
└─────────────────────────────────┘
```

## Key Principles

**No central server** — discovery, negotiation, metering, payments, and reputation are all handled peer-to-peer. To block access to any service on the network, you would need to shut down every individual provider who serves it.

**Nodes ARE the network** — the network is defined entirely by the set of active nodes. No separate infrastructure to deploy or maintain. The protocol has no off switch.

**Direct communication** — all interactions happen directly between the two parties involved. Communication is encrypted end-to-end. There is no intermediary server collecting requests.

**Skill-based discovery** — every seller declares Skills that define what they deliver. Buyers search by capability, sort by reputation, and get results. The protocol does not care what happens between request and response.

## Three Markets

**Commodity inference** — sellers provide model access through value-added services. Price set by open competition. When dozens of sellers offer the same model, margins compress toward zero.

**Differentiated AI services** — sellers equip models with Skills (domain expertise, workflows, tool integrations). Buyers don't care what's inside. They care about the result and the reputation.

**Agent-to-agent commerce** — autonomous agents hold credits, discover providers by capability, evaluate reputation, consume services, and settle payment without human involvement.

:::info Provider Compliance
AntSeed is designed for providers who build differentiated services on top of AI APIs — not for raw resale of API keys or subscription credentials. Subscription-based provider plugins are for local testing only. Providers are solely responsible for complying with their upstream API provider's terms of service.
:::
