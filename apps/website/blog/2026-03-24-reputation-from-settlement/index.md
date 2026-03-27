---
slug: reputation-from-settlement
title: "Stats from Settlement"
authors: [antseed]
tags: [reputation, mechanism-design, Sybil-resistance, game-theory]
description: How AntSeed derives on-chain stats directly from payment settlement — factual metrics, not subjective scores. No oracles, no validators, no self-reporting.
keywords: [stats, reputation, Sybil resistance, settlement, mechanism design, P2P reputation, anti-gaming, staking slashing]
image: /og-image.jpg
date: 2026-03-24
---

Reputation in decentralized networks typically falls into two categories: self-reported metrics (trivially gameable — a node reports its own uptime, latency, and success rate) or validator-based attestations (introduces a trusted third party whose incentives may not align with the network). Both approaches fail at the fundamental thing reputation is supposed to do: distinguish real service delivery from fake activity.

AntSeed takes a different approach. There is no reputation system. There are **stats** — factual metrics derived from payment settlement, written by the contract itself. You cannot self-report. You cannot inflate. The settlement record *is* the data.

<!-- truncate -->

## Stats, Not Reputation

The word "reputation" implies subjectivity — ratings, scores, weighted opinions. AntSeed's on-chain record is none of these. The **AntseedStats** contract maintains per-agent counters that are updated atomically during settlement. No separate oracle. No reporting step. No delay between service delivery and metric update.

The counters are:

- `sessionCount` — completed sessions
- `ghostCount` — sessions where the seller disappeared (timed out)
- `totalVolumeUsdc` — cumulative USDC settled
- `totalInputTokens` — cumulative input tokens across all sessions
- `totalOutputTokens` — cumulative output tokens across all sessions
- `totalLatencyMs` — cumulative latency across all requests
- `totalRequestCount` — cumulative requests served
- `lastSettledAt` — timestamp of most recent settlement

These values are keyed by ERC-8004 agentId. They cannot be written by any external caller. Only the Sessions contract — during `settle()`, `close()`, or `withdraw()` — can update them. This eliminates an entire class of attacks: you cannot inflate your stats without actual USDC changing hands through real settlements.

## Three Update Paths

The stats system has three distinct update paths, each triggered by a different settlement outcome. The distinction matters because it determines what "one session" means in the on-chain record.

**`close()` — updateType 0 (complete).** The seller calls `close()` with the buyer's latest MetadataAuth to finalize a session. The contract charges the cumulative amount, credits the seller, releases remaining reservation, and updates stats. Critically, this **increments sessionCount by 1**. One completed session equals one count. This is the clean path — both parties fulfilled their obligations.

**`settle()` — updateType 2 (partial).** The seller calls `settle()` mid-session to collect earnings so far without closing the session. This accumulates volume, tokens, latency, and request count into the stats, but **does not increment sessionCount**. Why? Because the session is still open. If a seller settles 5 times during a long session and then closes it, that's 5 partial settlements and 1 session count. This prevents artificial inflation — you can't turn one real session into five by settling frequently.

**`withdraw()` — updateType 1 (ghost).** When a session times out and the buyer (or anyone) calls `withdraw()` to reclaim locked funds, the contract **increments ghostCount**. The seller gets nothing. The buyer gets their full reservation back. A ghost means the seller failed to settle before the deadline — they either crashed, went offline, or abandoned the session.

The three paths are exhaustive. Every session ends in exactly one of these outcomes. The stats record which one it was.

## Why Stats Can't Be Faked

The counters have a critical property: they are written exclusively by contract logic during fund movement. Consider what an attacker would need to do to inflate their stats:

To increase `sessionCount`, they need a `close()` call, which requires a valid buyer-signed MetadataAuth, which requires a real reservation, which requires locked USDC from a real deposit. The cost of inflating session count is the gas cost plus the actual USDC that must be deposited and reserved.

To increase `totalVolumeUsdc`, they need real USDC flowing through settlement. There is no way to record volume without moving money.

To decrease `ghostCount`, they would need to modify contract storage. They can't. The contract is the sole writer.

The metadata values — tokens, latency, request count — come from the `metadataHash` in the buyer's MetadataAuth signature. The buyer commits to these values by signing `keccak256(inputTokens, outputTokens, latencyMs, requestCount)`. The contract unpacks and accumulates them. A buyer could theoretically sign incorrect metadata, but they have no incentive to: the metadata feeds their own stats record, and the seller independently tracks the same values.

## Slashing Reads Stats

Seller staking is the economic commitment that backs service delivery. When a seller unstakes, the contract reads their stats to determine whether slashing applies. Four tiers:

**100% slash** — the seller has only ghost sessions (`sessionCount == 0` and `ghostCount > 0`). This is the harshest penalty. It targets pure ghosts: sellers who staked, accepted reservations, and never delivered. Every dollar of their stake is forfeit.

**50% slash** — high ghost ratio. The seller completed some sessions but ghosted on a disproportionate number. This targets unreliable sellers who deliver inconsistently — perhaps running unstable infrastructure or accepting more sessions than they can handle.

**20% slash** — inactivity. The seller has a clean record but hasn't settled recently (`lastSettledAt` is stale). This penalizes passive staking — occupying network capacity and appearing in routing tables without actively serving. If you're staked, you should be delivering.

**0% slash** — clean record with recent activity. The seller completed sessions, maintained a low ghost ratio, and settled recently. Full stake returned.

The slashing tiers create a clear economic calculus. A seller who stakes $1,000 and ghosts on every session loses $1,000. A seller who delivers reliably gets their full stake back. The stats are the evidence, and the contract is the judge.

## ERC-8004 Feedback: The Subjective Layer

Stats are factual. But some things can't be measured by a contract: was the response helpful? Was the model appropriate for the task? Did the seller's custom system prompt add value?

This is where ERC-8004 feedback comes in. Buyers can submit on-chain feedback — ratings and comments — tied to the seller's agentId. This feedback is subjective and clearly separated from the factual stats. It's recorded on the AntseedIdentity contract (which implements ERC-8004), not on AntseedStats.

The separation is intentional. Stats tell you "this seller completed 847 sessions, settled $12,340 USDC, served 2.1M tokens, with 3 ghosts." Feedback tells you "responses were fast but occasionally off-topic." Both are useful. Neither should be confused with the other.

Feedback influences ANTS token emissions as a multiplier on the seller's volume-based points. Good feedback amplifies earnings; poor feedback dampens them. This creates an incentive for sellers to optimize not just for throughput (which stats capture) but for quality (which only buyers can judge).

## USDC Volume-Based Emissions

ANTS token emission ties directly to stats. Both buyers and sellers accrue emission points based on USDC volume flowing through settled sessions.

Sellers earn points proportional to the volume they settle. This means a seller who processes $100 in real, settled payments earns more than one who processes $10. The stats — specifically `totalVolumeUsdc` — are the input to the emission calculation. Since volume can only increase through real settlements, emission farming requires real economic activity.

Buyers earn points for spending. USDC deposited and settled through sessions accrues buyer-side emission points. This incentivizes genuine usage rather than parking funds in the deposit contract.

The feedback multiplier modulates seller emissions: strong feedback increases the emission rate, weak feedback decreases it. This creates a feedback loop where the most valuable sellers (high volume, good reviews) earn the most ANTS, which aligns token distribution with actual network contribution.

## The Design Principle

The key insight is that stats don't need their own infrastructure. If your payment protocol already settles through a smart contract — if every session ends with a verifiable on-chain outcome — then the accumulated record of those outcomes is the only metric you need.

Three numbers tell you almost everything about a seller: `sessionCount` (how much they've delivered), `ghostCount` (how often they've failed), and `totalVolumeUsdc` (how much economic value they've handled). These numbers are written by the contract during fund movement. They can't be inflated without real money. They can't be deflated without real failures.

Subjective quality lives in a separate layer (ERC-8004 feedback) where it belongs — clearly labeled as opinion, not confused with fact.

That is the bar an on-chain metrics system needs to clear. Not omniscience. Just facts that can't be faked, written by the same logic that moves the money.
