---
slug: proof-of-prior-delivery
title: "Cumulative SpendingAuth: One Signature, Two Jobs"
authors: [antseed]
tags: [protocol, payments, cryptography, mechanism-design]
description: How AntSeed's cumulative SpendingAuth model lets the buyer authorize payment and attest to delivery in a single signature per request — no oracles, no validators, no dispute games.
keywords: [SpendingAuth, EIP-712, payment protocol, P2P payments, deposits, spending authorization, cumulative voucher]
image: /og-image.jpg
date: 2026-03-24
---

In peer-to-peer compute markets, proving service delivery is the hard problem. Not routing, not pricing, not discovery — proving that a seller actually delivered what they were paid for, without a trusted intermediary watching the exchange.

Most decentralized compute projects sidestep this. They use self-reported metrics (trivially gameable), trusted validators (re-introducing the centralization they claim to eliminate), or optimistic assumptions with dispute windows (which require honest majorities and active monitoring). These are reasonable engineering tradeoffs, but they're not proofs. They're social mechanisms dressed up as cryptographic ones.

AntSeed takes a different approach. Every request produces a cumulative **SpendingAuth** — a single EIP-712 signature from the buyer that simultaneously authorizes payment and attests to what was delivered. No validators, no oracles, no dispute games. The buyer's own signature is the proof.

<!-- truncate -->

## The Problem

Consider a streaming payment channel between a buyer and a seller. The buyer sends requests, the seller processes them. At some point the seller wants to get paid. How does the smart contract know what was delivered?

The naive answer is to put every request on-chain. Prohibitively expensive. The next answer is to trust the seller's claim. Obviously broken — sellers would overcharge. The answer after that is a validator network that monitors exchanges. Now you've rebuilt the centralized intermediary you were trying to eliminate.

The real question is: who already knows what was delivered? Both the buyer and the seller. And the buyer is the one paying. If the buyer signs off on what they consumed, that signature is simultaneously a delivery attestation and a payment authorization. One signature, two jobs.

## Cumulative SpendingAuth

The primitive is the **SpendingAuth** — an EIP-712 typed data signature that the buyer produces after every request. It contains three fields:

- `channelId` — the session identifier
- `cumulativeAmount` — total USDC authorized so far across all requests in this session
- `metadataHash` — `keccak256(inputTokens, outputTokens, latencyMs, requestCount)`

The amount is cumulative. After request 1 costs $0.003, the buyer signs `cumulativeAmount = 3000`. After request 2 costs another $0.005, the buyer signs `cumulativeAmount = 8000`. Each signature supersedes the previous one. The seller only needs the latest signature to claim everything owed.

The `metadataHash` is what makes this a delivery attestation, not just a payment voucher. By signing over `keccak256(inputTokens, outputTokens, latencyMs, requestCount)`, the buyer is cryptographically committing to what they observed: how many tokens went in, how many came out, how fast the response was, and how many requests were served. This metadata flows into the on-chain stats system at settlement, creating a factual record that neither party can unilaterally fabricate.

## Session Lifecycle

Walk through a full session:

**Reserve.** The buyer signs a **ReserveAuth** — `(channelId, maxAmount, deadline)` — binding the escrow terms. The seller submits this to `Sessions.reserve()`, which calls `Deposits.lockForSession()` to lock USDC from the buyer's deposit. The USDC never leaves the Deposits contract; Sessions holds nothing. A first-time buyer-seller pair is hard-capped at `FIRST_SIGN_CAP` ($1 USDC), limiting exposure to an unproven seller.

**Serve.** Requests flow. After each one, the buyer computes the cumulative cost, hashes the observed metadata, and signs a SpendingAuth. The seller stores the latest signature. Each new signature makes the previous one obsolete — the seller always holds a single, latest authorization covering all work done so far.

**Settle.** At any point, the seller can call `settle()` with the latest SpendingAuth. The contract verifies the buyer's signature, charges the cumulative amount from the locked deposit, credits the seller's earnings, and updates on-chain stats with the metadata. The session remains open for more requests. Or the seller can call `close()` to settle and release the remaining reservation in one step.

There is no separate "claim" step. There is no dispute window. The buyer already signed off on the amount. The contract just executes.

## Why the Buyer Can't Lie

If the buyer understates consumption — signing `cumulativeAmount = 1000` when the seller tracked $0.005 of real usage — the seller simply refuses to serve the next request. The buyer needs the service, so their incentive is to sign accurately. Understating is self-defeating.

If the buyer overstates consumption, they're overpaying. No buyer has an incentive to do this.

The metadata hash adds a second dimension. The buyer attests to input tokens, output tokens, latency, and request count. These values feed into on-chain stats. A buyer who lies about metadata is corrupting their own on-chain record. Since stats influence routing and emissions, there is no benefit to the buyer in fabricating this data — and the seller independently tracks the same values, so discrepancies are immediately detectable off-chain.

## Why the Seller Can't Lie

The seller computes the cost of each request and reports it to the buyer. What stops a seller from claiming a request cost $0.10 when it really cost $0.01?

The buyer independently estimates cost. Both parties know the model, the token counts, and the seller's published rate. If the seller's claimed cost exceeds 2x the buyer's own estimate, the buyer caps the SpendingAuth at their estimate. The seller can overcharge by small amounts (within the 2x bound), but doing so consistently will cause buyers to choose cheaper sellers. Market pressure enforces honest pricing.

This is a meaningful design property: no on-chain oracle is needed to verify pricing. The buyer's independent cost verification, combined with the ability to cap their own signature, creates a bilateral check that works without any third party.

## Budget Auto-Renewal

Sessions have budgets. When the cumulative amount approaches the reserved maximum, the seller calls `settle()` to collect what's owed, then returns HTTP 402 to the buyer. The buyer's client automatically negotiates a new session — signing a fresh ReserveAuth, reserving new funds, and continuing seamlessly.

From the user's perspective, this is invisible. From the protocol's perspective, it creates natural settlement checkpoints. Long-running interactions settle periodically rather than accumulating unbounded liability. Each settlement commits metadata to the chain, building the on-chain record incrementally.

The `FIRST_SIGN_CAP` of $1 means the buyer's initial risk is trivially small. After the first session settles successfully, subsequent sessions can reserve up to the buyer's full deposit balance. Trust scales with demonstrated delivery, not with upfront commitment.

## Timeout Protection

If the seller disappears mid-session — crashes, goes offline, stops responding — the buyer's funds are locked in a reservation with no one to settle it. The protocol handles this with two permissionless functions:

`requestTimeout()` can be called by anyone after the session's deadline passes. It marks the session as timed out. After a 15-minute grace period, `withdraw()` releases the locked funds back to the buyer's deposit and records a ghost mark on the seller's stats.

Why the grace period? To prevent race conditions where a seller is in the process of settling when someone triggers timeout. The 15 minutes gives the seller time to land their `settle()` transaction. After that, the funds return to the buyer unconditionally.

Why a full refund? Because the seller cannot unilaterally prove delivery. Only the buyer's signed SpendingAuth can authorize charges. If the seller had a recent SpendingAuth, they should have settled before the deadline. If they didn't, the protocol's position is explicit: if you can't prove it, you don't get paid.

## The Design Principle

The cumulative SpendingAuth model reduces the payment-and-attestation problem to a single primitive: a buyer signature over running totals. Each signature makes the previous one obsolete. The seller holds exactly one signature at any time. Settlement is a single contract call with that one signature.

No proof chains. No bilateral receipt exchanges. No per-request on-chain activity. Just a cumulative counter, a metadata hash, and a signature. The buyer can't pay without attesting, and the attestation is a standard ECDSA signature verified by a standard smart contract.

The simplicity is the point. Every additional mechanism — oracles, validators, dispute games, receipt chains — introduces new trust assumptions and new attack surfaces. The cumulative SpendingAuth has exactly one trust assumption: the buyer will sign honestly because doing otherwise is either self-defeating (understating) or self-harming (overstating). That turns out to be enough.

[Read the full payment protocol specification](/docs/payments)
