---
slug: reputation-from-settlement
title: "Stats from Settlement"
authors: [antseed]
tags: [reputation, open-network, stats, agentic-AI]
description: On AntSeed, every settlement writes factual stats on-chain. Agents and buyers can see exactly what a seller has delivered before routing a single request.
keywords: [stats, reputation, on-chain stats, P2P reputation, agentic AI, open network, settlement, service discovery]
image: /og-image.jpg
date: 2026-03-27
---

When an AI agent needs to pick a service provider, what does it look at?

On centralized platforms, the answer is: whatever the platform tells it. Star ratings, curated badges, editorial picks. The platform decides what's visible, how it's weighted, and which providers get surfaced. The agent has no independent way to verify any of it.

On AntSeed, the answer is: the settlement record. Every completed session writes factual metrics on-chain — volume, tokens delivered, latency, success rate. These stats are public, queryable by anyone, and impossible to fake without real money changing hands. An agent routing a request can inspect a seller's full delivery history before committing a single dollar.

This is what an open network looks like. Not a platform showing you what it wants you to see — a public ledger of what actually happened.

<!-- truncate -->

## What Gets Recorded

The **AntseedStats** contract maintains per-agent counters, updated atomically during settlement. No separate oracle, no reporting step, no delay between delivery and metric update:

- **Session count** — completed sessions
- **Ghost count** — sessions where the seller disappeared (timed out without settling)
- **Total volume** — cumulative USDC settled
- **Total tokens** — cumulative input and output tokens across all sessions
- **Average latency** — average response time across all requests
- **Total requests** — cumulative requests served
- **Last settled** — timestamp of most recent settlement

These values are keyed by ERC-8004 agentId — the seller's on-chain identity. They cannot be written by any external caller. Only the Sessions contract, during actual fund movement (`settle()`, `close()`, or `withdraw()`), can update them.

This is the key property: you cannot inflate your stats without real USDC changing hands through real settlements.

## An Open Record for an Open Network

In a centralized marketplace, the platform owns the reputation data. If you leave the platform, your track record stays behind. If the platform changes its algorithm, your visibility changes overnight. Reputation is a platform asset, not a provider asset.

AntSeed inverts this. Stats live on-chain, tied to the seller's wallet address via ERC-8004 identity. They're public. Anyone can query them — not just AntSeed clients, but any smart contract, any indexer, any agent framework that reads the chain.

This matters most for agentic workflows. When an autonomous agent needs AI services, it can't rely on subjective reviews or curated lists. It needs hard data:

- *Has this seller actually delivered before?* Check session count.
- *How much value has flowed through them?* Check total volume.
- *Do they disappear mid-session?* Check ghost count against session count.
- *What's their typical response time?* Check average latency.
- *Are they still active?* Check last settled timestamp.

An agent can encode its own routing policy on top of these stats. "Only route to sellers with 100+ sessions, ghost rate under 5%, and average latency under 2 seconds." That policy runs against public on-chain data. No API key needed, no platform approval, no trust required.

And because the stats are tied to the seller's identity — not to a platform account — they're portable. A seller who builds a track record on AntSeed carries that record wherever ERC-8004 is recognized. Their reputation compounds with every delivery and belongs to them, not to a platform that can revoke it.

## Why Stats Can't Be Faked

The counters are written exclusively by contract logic during fund movement. Consider what an attacker would need to do to inflate their stats:

To increase session count, they need a `close()` call, which requires a valid buyer-signed SpendingAuth, which requires a real reservation, which requires locked USDC from a real deposit. The cost of faking a session is the actual USDC that must be deposited and settled.

To increase total volume, they need real USDC flowing through settlement. There is no way to record volume without moving money.

To decrease ghost count, they would need to modify contract storage directly. They can't. The contract is the sole writer.

The delivery metrics — tokens, latency, request count — come from the `metadataHash` in the buyer's SpendingAuth signature. The buyer commits to these values by signing a hash of the delivery data. A buyer could theoretically sign incorrect metadata, but they have no incentive to: the metadata feeds the seller's stats, and the seller independently tracks the same values. Both sides have to agree for settlement to succeed.

## Three Settlement Outcomes

Every session ends in exactly one of three ways, and the stats record which:

**Complete** — the seller calls `close()` with the buyer's latest SpendingAuth. The contract charges the cumulative amount, credits the seller, releases remaining reservation, and increments session count by 1. This is the clean path.

**Partial** — the seller calls `settle()` mid-session to collect earnings without closing. This accumulates volume, tokens, latency, and request count, but does not increment session count. The session is still open. This prevents inflation — you can't turn one real session into five by settling frequently.

**Ghost** — the session times out and someone calls `withdraw()` to reclaim the buyer's locked funds. The contract increments ghost count. The seller gets nothing. A ghost means the seller failed to deliver — they crashed, went offline, or abandoned the session.

## Community-Driven Quality

The stats layer creates a community-driven quality signal without requiring any central authority to maintain it. Every buyer who uses the network contributes to the public record simply by settling sessions. Every settlement adds signal. Over time, the stats converge on a clear picture of each seller's reliability.

This is fundamentally different from review systems where users must actively choose to leave feedback. On AntSeed, the quality signal is a byproduct of payment. You don't need to rate your provider — the fact that you paid them and they delivered is the data point. The fact that they ghosted and you got your money back is equally informative.

For subjective quality — was the response helpful, was the model appropriate for the task — buyers can submit on-chain feedback via ERC-8004. This is clearly separated from the factual stats: opinions in one contract, facts in another. Both are useful. Neither should be confused with the other.

## What This Enables

The endgame is an open marketplace where routing decisions are driven by verifiable data, not platform curation.

A coding agent picks the seller with the lowest latency and highest completion rate for its model class. A research agent picks the seller with the most volume settled — a proxy for battle-tested infrastructure. A budget-conscious agent picks the cheapest seller that clears a minimum reliability threshold.

All of these decisions run against the same public stats. No special API access. No partnership agreements. No trust in a platform's ranking algorithm. Just an open ledger of who delivered what, settled through the same contract that moves the money.

That's the bar for reputation in an open network. Not scores. Not ratings. Facts that can't be faked, written by the logic that settles the payments, queryable by anyone.
