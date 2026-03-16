# Master Plan: Proof of Prior Delivery

**Status:** PRDS_GENERATED
**PRDs Generated:** 2026-03-16T11:00Z
**Created:** 2026-03-16
**Feature:** End-to-end payment, proof, reputation, and emission system for the AntSeed P2P AI compute network.

---

## Overview

AntSeed is a peer-to-peer AI compute network. Providers (peers/sellers) deliver inference, agents, fine-tuned models, and managed services. Buyers route requests to the best available peer. This master plan covers the full payment and verification protocol — from smart contracts through SDK integration to CLI tooling.

The core primitive is **Proof of Prior Delivery**: each new `SpendingAuth` carries `previousConsumption` (tokens delivered in the last session) and `previousSessionId`, forming a chain where the buyer's signature on session N simultaneously authorizes payment for session N **and** proves delivery of session N-1. Payment and proof are a single act.

### Goals

1. **Trustless payments** — buyers and sellers transact without intermediaries. Credits are locked in escrow; neither party can unilaterally seize funds.
2. **Proof of real work** — reputation accrues only from cryptographically proven delivery chains. No self-certification.
3. **Anti-gaming by design** — six independent defence layers make wash trading economically irrational at every scale.
4. **Dual currency readiness** — USDC payments from day one. ANTS token minted through verified work emissions. Interface prepared for future ANTS-denominated payments.
5. **Automatic for participants** — the SDK handles auth, receipts, settlement, and proof chain continuation behind the scenes. Peers and buyers configure once, then forget.
6. **Open source quality** — clean interfaces, comprehensive tests, clear documentation. Every contract versioned (v1, v2, v3) rather than upgradeable proxies.

### Non-Goals (Out of Scope)

- ANTS-denominated payments (interface prepared, not activated)
- Price oracle integration (deferred until ANTS trading begins)
- TEE attestation or zkML validation (future validation registry extension)
- Cross-chain bridging
- Dashboard UI for payments (separate effort)
- Upgradeable proxy patterns (we version contracts instead)

---

## Architectural Decisions

### AD-1: Versioned contracts, not upgradeable proxies

All contracts are immutable once deployed. When changes are needed, deploy a new version and migrate state. This eliminates proxy admin key risk and keeps the trust model simple. Each contract version is a standalone deployment.

### AD-2: Soulbound peer identity

Peer identity NFTs (AntseedIdentity) are non-transferable. Reputation cannot be sold. A peer who wants to exit unstakes and burns their identity. This prevents reputation farming followed by account sale.

### AD-3: Settlement triggered by next auth

The seller does not call `settle()` on disconnect. Instead, settlement happens when the buyer signs the NEXT `SpendingAuth` — the `previousConsumption` field in the new auth IS the settlement amount for the prior session. The seller calls `settle(previousSessionId, previousConsumption)` atomically with `reserve(newSessionId, ...)`. If the buyer never returns within 24h, the seller calls `settleTimeout()` which returns credits to the buyer in full and records a ghost event.

### AD-4: Separate subscription pool contract

The subscription pool is a separate contract from the escrow. It manages monthly fees, daily token budgets, and revenue distribution. This allows the subscription model to evolve independently (deploy new version) without affecting the core escrow/proof system.

### AD-5: USDC-only with ANTS-ready interface

All payment functions accept a `token` address parameter. For v1, only USDC is accepted (validated on-chain). When ANTS payments are activated in the future, the same interface works without contract changes — just allowlist the ANTS token address.

### AD-6: Persistent session storage

Session state (proof chain links, token counts, receipt history) is persisted to SQLite in the node SDK. This ensures proof chains survive node restarts, which is critical for the 24h timeout window and for buyers who reconnect hours later.

### AD-7: All constants configurable

Every protocol constant (timeout durations, minimum thresholds, fee rates, cap coefficients) is configurable by the contract owner. No hardcoded magic numbers. This gives full control during the early network phase while maintaining on-chain transparency.

### AD-8: Four-contract architecture

```
AntseedIdentity   ── peer registration, soulbound NFT, reputation storage
AntseedEscrow     ── Reserve→Settle, proof chain, staking, slashing, anti-gaming
AntseedSubPool    ── subscription management, daily budgets, revenue distribution
AntseedEmissions  ── epoch-based ANTS minting, proven product distribution
ANTS (ERC-20)     ── simple token, mint authority restricted to AntseedEmissions
```

Contracts reference each other by address (set at deployment, updateable by owner). No inheritance between contracts — only interface calls.

### AD-10: Secure key management and guided onboarding

The Ed25519 identity file is the master key — it derives the EVM wallet that controls stake, earnings, and reputation. Security measures:
- Identity file created with 0600 permissions (owner-only)
- Optional passphrase encryption at rest (AES-256-GCM with scrypt)
- Backup warning on first creation
- Readiness checks on node startup — clear messages telling operators exactly what to do

Provider onboarding is guided via `antseed setup`: checks gas balance → registers identity → stakes USDC → sets token rate. Each step validates prerequisites and provides exact commands to fix issues. Buyers get a similar flow: check gas → deposit USDC → ready to connect.

### AD-11: No stake = no charging

A registered but unstaked peer exists on-chain (discoverable, has identity NFT) but cannot accept any paid sessions. `reserve()` reverts when the seller has zero stake. This prevents sybil peers from opening many identities to farm $1 first-sign sessions without skin in the game.

### AD-12: Dynamic buyer credit limits

Buyer balance caps grow organically with real network participation. A new buyer starts at a low limit ($10) and earns higher limits through proven usage. Prevents large deposits from unproven accounts while rewarding active participants.

```
buyerCreditLimit(B) = min(
  BASE_CREDIT_LIMIT
  + PEER_INTERACTION_BONUS × uniqueSellersCharged(B)
  + TIME_BONUS × daysSinceFirstSession(B)
  + PROVEN_SESSION_BONUS × provenBuyCount(B)
  + FEEDBACK_BONUS × feedbacksSubmitted(B),
  MAX_CREDIT_LIMIT
)
```

All factors configurable. Owner can override individual buyer limits via `setCreditLimitOverride(address, uint256)`. The `deposit()` function enforces `balance + amount <= buyerCreditLimit(msg.sender)`.

### AD-9: Dual reputation model — custom proof chain + ERC-8004 feedback

Peer reputation has two layers, each doing what it does best:

1. **Custom on-chain reputation** — `qualifiedProvenSignCount`, `firstSignCount`, `ghostCount`, `totalQualifiedTokenVolume`, `lastProvenAt`. Updated atomically by AntseedEscrow during `reserve()` and `settle()`. Drives slashing conditions and emission distribution. Cryptographically proven, not self-reported.

2. **ERC-8004 Reputation Registry** — generic feedback signals from buyers. Quality scores, response quality flags, service reviews. Implements the standard `giveFeedback()` / `getSummary()` interface. Drives trust score routing prioritization. Gives ERC-8004 interoperability — external tools and dashboards can query peer quality through the standard interface.

Both coexist in AntseedIdentity. On-chain trust score combines them:
```
onChainTrustScore(P) = w1 · provenDeliveryRate(P)   ← custom reputation (proof chain)
                     + w2 · qualityScore(P)           ← ERC-8004 feedback signals
```

Off-chain metrics (uptime, latency, flag rate) remain in the node's local trust score calculation as they are today — they inform routing but are not part of the contract system.

---

## Session Lifecycle (Reserve → Serve → Settle)

```
BUYER                              SELLER                           ON-CHAIN
  │                                  │                                │
  │ ─ SpendingAuth ────────────────► │                                │
  │   {previousConsumption: 0,       │                                │
  │    previousSessionId: ∅,         │ ── reserve(s1) ──────────────►│
  │    maxAmount: $1}                │    first sign, $1 cap          │ ← credits locked
  │                                  │                                │
  │ ◄── AuthAck ─────────────────── │                                │
  │                                  │                                │
  │ ══ SERVE ═══════════════════════ │                                │
  │   requests flow                  │   tokens accumulate            │
  │   ◄── SellerReceipt (per req) ── │   running total + hash         │
  │   ── BuyerAck ──────────────── ►│   bilateral proof              │
  │                                  │                                │
  │ ── [disconnect] ────────────── ►│                                │
  │                                  │   (waits up to 24h)            │
  │                                  │                                │
  │ ─ SpendingAuth ────────────────►│                                │
  │   {previousConsumption: 15420,   │ ── settle(s1, 15420 tokens) ─►│ ← charges actual
  │    previousSessionId: s1,        │ ── reserve(s2) ──────────────►│ ← new lock
  │    maxAmount: $8}                │    proven sign, full cap       │
  │                                  │                                │
  │ ◄── AuthAck ─────────────────── │                                │
  │                                  │                                │
  │   ... cycle continues ...        │                                │
  │                                  │                                │
  │ ── [never returns] ─────────── ►│                                │
  │                                  │   (24h passes)                 │
  │                                  │ ── settleTimeout(sN) ────────►│ ← credits returned
  │                                  │                                │   ghost recorded
```

---

## Anti-Gaming Defences

| Layer | Mechanism | Configurable Constants |
|-------|-----------|----------------------|
| Buyer diversity | Proven sign only counts if buyer charged by >= 3 unique sellers | `BUYER_DIVERSITY_THRESHOLD` |
| Minimum deposit | Buyers must deposit >= $10 to participate | `MIN_BUYER_DEPOSIT` |
| Dynamic credit limits | Balance cap grows with usage: peers interacted, time in system, proven sessions, feedback given | `BASE_CREDIT_LIMIT`, `PEER_INTERACTION_BONUS`, `TIME_BONUS`, `PROVEN_SESSION_BONUS`, `FEEDBACK_BONUS`, `MAX_CREDIT_LIMIT` |
| Inactivity lock | Buyer balance locked for 90 days of inactivity | `BUYER_INACTIVITY_PERIOD` |
| Cooldown | 7 days between first session and first proven sign per pair | `PROVEN_SIGN_COOLDOWN` |
| Minimum tokens | Proven sign requires previousConsumption > threshold | `MIN_TOKEN_THRESHOLD` |
| Stake-proportional cap | effectiveProvenSigns = min(actual, stake * k) | `REPUTATION_CAP_COEFFICIENT` |

---

## Slashing Conditions (on unstake)

| Condition | Slash % |
|-----------|---------|
| qualifiedProvenSignCount = 0, total signs > 0 | 100% |
| Qualified proven ratio < 30% | 50% |
| 5+ ghost events, no subsequent proven signs | 100% |
| Good ratio, no qualified activity in last 30 days | 20% |
| Clean ratio, recent proven activity | 0% |

Slashed funds go to protocol reserve (buyer compensation first, remainder to treasury).

---

## Emission Distribution (ANTS Token)

### Emission schedule

- **Epoch emission**: `ε_e = ε_0 / 2^(e/h)` — halving every ~6 months
- **Epoch duration**: configurable (default 1 week)
- No pre-mine. No team allocation. All ANTS distributed through verified work over 10 years.

### Emission split (configurable, must sum to 100%)

| Bucket | Default | Purpose |
|--------|---------|---------|
| `SELLER_SHARE_PCT` | 65% | Rewards proven delivery |
| `BUYER_SHARE_PCT` | 25% | Rewards network usage and feedback |
| `RESERVE_SHARE_PCT` | 10% | Future use (subscription pool staking, liquidity, etc.) |

Reserve accumulates in the emissions contract until a destination is set via `setReserveDestination(address)`. When subscription pool staking or other mechanisms are ready, reserve starts flowing there. No contract upgrade needed.

### Points system

**Seller points (accumulated on each `settle()` call):**
```
sellerPointsDelta = E(P) · V(P) · feedbackMultiplier(P)

where:
  E(P) = min(Q(P), k · S(P))            ← stake-capped qualified proven signs
  V(P) = qualified token volume           ← real tokens delivered in this settlement
  feedbackMultiplier(P) =                 ← from ERC-8004 buyer feedback (configurable tiers)
    FEEDBACK_TIER_1  if avgFeedback < -50   (default 0.5x)
    FEEDBACK_TIER_2  if avgFeedback < 0     (default 0.75x)
    FEEDBACK_TIER_3  if no feedback          (default 1.0x)
    FEEDBACK_TIER_4  if avgFeedback > 50    (default 1.25x)
    FEEDBACK_TIER_5  if avgFeedback > 80    (default 1.5x)
```

**Buyer points (accumulated on each proven session sign + feedback):**
```
buyerPointsDelta = usagePoints + feedbackPoints + diversityBonus

where:
  usagePoints    = provenBuyVolume                   ← tokens acknowledged in this proven sign
  feedbackPoints = FEEDBACK_WEIGHT per submission     ← flat bonus for on-chain feedback
                   (gated: only for settled proven sessions with that peer)
  diversityBonus = usagePoints · min(uniqueSellers / BASE_DIVERSITY, MAX_DIVERSITY_MULT)
                   ← bonus for using many peers (3 = baseline, 6+ = max 2x bonus)
```

All tier thresholds, weights, and multipliers are configurable constants.

### Gas-efficient distribution (Synthetix reward-per-point pattern)

No loops. O(1) per interaction. Uses a global accumulator that tracks reward-per-point:

**On every `settle()` call (O(1)):**
```solidity
// 1. Update global accumulator
rewardPerPointStored += (currentEmissionRate * timeSinceLastUpdate) / totalNetworkPoints;

// 2. Snapshot seller's pending reward before updating their points
seller.pendingReward += seller.points * (rewardPerPointStored - seller.rewardPerPointPaid);
seller.rewardPerPointPaid = rewardPerPointStored;

// 3. Update seller's points from this settlement
seller.points += pointsDelta;
totalNetworkPoints += pointsDelta;
```

**Same pattern for buyers** — separate accumulator (`buyerRewardPerPointStored`).

**Claiming (O(1)):**
```solidity
function claimEmissions() external {
    _updateReward(msg.sender);
    uint256 reward = pending[msg.sender];
    pending[msg.sender] = 0;
    antsToken.mint(msg.sender, reward);       // no loops, constant gas
}
```

**Epoch advancement (O(1), callable by anyone):**
```solidity
function advanceEpoch() external {
    require(block.timestamp >= epochStart + EPOCH_DURATION);
    _updateGlobalReward();                     // flush current epoch accrual
    currentEpoch++;
    epochEmission = initialEmission / (2 ** (currentEpoch / halvingInterval));
    epochStart = block.timestamp;
}
```

**15% per-seller cap** enforced at claim time — excess redistributed to reserve.

---

## PRD Dependency Graph

```
PRD-01 (Identity + Token)
   │
   ▼
PRD-02 (Escrow + Proof Chain)
   │
   ├──────────────────┬──────────────────┐
   ▼                  ▼                  ▼
PRD-03 (SDK)     PRD-04 (SubPool)   PRD-05 (Emissions)
   │                  │                  │
   └──────────────────┴──────────────────┘
                      │
                      ▼
                PRD-06 (CLI + E2E)
```

---

## PRD Summary Table

| PRD | Name | Depends On | Tasks | Can Parallel With |
|-----|------|-----------|-------|-------------------|
| PRD-01 | ANTS Token + Peer Identity | — | 11 | — |
| PRD-02 | AntseedEscrow (Proof of Prior Delivery) | PRD-01 | 16 | — |
| PRD-03 | Protocol & SDK Integration | PRD-02 | 15 | PRD-04, PRD-05 |
| PRD-04 | Subscription Pool Contract | PRD-02 | 8 | PRD-03, PRD-05 |
| PRD-05 | Emissions Contract | PRD-01, PRD-02 | 8 | PRD-03, PRD-04 |
| PRD-06 | CLI, E2E Testing, Docs | PRD-03, PRD-04, PRD-05 | 11 | — |

**Total: 69 tasks**

---

## PRD-01: ANTS Token + Peer Identity

**Scope:** Two Solidity contracts + Foundry tests + TypeScript client wrappers.

**ANTS Token (ERC-20, phase-locked transfers):**
- Inherits OpenZeppelin ERC-20
- `mint(address to, uint256 amount)` — restricted to emissions contract address
- `setEmissionsContract(address)` — owner-only, one-time setter
- No pre-mine, no initial supply
- Deployed on Base
- **Phase 1: Non-transferable.** Participants earn and claim ANTS but cannot transfer or trade them. `transfer()` and `transferFrom()` revert unless `transfersEnabled == true`. Owner calls `enableTransfers()` when the network matures and trading is ready. This is a one-way toggle — once enabled, cannot be disabled.

**AntseedIdentity (ERC-721 Soulbound + ERC-8004 Reputation Registry):**

*Identity (ERC-721, soulbound):*
- `register(bytes32 peerId, string metadataURI)` — mints soulbound NFT to caller
- `updateMetadata(uint256 tokenId, string metadataURI)` — owner of token only
- `deregister(uint256 tokenId)` — burns NFT, requires zero active stake
- Non-transferable: `_update()` override reverts on transfer (mint and burn allowed)
- Dual lookup: `mapping(address => uint256) addressToTokenId` + `mapping(bytes32 => uint256) peerIdToTokenId`
- View functions: `isRegistered(address)`, `getTokenId(address)`, `getTokenIdByPeerId(bytes32 peerId)`, `getPeerId(uint256 tokenId)`

*Custom reputation (proof chain — updated by AntseedEscrow):*
- On-chain counters per token:
  - `firstSignCount`, `qualifiedProvenSignCount`, `unqualifiedProvenSignCount`
  - `totalQualifiedTokenVolume`, `lastProvenAt`, `ghostCount`
- `updateReputation(uint256 tokenId, ReputationUpdate calldata)` — restricted to AntseedEscrow
- `getReputation(uint256 tokenId)` → ProvenReputation struct
- `setEscrowContract(address)` — owner-only, authorizes escrow to update reputation

*ERC-8004 Reputation Registry (human/client feedback):*
- `giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, bytes32 tag1, bytes32 tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)` — any buyer can submit
- `getSummary(uint256 agentId, address client, bytes32 tag)` → count, summaryValue, summaryValueDecimals
- `readFeedback(uint256 agentId, address client, uint256 index)` → FeedbackEntry
- `revokeFeedback(uint256 agentId, uint256 index)` — submitter only
- Tags: `"quality"`, `"latency"`, `"accuracy"`, `"reliability"` (convention, not enforced)
- Feeds into trust score's `qualityScore(P)` component via off-chain aggregation

**TypeScript client (`identity-client.ts`):**
- `register(peerId, metadataURI)` → tx hash
- `getReputation(address)` → ProvenReputation (custom proof chain data)
- `getReputationByPeerId(peerId)` → ProvenReputation (lookup by peerId)
- `getFeedbackSummary(address, tag)` → ERC-8004 aggregated feedback
- `submitFeedback(agentId, value, tag)` → tx hash
- `isRegistered(address)` → boolean
- `getTokenIdByPeerId(peerId)` → tokenId

---

## PRD-02: AntseedEscrow (Proof of Prior Delivery)

**Scope:** Core escrow contract with full proof chain, anti-gaming, staking, and slashing. Foundry tests. TypeScript EscrowClient update.

**Buyer operations:**
- `deposit(uint256 amount)` — USDC deposit, enforces MIN_BUYER_DEPOSIT
- `requestWithdrawal(uint256 amount)` — starts inactivity timer
- `executeWithdrawal()` — after BUYER_INACTIVITY_PERIOD of no activity
- `cancelWithdrawal()` — cancels pending withdrawal
- `getBuyerBalance(address)` — available, reserved, pendingWithdrawal

**Seller operations:**
- `stake(uint256 amount)` — locks USDC, requires registered identity (AntseedIdentity)
- `unstake()` — runs slash check, returns (stake - slashAmount)
- `reserve(SpendingAuth calldata auth, bytes calldata buyerSig)` — locks buyer credits for session
  - Validates EIP-712 signature
  - Validates proof chain: `previousSessionId` must be a valid settled/active session between this buyer-seller pair
  - Enforces first sign cap ($1) when `previousConsumption == 0`
  - Enforces cooldown (PROVEN_SIGN_COOLDOWN) for proven signs
  - Classifies: first sign / proven sign / qualified proven sign
  - Updates reputation counters on AntseedIdentity
- `settle(bytes32 sessionId, uint256 tokenCount)` — charges actual consumption, releases unused reservation
  - `tokenCount` comes from buyer's NEXT `SpendingAuth.previousConsumption`
  - Converts tokens to credits using seller's published rate
  - Platform fee deducted at settlement
  - Excess returned to buyer's available balance
- `settleTimeout(bytes32 sessionId)` — after SETTLE_TIMEOUT (default 24h)
  - Returns ALL reserved credits to buyer
  - Records ghost event against seller
  - No reputation accrual for seller
- `claimEarnings()` — seller withdraws accumulated earnings

**EIP-712 SpendingAuth type:**
```
SpendingAuth(
  address seller,
  bytes32 sessionId,
  uint256 maxAmount,
  uint256 nonce,
  uint256 deadline,
  uint256 previousConsumption,
  bytes32 previousSessionId
)
```

**Anti-gaming (all configurable):**
- Buyer diversity: `uniqueSellersCharged[buyer]` >= `BUYER_DIVERSITY_THRESHOLD`
- Minimum deposit: `MIN_BUYER_DEPOSIT` (default 10 USDC)
- Inactivity lock: `BUYER_INACTIVITY_PERIOD` (default 90 days)
- Cooldown: `PROVEN_SIGN_COOLDOWN` (default 7 days)
- Minimum tokens: `MIN_TOKEN_THRESHOLD` (default 1000 tokens)
- Reputation cap: `effectiveProvenSigns = min(Q, stake * REPUTATION_CAP_COEFFICIENT)`
- First sign cap: `FIRST_SIGN_CAP` (default 1 USDC)

**Slashing:**
- Computed at `unstake()` time based on reputation ratios
- Slashed funds sent to protocol reserve address
- Five tiers per the slashing conditions table above

**Owner functions:**
- `setConstant(bytes32 key, uint256 value)` — update any configurable constant
- `setPlatformFee(uint256 bps)` — capped at MAX_PLATFORM_FEE
- `setProtocolReserve(address)` — where slashed funds go
- `pause()` / `unpause()` — emergency circuit breaker

---

## PRD-03: Protocol & SDK Integration

**Scope:** Wire the new contracts into the node SDK. Make everything automatic for peers and buyers.

**Protocol messages (unchanged type codes):**

| Type | Message | Direction |
|------|---------|-----------|
| 0x50 | SpendingAuth | Buyer → Seller |
| 0x51 | AuthAck | Seller → Buyer |
| 0x53 | SellerReceipt | Seller → Buyer |
| 0x54 | BuyerAck | Buyer → Seller |
| 0x55 | TopUpRequest | Seller → Buyer |

**BuyerPaymentManager changes:**
- Persistent session storage (SQLite) — proof chain survives restarts
- `authorizeSpending()` includes `previousConsumption` from persisted prior session
- Handles `SellerReceipt` messages — updates local running total
- Sends `BuyerAck` to confirm receipt
- Handles `TopUpRequest` — signs new `SpendingAuth` with increased cap if budget allows
- `getSessionHistory(sellerPeerId)` — returns full proof chain for a seller

**SellerPaymentManager changes:**
- Persistent session storage (SQLite)
- `handleSpendingAuth()` — settle-then-reserve atomic flow:
  1. If prior session exists: call `settle(priorSessionId, auth.previousConsumption)` on-chain
  2. Call `reserve(newSessionId, ...)` on-chain
  3. Send AuthAck
- Sends `SellerReceipt` after each request (running total, request count, response hash)
- Handles `BuyerAck` — stores as bilateral proof
- TopUp detection: when `tokensDelivered / authMax > 0.80`, sends `TopUpRequest`
- `onBuyerDisconnect()` — schedules 24h timeout timer (persisted)

**Node.ts integration:**
- `_sendBilateralReceipt()` — actually sends SellerReceipt over PaymentMux
- `_handleBuyerAck()` — new handler for buyer acknowledgments
- Persistent session timers for 24h timeout (survives restart via SQLite)
- Registration check: seller must have AntseedIdentity NFT to accept paid requests
- Token counting from actual response body (input + output tokens)

**Session persistence schema (SQLite):**
```sql
CREATE TABLE sessions (
  session_id TEXT PRIMARY KEY,
  peer_id TEXT NOT NULL,
  role TEXT NOT NULL,              -- 'buyer' or 'seller'
  seller_evm_addr TEXT,
  buyer_evm_addr TEXT,
  nonce INTEGER,
  auth_max BIGINT,
  deadline INTEGER,
  previous_session_id TEXT,
  previous_consumption BIGINT,
  tokens_delivered BIGINT DEFAULT 0,
  request_count INTEGER DEFAULT 0,
  reserved_at INTEGER,
  settled_at INTEGER,
  settled_amount BIGINT,
  status TEXT DEFAULT 'active',    -- active, settled, timeout, ghost
  created_at INTEGER,
  updated_at INTEGER
);

CREATE TABLE receipts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  running_total BIGINT,
  request_count INTEGER,
  response_hash TEXT,
  seller_sig TEXT,
  buyer_ack_sig TEXT,
  created_at INTEGER,
  FOREIGN KEY (session_id) REFERENCES sessions(session_id)
);
```

---

## PRD-04: Subscription Pool Contract

**Scope:** Separate contract for subscription management. Foundry tests. TypeScript client.

**AntseedSubPool contract:**
- `subscribe(uint256 tier)` — buyer pays monthly fee in USDC
- `cancelSubscription()` — stops at end of current period
- `setTier(uint256 tierId, uint256 monthlyFee, uint256 dailyTokenBudget)` — owner
- `optIn(uint256 tokenId)` — peer opts in to serve subscription users (requires AntseedIdentity)
- `optOut(uint256 tokenId)` — peer opts out
- `claimRevenue(uint256 tokenId)` — peer claims their share of subscription pool
- Revenue distribution proportional to peer's proven delivery (reads from AntseedIdentity reputation)
- Daily token budget enforcement per subscriber
- `distributionEpoch()` — callable by anyone, computes and distributes current epoch's revenue

**Reads from:**
- AntseedIdentity — peer reputation for revenue weighting
- AntseedEscrow — proven stats for delivery verification

---

## PRD-05: Emissions Contract

**Scope:** ANTS token emission controller using Synthetix reward-per-point pattern. Foundry tests. TypeScript client.

**AntseedEmissions contract:**

*Epoch management:*
- `advanceEpoch()` — callable by anyone when epoch duration has passed
  - Flushes current epoch accrual to global accumulators
  - Computes new emission rate: `ε_0 / 2^(e/h)`
  - Updates `epochStart` timestamp
- `getEpochInfo()` — current epoch, emission amount, time remaining

*Point accrual (called by AntseedEscrow on each settle):*
- `accrueSellerPoints(address seller, uint256 pointsDelta)` — restricted to AntseedEscrow
  - Updates global `sellerRewardPerPointStored`
  - Snapshots seller's pending reward
  - Adds `pointsDelta` to seller's total and global total
- `accrueBuyerPoints(address buyer, uint256 pointsDelta)` — restricted to AntseedEscrow
  - Same pattern with separate buyer accumulator

*Claiming (O(1), no loops):*
- `claimEmissions()` — mints accrued ANTS to caller
  - Enforces 15% per-seller cap (excess sent to reserve)
- `pendingEmissions(address)` — view: how much ANTS available to claim

*Reserve:*
- `setReserveDestination(address)` — owner-only, where reserve emissions flow
- `flushReserve()` — sends accumulated reserve to destination

*Configuration (all owner-settable):*
- `EPOCH_DURATION` (default: 1 week)
- `HALVING_INTERVAL` (default: 26 epochs ≈ 6 months)
- `INITIAL_EMISSION` (set at deployment)
- `SELLER_SHARE_PCT` (default: 65%)
- `BUYER_SHARE_PCT` (default: 25%)
- `RESERVE_SHARE_PCT` (default: 10%)
- `MAX_SELLER_SHARE_PCT` (default: 15% of seller pool)
- `FEEDBACK_WEIGHT` (buyer points per feedback submission)
- `BASE_DIVERSITY` (baseline unique sellers for diversity bonus, default: 3)
- `MAX_DIVERSITY_MULT` (max diversity multiplier, default: 2x)
- `FEEDBACK_TIER_1..5` (feedback multiplier thresholds and values)

**Reads from:**
- AntseedIdentity — feedback multiplier for seller points
- ANTS token — mints via `mint()`

**Called by:**
- AntseedEscrow — on each `settle()` and proven sign event

---

## PRD-06: CLI, E2E Testing, Documentation

**Scope:** Updated CLI commands, end-to-end integration tests, protocol documentation.

**CLI commands:**
- `antseed register` — register peer identity (mint AntseedIdentity NFT)
- `antseed stake <amount>` — stake USDC as seller
- `antseed unstake` — unstake with slash check
- `antseed deposit <amount>` — buyer deposits USDC
- `antseed withdraw` — buyer withdrawal (inactivity lock check)
- `antseed balance` — show escrow balance, stake, earnings, reputation
- `antseed subscribe <tier>` — subscribe to pool
- `antseed emissions` — show current epoch info and projected earnings
- `antseed reputation <peer>` — query peer reputation from chain
- `antseed sessions` — list active/historical sessions from local SQLite

**E2E tests (Base Sepolia):**
- Full lifecycle: register → stake → deposit → connect → serve → disconnect → reconnect → settle
- Proof chain: verify previousConsumption flows correctly across sessions
- First sign cap enforcement
- Proven sign qualification (buyer diversity, cooldown)
- Ghost timeout path
- Slashing on unstake
- Subscription pool flow
- Emission distribution

**Documentation:**
- Updated `docs/protocol/spec/04-payments.md`
- Contract API reference
- SDK integration guide

---

## Open Questions

None — all architectural decisions resolved during planning.

---

## Reference Documents

- `~/Downloads/AntSeed_Protocol_Summary_v2.pdf` — Protocol summary with session lifecycle, anti-gaming, slashing
- `~/Downloads/AntSeed_Protocol_Math_v2.pdf` — Mathematical foundations, formal proofs, wash trading economics
- PR #18 (`feat/pull-payment-system`) — Prior payment implementation (to be superseded)
