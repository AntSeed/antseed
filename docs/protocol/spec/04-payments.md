# 04 - Payments: Proof of Prior Delivery

This document specifies the payment, proof, and reputation protocol for the AntSeed P2P AI compute network. Payments use USDC on Base with EIP-712 spending authorizations. Proof of delivery is established through a cryptographic chain where each new authorization simultaneously pays for the current session and proves delivery of the previous one.

## 1. Session Lifecycle (Reserve → Serve → Settle)

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

### Reserve

The buyer signs an EIP-712 `SpendingAuth` and sends it to the seller over P2P. The seller verifies the signature and calls `reserve()` on-chain, which locks buyer credits for this session. If the auth includes a `previousSessionId`, the seller atomically settles the prior session in the same call.

### Serve

During the session, the seller sends a `SellerReceipt` after each request containing the running token total, request count, and response hash. The buyer verifies and responds with a `BuyerAck`. These bilateral receipts form an off-chain audit trail.

When `tokensDelivered / authMax > 0.80`, the seller sends a `TopUpRequest`. The buyer may sign a new `SpendingAuth` with a higher cap.

### Settle

Settlement is triggered by the buyer's NEXT `SpendingAuth` — the `previousConsumption` field IS the settlement amount for the prior session. The seller calls `settle(previousSessionId, previousConsumption)` on-chain, which converts tokens to credits at the seller's published rate, deducts the platform fee, and returns unused reservation to the buyer.

If the buyer never returns within 24 hours, the seller calls `settleTimeout()`. This returns all reserved credits to the buyer in full and records a ghost event against the seller's reputation. No reputation accrual occurs for timed-out sessions.

## 2. SpendingAuth (EIP-712)

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

| Field | Description |
|---|---|
| `seller` | EVM address of the seller being authorized to charge |
| `sessionId` | Random bytes32 identifying this session |
| `maxAmount` | Maximum USDC (6 decimals) the seller can charge for this session |
| `nonce` | Monotonically increasing per buyer-seller pair |
| `deadline` | Unix timestamp after which this auth expires |
| `previousConsumption` | Tokens delivered in the PREVIOUS session (0 for first session) |
| `previousSessionId` | Session ID of the previous session (zero bytes for first session) |

The buyer signs this struct using EIP-712 typed data. The seller recovers the buyer address via ECDSA and submits the auth + signature to `reserve()`.

## 3. Proof Chain

Each `SpendingAuth` forms a link in an unforgeable chain:

1. **Session 1** (first sign): `previousConsumption = 0`, `previousSessionId = 0x00`. This is a blind trust — capped at $1.
2. **Session 2** (proven sign): `previousConsumption = 15420`, `previousSessionId = s1`. The buyer signing this proves they received 15,420 tokens in session 1. The seller settles session 1 for that amount.
3. **Session N**: Each auth proves delivery of session N-1 and authorizes session N.

The chain is unforgeable because:
- Only the buyer can sign a `SpendingAuth` (ECDSA signature verified on-chain)
- The `previousSessionId` must reference a valid Reserved session between the same buyer-seller pair
- The `previousConsumption` is the buyer's attestation of tokens received — they have no incentive to overstate

## 4. Sign Types

### First Sign

- `previousConsumption == 0` and `previousSessionId == 0x00`
- Maximum `maxAmount` capped at `FIRST_SIGN_CAP` (default: 1 USDC)
- No proof of prior delivery — blind trust from the buyer
- Records `firstSignCount++` on seller's reputation

### Proven Sign

- `previousConsumption > 0` and `previousSessionId` references a valid prior session
- Requires `previousConsumption >= MIN_TOKEN_THRESHOLD` (default: 1000 tokens)
- Requires `PROVEN_SIGN_COOLDOWN` (default: 7 days) elapsed since the buyer's first session with this seller
- Full `maxAmount` allowed (no cap beyond buyer balance)

### Qualified Proven Sign

A proven sign becomes "qualified" when the buyer has been charged by at least `BUYER_DIVERSITY_THRESHOLD` (default: 3) unique sellers. This prevents a single colluding buyer-seller pair from farming reputation. Records `qualifiedProvenSignCount++` and adds to `totalQualifiedTokenVolume`.

An unqualified proven sign (buyer has used fewer than 3 sellers) still settles payment normally but does not contribute to the seller's qualified reputation or emission points.

## 5. Anti-Gaming Defences

Seven independent layers make wash trading economically irrational at every scale.

| Layer | Mechanism | Default | Configurable Constant |
|---|---|---|---|
| Buyer diversity | Proven sign only qualifies if buyer has been charged by N unique sellers | 3 sellers | `BUYER_DIVERSITY_THRESHOLD` |
| Minimum deposit | Buyers must deposit at least N USDC to participate | 10 USDC | `MIN_BUYER_DEPOSIT` |
| Dynamic credit limits | Buyer balance cap grows with real usage (see below) | 10 USDC base | `BASE_CREDIT_LIMIT`, `PEER_INTERACTION_BONUS`, `TIME_BONUS`, `PROVEN_SESSION_BONUS`, `FEEDBACK_BONUS`, `MAX_CREDIT_LIMIT` |
| Inactivity lock | Buyer balance locked after N days of inactivity | 90 days | `BUYER_INACTIVITY_PERIOD` |
| Cooldown | Time between first session and first proven sign per buyer-seller pair | 7 days | `PROVEN_SIGN_COOLDOWN` |
| Minimum tokens | Proven sign requires previousConsumption above threshold | 1000 tokens | `MIN_TOKEN_THRESHOLD` |
| Stake-proportional cap | `effectiveProvenSigns = min(actual, stake * k)` | k = 20 | `REPUTATION_CAP_COEFFICIENT` |

### Dynamic Credit Limits

A buyer's maximum escrow balance grows organically with real network participation:

```
buyerCreditLimit(B) = min(
  BASE_CREDIT_LIMIT
  + PEER_INTERACTION_BONUS * uniqueSellersCharged(B)
  + TIME_BONUS * daysSinceFirstSession(B)
  + PROVEN_SESSION_BONUS * provenBuyCount(B)
  + FEEDBACK_BONUS * feedbacksSubmitted(B),
  MAX_CREDIT_LIMIT
)
```

The owner can override individual buyer limits via `setCreditLimitOverride(address, uint256)`. The `deposit()` function enforces `balance + amount <= buyerCreditLimit(msg.sender)`.

## 6. Staking and Slashing

### Staking

Sellers must stake USDC via `stake(amount)` to accept paid sessions. A registered but unstaked peer (has AntseedIdentity NFT but zero stake) cannot have `reserve()` called — the transaction reverts. Minimum stake: `MIN_SELLER_STAKE` (default: 10 USDC).

### Slashing Conditions (computed at `unstake()`)

| Condition | Slash % | Rationale |
|---|---|---|
| `qualifiedProvenSignCount == 0`, total signs > 0 | 100% | No real delivery proven |
| Qualified proven ratio < 30% | 50% | Most sessions unproven |
| 5+ ghost events, no subsequent proven signs | 100% | Persistent failure to deliver |
| Good ratio, no qualified activity in last 30 days | 20% | Stale inactive peer |
| Clean ratio, recent proven activity | 0% | Healthy peer |

Slashed funds are sent to the protocol reserve address (configurable via `setProtocolReserve(address)`).

## 7. Reputation

Peer reputation is stored on-chain in `AntseedIdentity` with two layers:

### Custom Proof Chain Reputation (updated by AntseedEscrow)

Per-peer counters updated atomically during `reserve()` and `settle()`:
- `firstSignCount` — number of first-sign sessions
- `qualifiedProvenSignCount` — number of qualified proven signs
- `unqualifiedProvenSignCount` — proven signs from buyers below diversity threshold
- `totalQualifiedTokenVolume` — total tokens delivered in qualified proven sessions
- `lastProvenAt` — timestamp of last proven sign
- `ghostCount` — number of timed-out sessions

### ERC-8004 Feedback Registry (buyer submissions)

Generic buyer feedback signals implementing the ERC-8004 standard:
- `giveFeedback(agentId, value, valueDecimals, tag1, tag2, endpoint, feedbackURI, feedbackHash)`
- `getSummary(agentId, client, tag)` — aggregated count and value
- `readFeedback(agentId, client, index)` — individual entries
- `revokeFeedback(agentId, index)` — submitter only

Tags by convention: `"quality"`, `"latency"`, `"accuracy"`, `"reliability"`.

### Combined Trust Score

```
onChainTrustScore(P) = w1 * provenDeliveryRate(P)   ← custom reputation (proof chain)
                      + w2 * qualityScore(P)          ← ERC-8004 feedback signals
```

Off-chain metrics (uptime, latency, flag rate) remain in the node's local trust score calculation for routing but are not part of the contract system.

## 8. Emission Distribution (ANTS Token)

### ANTS Token

ERC-20 on Base. No pre-mine. No initial supply. All ANTS distributed through verified work over 10 years.

**Phase 1 (current):** Non-transferable. `transfer()` and `transferFrom()` revert. Participants earn and claim but cannot trade. Owner calls `enableTransfers()` (one-way toggle) when the network matures.

Mint authority restricted to `AntseedEmissions` contract (`setEmissionsContract()` — one-time setter).

### Emission Schedule

- Epoch emission: `e_e = e_0 / 2^(e/h)` — halving every ~6 months
- Epoch duration: configurable (default 1 week, 26 epochs per halving interval)
- `advanceEpoch()` callable by anyone when epoch duration has passed

### Emission Split

| Bucket | Default | Purpose |
|---|---|---|
| Seller share | 65% | Rewards proven delivery |
| Buyer share | 25% | Rewards network usage and feedback |
| Reserve share | 10% | Future use (subscription pool staking, liquidity) |

Reserve accumulates in the emissions contract until `setReserveDestination(address)` is called.

### Points System

**Seller points** (accumulated on each `settle()` call):
```
sellerPointsDelta = E(P) * V(P) * feedbackMultiplier(P)

where:
  E(P) = min(Q(P), k * S(P))            ← stake-capped qualified proven signs
  V(P) = qualified token volume           ← real tokens delivered in this settlement
  feedbackMultiplier(P) =                 ← from ERC-8004 buyer feedback
    0.5x   if avgFeedback < -50
    0.75x  if avgFeedback < 0
    1.0x   if no feedback
    1.25x  if avgFeedback > 50
    1.5x   if avgFeedback > 80
```

**Buyer points** (accumulated on each proven session sign + feedback):
```
buyerPointsDelta = usagePoints + feedbackPoints + diversityBonus

where:
  usagePoints    = provenBuyVolume                   ← tokens in this proven sign
  feedbackPoints = FEEDBACK_WEIGHT per submission     ← flat bonus for on-chain feedback
  diversityBonus = usagePoints * min(uniqueSellers / BASE_DIVERSITY, MAX_DIVERSITY_MULT)
```

### Gas-Efficient Distribution (Synthetix Reward-Per-Point)

No loops. O(1) per interaction. Global accumulator tracks reward-per-point:

```
// On every settle() — O(1):
rewardPerPointStored += (currentEmissionRate * timeSinceLastUpdate) / totalNetworkPoints;
seller.pendingReward += seller.points * (rewardPerPointStored - seller.rewardPerPointPaid);
seller.rewardPerPointPaid = rewardPerPointStored;
seller.points += pointsDelta;
totalNetworkPoints += pointsDelta;
```

Same pattern for buyers with a separate accumulator (`buyerRewardPerPointStored`).

**Claiming** (`claimEmissions()`): mints accrued ANTS to caller. 15% per-seller cap enforced — excess redistributed to reserve.

**Epoch advancement** (`advanceEpoch()`): callable by anyone. Flushes current epoch accrual, computes new emission rate, updates `epochStart`.

## 9. Subscription Pool

Separate contract (`AntseedSubPool`) managing subscription-based access. Evolves independently from the core escrow/proof system.

- `subscribe(tier)` — buyer pays monthly fee in USDC
- `cancelSubscription()` — stops at end of current period
- `setTier(tierId, monthlyFee, dailyTokenBudget)` — owner configures tiers
- `optIn(tokenId)` / `optOut(tokenId)` — peers opt in/out of serving subscribers (requires AntseedIdentity)
- `claimRevenue(tokenId)` — peer claims share proportional to proven delivery reputation
- `distributionEpoch()` — callable by anyone, distributes current epoch revenue
- Daily token budget enforcement per subscriber

## 10. Contract Architecture

```
ANTSToken (ERC-20)        ── mint restricted to AntseedEmissions
AntseedIdentity (ERC-721) ── soulbound NFT, dual lookup, reputation, ERC-8004 feedback
AntseedEscrow             ── Reserve→Settle, proof chain, staking, slashing, anti-gaming
AntseedEmissions          ── epoch halving, Synthetix reward-per-point, 65/25/10 split
AntseedSubPool            ── subscription tiers, daily budgets, revenue distribution
```

Contracts reference each other by address (set at deployment, updateable by owner). No inheritance between contracts — only interface calls.

**Interaction flow:**
- `AntseedEscrow` calls `AntseedIdentity.updateReputation()` on reserve/settle
- `AntseedEscrow` calls `AntseedEmissions.accrueSellerPoints()` / `accrueBuyerPoints()` on settle
- `AntseedEmissions` calls `ANTSToken.mint()` on claim
- `AntseedSubPool` reads from `AntseedIdentity` (reputation) and `AntseedEscrow` (proven stats)

## 11. P2P Messages

| Type | Name | Direction | Description |
|---|---|---|---|
| 0x50 | `SpendingAuth` | Buyer → Seller | EIP-712 signed spending authorization |
| 0x51 | `AuthAck` | Seller → Buyer | Reservation confirmed |
| 0x53 | `SellerReceipt` | Seller → Buyer | Running-total receipt after each request |
| 0x54 | `BuyerAck` | Buyer → Seller | Buyer acknowledges receipt |
| 0x55 | `TopUpRequest` | Seller → Buyer | Request additional authorization |

## 12. Session Persistence

Session state is persisted to SQLite in the node SDK, ensuring proof chains survive node restarts. Schema:

- `sessions` table: session_id, peer_id, role, EVM addresses, nonce, auth_max, deadline, previous_session_id, previous_consumption, tokens_delivered, request_count, timestamps, status
- `receipts` table: session_id, running_total, request_count, response_hash, seller_sig, buyer_ack_sig, timestamp

## 13. Supported Chains

| Chain ID | Network | Purpose |
|---|---|---|
| `base-sepolia` | Base Sepolia testnet | Testing and development |
| `base-mainnet` | Base mainnet | Production |
