---
slug: proof-of-prior-delivery
title: "Proof of Prior Delivery"
authors: [antseed]
tags: [protocol, payments, cryptography, mechanism-design]
description: How AntSeed's payment protocol creates an unforgeable chain where each spending authorization simultaneously pays for the current session and proves delivery of the previous one.
keywords: [proof of delivery, EIP-712, payment protocol, P2P payments, DePIN payments, escrow, spending authorization]
image: /og-image.jpg
date: 2026-03-24
---

In peer-to-peer compute markets, proving service delivery is the hard problem. Not routing, not pricing, not discovery — proving that a seller actually delivered what they were paid for, without a trusted intermediary watching the exchange.

Most DePIN projects sidestep this. They use self-reported metrics (trivially gameable), trusted validators (re-introducing the centralization they claim to eliminate), or optimistic assumptions with dispute windows (which require honest majorities and active monitoring). These are reasonable engineering tradeoffs, but they're not proofs. They're social mechanisms dressed up as cryptographic ones.

AntSeed takes a different approach. The payment protocol produces unforgeable delivery proofs as a natural byproduct of continued usage. No validators, no oracles, no dispute games. If a buyer keeps paying a seller, the chain of payments *is* the proof of delivery.

<!-- truncate -->

## The Core Mechanism

The primitive is the **SpendingAuth** — an EIP-712 typed data signature that the buyer sends to the seller before each session. It contains the usual fields you'd expect: seller address, session ID, max amount, nonce, deadline. But it also contains two fields that change everything:

- `previousConsumption` — the actual USDC consumed in the prior session
- `previousSessionId` — the session ID being attested to

When a buyer signs `previousConsumption = 15420` (15,420 USDC atomic units, i.e., $0.015420), they are cryptographically attesting that the seller delivered 15,420 units worth of service in the previous session. This signature is verified on-chain when the seller calls `reserve()` on the escrow contract.

The SpendingAuth is simultaneously a payment authorization *and* a delivery receipt. One signature, two functions. The buyer can't authorize a new session without settling the previous one, and settling the previous one requires attesting to what was delivered.

## How the Chain Builds

Walk through three sessions between a buyer and seller:

**Session 1** — The buyer has never transacted with this seller. They sign a SpendingAuth with `previousSessionId = 0x0` and `previousConsumption = 0`. The contract recognizes this as a First Sign — no prior delivery to reference — and hard-caps the reservation at `FIRST_SIGN_CAP` ($1 USDC). This limits the buyer's exposure to an unproven seller. The seller calls `reserve()`, $1 is locked from the buyer's deposit, and requests flow.

During the session, the buyer sends 12 requests. The seller processes them, consuming 8,340 tokens at the seller's published rate, costing $0.004170 USDC. Each request produces a bilateral receipt: the seller signs a SellerReceipt (including a SHA-256 hash of the response), the buyer signs a BuyerAck. These receipts are exchanged peer-to-peer and stored locally.

**Session 2** — The buyer returns. They sign a new SpendingAuth with `previousSessionId = session1.id` and `previousConsumption = 4170` (the $0.004170 converted to USDC atomic units). The seller submits this to `reserve()`. The contract:

1. Looks up session 1's reservation
2. Verifies the buyer's ECDSA signature over the `previousConsumption` claim
3. Transfers 4,170 units to the seller
4. Returns the remaining locked amount ($1.00 - $0.004170) to the buyer's deposit
5. Locks the new `maxAmount` for session 2

Because the buyer proved delivery of session 1, this is now a **Proven Sign**. The `FIRST_SIGN_CAP` no longer applies. The buyer can authorize up to their full deposit balance.

**Session 3, 4, ... N** — Each subsequent SpendingAuth settles session N-1 and authorizes session N. The chain extends indefinitely. Every link contains the buyer's signed attestation of what the seller delivered in the previous session, verified on-chain.

## Why the Chain Is Unforgeable

Four properties make this chain resistant to manipulation:

**Only the buyer can sign.** The SpendingAuth is an ECDSA signature over EIP-712 typed data, bound to the buyer's EVM address. The seller cannot forge a delivery attestation. The buyer must voluntarily sign over `previousConsumption` to continue using the seller's services.

**On-chain session reference validation.** The contract verifies that `previousSessionId` matches an active reservation for this buyer-seller pair. You can't reference a session that doesn't exist or has already been settled. The chain is append-only.

**Buyer can't overstate consumption.** If a buyer signs `previousConsumption = 50000` when only 4170 was consumed, they're overpaying. The excess goes to the seller. Buyers have no incentive to overstate — it costs them money.

**Buyer can't significantly understate consumption.** Sellers track consumption through bilateral receipts during the serve phase. If a buyer's `previousConsumption` is more than 20% below the seller's recorded total, the seller rejects the SpendingAuth and refuses to start a new session. The buyer's only recourse is to sign a more accurate attestation or find a different seller. Under-reporting is self-limiting because the seller controls session admission.

The net result: the only stable strategy for a buyer who wants continued service is to accurately report what was consumed. And that accurate report, signed and verified on-chain, is the delivery proof.

## Bilateral Receipts: The Audit Trail

The SpendingAuth chain handles settlement. But during the serve phase, a finer-grained audit trail is constructed through bilateral receipts.

After each request, the seller signs a **SellerReceipt** with their Ed25519 identity key. The receipt contains the session ID, a sequential request index, the running total cost, token counts, and critically, a SHA-256 hash of the response payload. This binds the receipt to specific delivered content — the seller can't claim to have delivered a response without committing to its exact contents.

The buyer then signs a **BuyerAck** over the SellerReceipt, confirming they received the response matching that hash. This creates a bilateral record: the seller attests to what they sent, the buyer attests to what they received.

These receipts are exchanged peer-to-peer and never submitted on-chain during normal operation. They serve two purposes: they give the seller the running total needed to evaluate the buyer's `previousConsumption` claim in the next SpendingAuth, and they provide evidence for dispute resolution if the two parties disagree on consumption.

The division of labor is intentional. Receipts are the raw data. The SpendingAuth chain is the settlement proof. Putting per-request receipts on-chain would be prohibitively expensive and unnecessary — the buyer's aggregate attestation in the SpendingAuth is sufficient for settlement, and receipts exist as backup evidence.

## Lazy Settlement

There is no explicit "settle" transaction in the normal flow. Settlement is a side effect of `reserve()`.

When the seller calls `reserve()` with a new SpendingAuth, the contract atomically settles the previous session and locks funds for the new one. The seller gets paid for session N as a natural consequence of starting session N+1. No additional transaction, no additional gas.

This design has a meaningful property: the cost of settlement is amortized into the cost of continued operation. A buyer who uses a seller for 100 sessions triggers 100 settlements, but each one is bundled into the `reserve()` call that was going to happen anyway. The marginal gas cost of settlement is near zero.

The edge case is a buyer who never returns. If 24 hours pass without a new SpendingAuth, the seller (or anyone) can call `settleTimeout()`. This refunds the full locked amount to the buyer's deposit and records a ghost mark on the seller's on-chain record.

Why a full refund? Because the seller cannot unilaterally prove delivery. Only the buyer's signed SpendingAuth can attest to consumption, and the buyer hasn't provided one. The protocol's position is explicit: if you can't prove it, you don't get paid. Ghost marks are visible in reputation data — a seller with many ghost marks is one whose buyers tend not to return, which is meaningful signal regardless of the underlying cause.

In practice, timeout settlement is rare. Buyers who received good service return (they need the service). Buyers who received poor service don't, and the seller eats the gas cost of the reservation without earning anything. The incentives align: sellers are motivated to deliver quality because their payment depends on the buyer's voluntary return.

## What This Enables

The proof chain creates two properties that are hard to achieve in P2P markets:

**Verifiable reputation from settlement data.** Every `reserve()` call that settles a previous session updates on-chain counters atomically — total sessions, total volume, per-pair history. These counters can't be inflated without real USDC changing hands. A seller's reputation is backed by actual economic activity, not self-reported metrics. (We'll cover the reputation system in detail in a future post.)

**Trust bootstrapping without oracles.** A new seller starts with First Sign caps, proves delivery through buyer attestations, and builds uncapped trust — all without any third party vouching for them. The proof is in the payment chain itself. A buyer who has proven deliveries with three or more distinct sellers reaches Qualified Proven Sign status, which carries additional reputation weight and signals genuine network participation rather than a sybil pair trading with itself.

The mechanism is simple in retrospect: make the buyer's next payment contingent on attesting to the seller's previous delivery. The buyer can't pay without proving, and the proof is a standard ECDSA signature verified by a standard smart contract. No new cryptographic assumptions, no trusted hardware, no validator set. Just signatures, escrow, and aligned incentives.

[Read the full payment protocol specification](/docs/payments)
