# 04 - Payments: Streaming MetadataAuth

This document specifies the payment protocol for the AntSeed P2P AI compute network. Payments use USDC on Base with two EIP-712 signed messages: **ReserveAuth** (session budget) and **MetadataAuth** (cumulative per-request authorization). AntseedSessions orchestrates the lifecycle but holds no USDC — all funds stay in AntseedDeposits.

## 1. Session Lifecycle (Reserve → Serve → Settle/Close)

```
BUYER                              SELLER                           ON-CHAIN
  │                                  │                                │
  │ ─ ReserveAuth ─────────────────► │                                │
  │   {channelId, maxAmount,         │                                │
  │    deadline}                      │ ── reserve(buyerSig) ─────────►│
  │                                  │    Deposits.lockForSession()   │ ← USDC locked
  │                                  │                                │
  │ ◄── AuthAck ─────────────────── │                                │
  │                                  │                                │
  │ ══ SERVE ═══════════════════════ │                                │
  │   requests flow                  │   cumulativeAmount increases   │
  │   ◄── SellerReceipt (per req) ── │   running total + hash         │
  │   ── MetadataAuth ────────────► │   buyer signs cumulative auth  │
  │         ... N requests           │                                │
  │                                  │                                │
  │  === SETTLE (mid-session) ======  │                                │
  │                                  │ ── settle(MetadataAuth) ──────►│ ← charges cumulative
  │                                  │    Deposits.chargeAndCredit    │   session stays open
  │                                  │    EarningsToSeller()          │
  │                                  │                                │
  │  === CLOSE (final) ============  │                                │
  │                                  │ ── close(MetadataAuth) ───────►│ ← charges final amount
  │                                  │    releases remaining lock     │   session finalized
  │                                  │                                │
  │  === TIMEOUT (seller gone) ====  │                                │
  │                                  │   (deadline passes)            │
  │   anyone ── requestTimeout() ──────────────────────────────────── ►│ ← marks timed out
  │   (15min grace)                  │                                │
  │   anyone ── withdraw() ────────────────────────────────────────── ►│ ← funds returned
```

### Reserve

The buyer signs an EIP-712 `ReserveAuth` (channelId, maxAmount, deadline) and sends it to the seller over P2P. The seller calls `reserve()` on-chain, which verifies the buyer's signature and calls `Deposits.lockForSession()` to lock the buyer's USDC. The channelId is `keccak256(abi.encode(buyer, seller, salt))`.

### Serve

During the session, the seller sends a `SellerReceipt` after each request. The buyer signs a `MetadataAuth` with the new cumulative amount and metadata hash. These form the authorization trail.

When the session budget is nearly exhausted, the seller settles (calls `close()`), returns HTTP 402, and the buyer initiates a new session negotiation with a fresh ReserveAuth.

### Settle / Close

The seller calls `settle()` with the latest MetadataAuth to charge the cumulative amount while keeping the session open. To finalize, the seller calls `close()`, which charges the final amount and releases remaining locked funds to the buyer.

### Timeout

If the seller disappears after the deadline, anyone can call `requestTimeout()`. After a 15-minute grace period, `withdraw()` releases the locked funds back to the buyer's deposit.

## 2. EIP-712 Signed Messages

EIP-712 domain for both message types:

```
name:               "AntseedSessions"
version:            "6"
chainId:            <deployment chain>
verifyingContract:  <sessions contract address>
```

### ReserveAuth

```
ReserveAuth(
  bytes32 channelId,
  uint128 maxAmount,
  uint256 deadline
)
```

| Field | Description |
|---|---|
| `channelId` | `keccak256(abi.encode(buyer, seller, salt))` — unique per session |
| `maxAmount` | Maximum USDC (6 decimals) the seller may lock from the buyer's deposit |
| `deadline` | Unix timestamp after which this authorization and the session expire |

The buyer signs this off-chain. The seller submits it to `reserve()` along with buyer address, salt, maxAmount, and deadline.

### MetadataAuth

```
MetadataAuth(
  bytes32 channelId,
  uint256 cumulativeAmount,
  bytes32 metadataHash
)
```

| Field | Description |
|---|---|
| `channelId` | Same channel identifier as the ReserveAuth |
| `cumulativeAmount` | Total USDC authorized so far (monotonically increasing across requests) |
| `metadataHash` | Hash of request metadata (input/output tokens, model identifier, etc.) |

The buyer signs a new MetadataAuth after each request. The seller accumulates these and submits the latest to `settle()` or `close()`. Single signature per action — no dual signatures required.

## 3. Session Budget and Budget Exhaustion

The `maxAmount` in the ReserveAuth caps total USDC the seller can charge in a session. The buyer's MetadataAuth `cumulativeAmount` must not exceed this cap.

When the budget is nearly exhausted, the seller calls `close()` with the final MetadataAuth, returns HTTP 402 to the buyer, and the buyer initiates a new session negotiation with a fresh ReserveAuth and salt.

## 4. Per-Agent Stats (AntseedStats)

Session metrics are tracked per ERC-8004 agentId in the AntseedStats contract. Stats are updated by AntseedSessions during `settle()` and `close()`:

- `sessionCount` — number of completed sessions
- `totalVolumeUsdc` — cumulative USDC volume
- `totalRequests` — cumulative request count

Stats are factual counters with no reputation scoring logic. They feed into emissions and staking calculations.

## 5. Anti-Gaming Defences

| Layer | Mechanism | Default |
|---|---|---|
| Minimum deposit | Buyers must deposit at least N USDC to participate | 10 USDC |
| Minimum stake | Sellers must stake USDC bound to ERC-8004 agentId | 10 USDC |
| Budget binding | ReserveAuth binds maxAmount and deadline to buyer signature | Per-session |
| Cumulative auth | MetadataAuth cumulativeAmount is monotonically increasing | Per-request |
| Gasless buyer | Buyer never submits transactions — cannot be griefed for gas | Always |

## 6. Staking

Sellers must stake USDC via `stake(agentId, amount)` on `AntseedStaking`, binding their stake to an ERC-8004 agentId. Minimum stake: `MIN_SELLER_STAKE` (default: 10 USDC). An unstaked seller cannot have `reserve()` called — the transaction reverts.

## 7. Stats and Identity

### AntseedStats (on-chain metrics)

Factual per-agent session metrics updated by AntseedSessions during settlement. No reputation scoring — pure counters.

### ERC-8004 Identity and Feedback

Identity uses the deployed ERC-8004 IdentityRegistry (Base: `0x8004A169...`). Feedback uses the deployed ERC-8004 ReputationRegistry (Base: `0x8004BAa1...`). There is no custom AntseedIdentity contract.

### MockERC8004Registry

For local testing only. Simulates the ERC-8004 registry interface so contracts can be tested without a mainnet dependency.

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

Separate contract (`AntseedSubPool`) managing subscription-based access. Evolves independently from the core deposits/sessions/proof system.

- `subscribe(tier)` — buyer pays monthly fee in USDC
- `cancelSubscription()` — stops at end of current period
- `setTier(tierId, monthlyFee, dailyTokenBudget)` — owner configures tiers
- `optIn(agentId)` / `optOut(agentId)` — peers opt in/out of serving subscribers (requires ERC-8004 agentId)
- `claimRevenue(agentId)` — peer claims share proportional to stats
- `distributionEpoch()` — callable by anyone, distributes current epoch revenue
- Daily token budget enforcement per subscriber

## 10. Contract Architecture

```
ANTSToken (ERC-20)        ── mint restricted to AntseedEmissions
AntseedDeposits           ── buyer USDC deposits, holds ALL buyer USDC
AntseedSessions           ── Reserve→Settle/Close lifecycle (holds NO USDC, swappable)
AntseedStaking            ── seller stake bound to ERC-8004 agentId
AntseedStats              ── factual per-agent session metrics
AntseedEmissions          ── USDC volume-based epoch emissions
AntseedSubPool            ── subscription tiers, daily budgets, revenue distribution
MockERC8004Registry       ── local testing only (mainnet: deployed ERC-8004)
```

Contracts reference each other by address (set at deployment, updateable by owner). No inheritance between contracts — only interface calls.

**Interaction flow:**
- `AntseedSessions` calls `AntseedDeposits.lockForSession()` on reserve
- `AntseedSessions` calls `AntseedDeposits.chargeAndCreditEarnings()` on settle/close
- `AntseedSessions` calls `AntseedStats.updateStats()` on settle/close
- `AntseedSessions` calls `AntseedEmissions.accrueSellerPoints()` / `accrueBuyerPoints()` on settle/close
- `AntseedSessions` reads from `AntseedStaking` (seller stake verification)
- `AntseedEmissions` calls `ANTSToken.mint()` on claim

## 11. P2P Messages

| Type | Name | Direction | Description |
|---|---|---|---|
| 0x50 | `ReserveAuth` | Buyer → Seller | EIP-712 signed reserve authorization |
| 0x51 | `AuthAck` | Seller → Buyer | Reservation confirmed |
| 0x53 | `SellerReceipt` | Seller → Buyer | Running-total receipt after each request |
| 0x54 | `MetadataAuth` | Buyer → Seller | EIP-712 signed cumulative spending authorization |

## 12. Session Persistence

Session state is persisted to SQLite in the node SDK. Schema:

- `sessions` table: channel_id, peer_id, role, EVM addresses, salt, max_amount, deadline, cumulative_amount, request_count, timestamps, status
- `receipts` table: channel_id, cumulative_amount, request_count, metadata_hash, seller_sig, buyer_metadata_auth_sig, timestamp

## 13. Supported Chains

| Chain ID | Network | Purpose |
|---|---|---|
| `base-sepolia` | Base Sepolia testnet | Testing and development |
| `base-mainnet` | Base mainnet | Production |
