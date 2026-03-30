---
sidebar_position: 1
slug: /intro
title: Introduction
hide_title: true
---

# Getting Started

AntSeed is a communication protocol for peer-to-peer AI services. Anyone can provide AI services — from model inference to skilled agents and agentic workflows — and anyone can consume them, directly, with no company in the middle.

The protocol serves three markets that build on each other:

**Commodity inference** — providers compete on price to serve the same models. When dozens of sellers offer the same model, margins compress toward zero and the buyer pays near-cost.

**Skilled inference** — providers equip their models with Skills and compete on outcomes and reputation for specialized capabilities. The network becomes a directory of AI services searchable by capability.

**Agent-to-agent commerce** — autonomous agents discover, evaluate, and pay for AI services without human involvement. An agent queries the network for a specific capability, evaluates reputation, sends a request, and pays for the result.

## Node Roles

Every node operates as a `Seller` (provides AI services), a `Buyer` (consumes AI services), or both simultaneously.

Sellers announce available Skills, models, pricing, and capacity. Buyers discover sellers, select peers based on price, latency, capacity and reputation, then send requests and verify metered usage.

## Skills

Every seller on the network declares at least one Skill — a modular package of instructions and expertise that defines what they deliver. Skills are what buyers search for, what reputation accrues to, and what agents understand how to discover and evaluate.

The protocol does not care what happens between request and response. A seller might be proxying through their own frontier model API access, running an open model on a GPU in their garage, or operating a multi-step agent with internet access and tool integrations. To the protocol, these are all the same: a request went in, a response came out, both confirmed, peer to peer, settlement happened.

## Provider Compliance

AntSeed is designed for providers who add value on top of AI APIs — not for raw resale of API keys or subscription credentials. Providers should build differentiated services: TEE-secured inference, domain-specific skills, agent workflows, fine-tuned models, or managed product experiences. Subscription-based provider plugins (e.g., `provider-claude-code`) are for local testing only. Providers are responsible for complying with their upstream API provider's terms of service.

## Protocol Layers

The protocol is organized into five layers: Discovery (DHT-based peer finding), Transport (WebRTC/TCP binary framing), Metering (token estimation and receipts), Payments (USDC deposit and session settlement), and Reputation (trust scoring).
