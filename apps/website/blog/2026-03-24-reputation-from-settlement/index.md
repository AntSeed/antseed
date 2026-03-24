---
slug: reputation-from-settlement
title: "Reputation from Settlement"
authors: [antseed]
tags: [reputation, mechanism-design, Sybil-resistance, game-theory]
description: How AntSeed derives on-chain reputation directly from payment settlement — no oracles, no validators, no self-reporting.
keywords: [reputation system, Sybil resistance, proof of delivery, mechanism design, DePIN reputation, anti-gaming, staking slashing]
image: /og-image.jpg
date: 2026-03-24
---

# Reputation from Settlement

Most DePIN reputation systems fall into two categories: self-reported metrics (trivially gameable — a node reports its own uptime, latency, and success rate) or validator-based attestations (introduces a trusted third party whose incentives may not align with the network). Both approaches fail at the fundamental thing reputation is supposed to do: distinguish real service delivery from fake activity.

AntSeed takes a different approach. Reputation is not a separate system. It is a side effect of payment settlement.

<!-- truncate -->

## Reputation as a Side Effect

The AntSeed escrow contract maintains per-seller reputation counters: `firstSignCount`, `qualifiedProvenSignCount`, `totalQualifiedTokenVolume`, and `ghostCount`. These counters are updated atomically inside the `reserve()` and `settle()` functions — the same contract calls that handle payment.

There is no separate reputation oracle. There is no reporting step. There is no delay between service delivery and reputation update. When a seller settles a proven session, their reputation counter increments in the same transaction that moves funds. The reputation data is unforgeable because it derives from the proof-of-prior-delivery chain: each proven sign references a prior settlement, creating a cryptographic linkage that cannot be fabricated without actual on-chain payment history.

This eliminates an entire class of attacks. You cannot inflate your reputation without actually settling payments. You cannot backdate reputation. You cannot report metrics that diverge from what the contract recorded. The settlement record *is* the reputation.

## Qualified vs. Unqualified

Not all proven signs are equal. A proven sign accrues reputation only if the buyer meets a diversity threshold: they must have been charged by at least 3 unique sellers in the network.

This is the first and most important anti-gaming layer. Without it, a single attacker could create one buyer address and one seller address, cycle funds between them, and accumulate arbitrary reputation. The diversity requirement means that even if you control the buyer, you need to have paid 3 distinct sellers before your proven signs start counting. Those payments to other sellers are real costs that cannot be recovered.

Unqualified proven signs still settle payment normally. The seller gets paid. The proof chain extends. But the `qualifiedProvenSignCount` counter does not increment, and no emission points are awarded. This means the payment protocol works for everyone from day one, but reputation farming requires genuine network participation.

## Seven Layers of Defense

No single mechanism is sufficient against determined attackers. AntSeed layers seven independent defenses, each targeting a different attack vector.

**Buyer diversity** requires 3 unique sellers before proven signs qualify. This prevents the simplest attack: a single colluding buyer-seller pair cycling funds. The cost to bypass this is real payments to 3 other sellers, which represents genuine economic activity in the network. An attacker controlling multiple seller addresses still needs to stake each one independently.

**Minimum deposit** sets a $10 USDC floor to open an escrow account. This is not a large amount, but it prices out the cheapest form of Sybil attack: creating thousands of zero-cost addresses to manufacture diversity. At $10 per account, creating enough fake buyers to satisfy diversity requirements for a farming operation has a concrete and scaling cost.

**Dynamic credit limits** prevent a new account from dumping large amounts of capital on day one. Credit grows as a function of interaction count, account age, proven session history, and feedback scores. A fresh Sybil account starts with minimal credit regardless of how much USDC backs it. This means that even a well-funded attacker must invest time — not just money — to scale up.

**Inactivity lock** freezes accounts after 90 days without settlement activity. This handles a subtle long-game strategy: creating Sybil accounts during a low-cost period, letting them age to accumulate time-based bonuses, and activating them later. Dormant accounts lose their credit history and must re-establish activity to unlock.

**Cooldown per pair** enforces a 7-day minimum between a buyer-seller pair's first session and their first proven sign. This prevents rapid-fire session farming where an attacker settles hundreds of micro-sessions in a single block to inflate counters. The attacker must maintain the colluding infrastructure across multiple days, increasing operational cost and detection surface.

**Minimum token threshold** ignores sessions below 1,000 tokens. Without this, an attacker could settle millions of near-empty sessions to inflate `qualifiedProvenSignCount` while minimizing actual compute costs. The threshold ensures that each counted session represents meaningful work.

**Stake-proportional cap** bounds effective reputation by economic commitment: `effectiveProvenSigns = min(actualProvenSigns, stake * 20)`. Even if an attacker bypasses every other defense and accumulates thousands of proven signs, their reputation influence is capped by the USDC they have at risk. To achieve high reputation, they must maintain proportionally high stake — which is subject to slashing.

Each layer independently raises the cost of attack. In combination, they create a cost function where the expense of manufacturing fake reputation exceeds the expected return from doing so.

## Staking as Accountability

Sellers stake USDC to accept paid sessions. The stake is not just a routing signal — it is collateral that enforces a minimum standard of real delivery. Slash conditions are evaluated when a seller unstakes:

- **100% slash** if the seller has zero qualified proven signs. This is the harshest penalty and targets pure farming: staking to appear legitimate without ever delivering qualifying service.
- **50% slash** if fewer than 30% of the seller's total proven signs are qualified. This targets a subtler strategy: doing some real work but primarily farming unqualified sessions with controlled buyers.
- **20% slash** if the seller has no proven sign in the last 90 days. This penalizes stale participation — staking to occupy network capacity without active delivery.
- **0% slash** for sellers with a clean record: at least 30% qualified ratio and recent activity.

The slash conditions create a clear economic calculus. If you stake $1,000 and never deliver qualified service, you lose $1,000. This makes reputation farming expensive even if an attacker finds a way to bypass the per-session defenses. The cost of the attack includes not just the operational overhead of maintaining Sybil infrastructure, but the capital at risk from slashing.

Slashed funds go to the protocol reserve, which funds emission. This means that attackers directly subsidize honest participants.

## Emission as Incentive

ANTS token emission is the positive incentive counterpart to slashing. Seller emission points are calculated as:

```
sellerPoints = E(P) * V(P) * feedbackMultiplier
```

Where `E(P)` is a reputation factor derived from qualified proven signs, `V(P)` is the token volume delivered, and `feedbackMultiplier` ranges from 0.5x to 1.5x based on buyer feedback scores.

The distribution uses a Synthetix-style reward-per-point mechanism — O(1) gas per interaction, no epoch batching, no claim transactions. Points convert to ANTS at a rate determined by the total points accumulated across all participants in the period.

Buyers earn points too: for usage (USDC spent in qualified sessions), for submitting feedback (incentivizing the signal that modulates seller emission), and for diversity (transacting with more unique sellers). The split is 65% seller, 25% buyer, 10% protocol reserve.

ANTS tokens are non-transferable until network maturity. This is a deliberate design choice. Transferability before the network has sufficient honest activity would allow early farmers to extract value before the anti-gaming mechanisms have enough data to distinguish real from fake participation. Non-transferability ensures that the only way to benefit from ANTS accumulation is to continue participating in the network.

## The Design Principle

The key insight behind this system is that reputation does not need its own infrastructure. If your payment protocol already proves delivery — if settlement requires cryptographic evidence that service was rendered — then reputation is just the accumulated record of those proofs.

Every additional system you bolt on (oracles, validators, reporting layers, attestation networks) introduces new trust assumptions and new attack surfaces. AntSeed's reputation has exactly the same trust assumptions as its payment protocol: the escrow contract is correct, and the proof-of-prior-delivery chain is valid. No more, no less.

The anti-gaming layers exist not because the core mechanism is weak, but because any system with economic incentives will attract adversarial behavior. Each layer raises the cost of attack along a different dimension — capital, time, operational complexity, diversity of real network participation. The goal is not to make gaming impossible (it never is) but to make it more expensive than honest participation.

That is the bar a reputation system needs to clear. Not perfection. Just a cost function where the honest strategy dominates.
