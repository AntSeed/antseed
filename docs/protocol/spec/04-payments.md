# 04 - Payments: Streaming SpendingAuth

This document specifies the payment protocol for the AntSeed P2P AI compute network. Payments use USDC on Base with two EIP-712 signed messages: **ReserveAuth** (session budget) and **SpendingAuth** (cumulative per-request authorization). AntseedChannels orchestrates the lifecycle but holds no USDC — all funds stay in AntseedDeposits.

## 1. Session Lifecycle (Reserve → Serve → Settle/Close)

```
BUYER                              SELLER                           ON-CHAIN
  │                                  │                                │
  │ ─ ReserveAuth ─────────────────► │                                │
  │   {channelId, maxAmount,         │                                │
  │    deadline}                      │ ── reserve(buyerSig) ─────────►│
  │                                  │    Deposits.lockForChannel()   │ ← USDC locked
  │                                  │                                │
  │ ◄── AuthAck ─────────────────── │                                │
  │                                  │                                │
  │ ══ SERVE ═══════════════════════ │                                │
  │   requests flow                  │   cumulativeAmount increases   │
  │   ◄── SellerReceipt (per req) ── │   running total + hash         │
  │   ── SpendingAuth ────────────► │   buyer signs cumulative auth  │
  │         ... N requests           │                                │
  │                                  │                                │
  │  === SETTLE (mid-session) ======  │                                │
  │                                  │ ── settle(SpendingAuth) ──────►│ ← charges cumulative
  │                                  │    Deposits.chargeAndCredit    │   session stays open
  │                                  │    EarningsToSeller()          │
  │                                  │                                │
  │  === CLOSE (final) ============  │                                │
  │                                  │ ── close(SpendingAuth) ───────►│ ← charges final amount
  │                                  │    releases remaining lock     │   session finalized
  │                                  │                                │
  │  === TIMEOUT (seller gone) ====  │                                │
  │                                  │   (deadline passes)            │
  │   anyone ── requestTimeout() ──────────────────────────────────── ►│ ← marks timed out
  │   (15min grace)                  │                                │
  │   anyone ── withdraw() ────────────────────────────────────────── ►│ ← funds returned
```

### Reserve

The buyer signs an EIP-712 `ReserveAuth` (channelId, maxAmount, deadline) and sends it to the seller over P2P. The seller calls `reserve()` on-chain, which verifies the buyer's signature and calls `Deposits.lockForChannel()` to lock the buyer's USDC. The channelId is `keccak256(abi.encode(buyer, seller, salt))`.

### Serve

During the session, the seller sends a `SellerReceipt` after each request. The buyer signs a `SpendingAuth` with the new cumulative amount and metadata hash. These form the authorization trail.

When the session budget is nearly exhausted, the seller settles (calls `close()`), returns HTTP 402, and the buyer initiates a new session negotiation with a fresh ReserveAuth.

### Settle / Close

The seller calls `settle()` with the latest SpendingAuth to charge the cumulative amount while keeping the session open. To finalize, the seller calls `close()`, which charges the final amount and releases remaining locked funds to the buyer.

### Timeout

If the seller disappears after the deadline, anyone can call `requestTimeout()`. After a 15-minute grace period, `withdraw()` releases the locked funds back to the buyer's deposit.

### Cooperative close (buyer-requested)

Close is normally seller-initiated. A buyer that wants its reserve back **now** —
without waiting out the 15-minute timeout grace period — asks the seller to
close instead, over `CloseChannelRequest` / `CloseChannelResult` (§11).

```
BUYER                              SELLER                           ON-CHAIN
  │ ─ CloseChannelRequest ────────► │                                │
  │   {channelId, [SpendingAuth]}   │  no request in flight?         │
  │                                  │  no unsigned spend?            │
  │                                  │  amount = max(own, buyer's)    │
  │                                  │ ── close(SpendingAuth) ───────►│
  │ ◄── CloseChannelResult ───────── │                                │
  │   {status: closed, txHash}       │                                │
```

The buyer MAY attach its latest SpendingAuth. Attaching costs it nothing — the
cumulative is unchanged, so it authorizes no more than the seller could already
claim — but it lets a seller that never received the last auth (lost frame,
crash before persist) still close at the full amount owed. The seller settles at
`max(own last-accepted, buyer-supplied)`, so neither party can use this path to
settle below what is actually owed. A supplied auth must recover to the on-chain
channel buyer and its `metadataHash` must match its `metadata`, or the request is
rejected as `invalid_auth`.

The seller agrees only when it is **not mid-accumulation** with that buyer:

- No billable request is in flight. The seller holds the channel open for the
  whole billable span — provider call, spend recording, and the follow-up
  NeedAuth — so a close cannot land between serving a request and claiming its
  cost. Otherwise: `busy`.
- No served work is unsigned. If `spent` exceeds the highest signed cumulative,
  the seller waits briefly for a catch-up auth already on the wire; failing
  that it emits a `NeedAuth` for the outstanding amount and rejects with
  `pending_auth` plus `requiredCumulativeAmount`. The buyer signs and retries.

Rejections are normal outcomes, not errors — the channel is left untouched and
the buyer can retry or fall back to `requestTimeout()`. When neither side holds
a usable auth the seller closes at the current on-chain `settled` amount with an
empty signature, which the contract accepts without signature verification
(`finalAmount == settled`) and which claims no unproven spend.

Sellers advertise support with the `payments.cooperative-close.v1` capability in
discovery metadata and in the connection handshake. A seller predating this
protocol drops the unrecognized `0x59` frame silently, so buyers MUST check the
capability before sending and fail fast rather than waiting out the response
timeout. The check reads the peer's **discovery metadata**; the connection
handshake's remote-capability set is only populated for inbound connections and
so is empty on the buyer's own outbound connection. A buyer that has no
capability data for a peer at all SHOULD attempt the close anyway — absence of
data is not evidence of non-support.

## 2. EIP-712 Signed Messages

EIP-712 domain for both message types:

```
name:               "AntseedChannels"
version:            "7"
chainId:            <deployment chain>
verifyingContract:  <channels contract address>
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

### SpendingAuth

```
SpendingAuth(
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

The buyer signs a new SpendingAuth after each request. The seller accumulates these and submits the latest to `settle()` or `close()`. Single signature per action — no dual signatures required.

## 3. Session Budget and Budget Exhaustion

The `maxAmount` in the ReserveAuth caps total USDC the seller can charge in a session. The buyer's SpendingAuth `cumulativeAmount` must not exceed this cap.

When the budget is nearly exhausted, the seller calls `close()` with the final SpendingAuth, returns HTTP 402 to the buyer, and the buyer initiates a new session negotiation with a fresh ReserveAuth and salt.

## 4. Per-Agent Stats (AntseedStats)

Channel metrics are tracked per ERC-8004 agentId in the AntseedStats contract. Stats are updated by AntseedChannels during `settle()` and `close()`:

- `channelCount` — number of completed channels
- `totalVolumeUsdc` — cumulative USDC volume
- `totalRequests` — cumulative request count

Stats are factual counters with no reputation scoring logic. They feed into emissions and staking calculations.

## 5. Anti-Gaming Defences

| Layer | Mechanism | Default |
|---|---|---|
| Minimum deposit | Buyers must deposit at least N USDC to participate | 10 USDC |
| Minimum stake | Sellers must stake USDC bound to ERC-8004 agentId | 10 USDC |
| Budget binding | ReserveAuth binds maxAmount and deadline to buyer signature | Per-session |
| Cumulative auth | SpendingAuth cumulativeAmount is monotonically increasing | Per-request |
| Gasless buyer | Buyer never submits transactions — cannot be griefed for gas | Always |

## 6. Staking

Sellers must stake USDC via `stake(agentId, amount)` on `AntseedStaking`, binding their stake to an ERC-8004 agentId. Minimum stake: `MIN_SELLER_STAKE` (default: 10 USDC). An unstaked seller cannot have `reserve()` called — the transaction reverts.

## 7. Stats and Identity

### AntseedStats (on-chain metrics)

Factual per-agent session metrics updated by AntseedChannels during settlement. No reputation scoring — pure counters.

### ERC-8004 Identity and Feedback

Identity uses the deployed ERC-8004 IdentityRegistry (Base: `0x8004A169...`). Feedback uses the deployed ERC-8004 ReputationRegistry (Base: `0x8004BAa1...`). There is no custom AntseedIdentity contract.

### MockERC8004Registry

For local testing only. Simulates the ERC-8004 registry interface so contracts can be tested without a mainnet dependency.

## 8. Emission Distribution (ANTS Token)

### ANTS Token

ERC-20 on Base. No pre-mine. No initial supply. All ANTS distributed through verified work over 10 years.

**Phase 1 (current):** Non-transferable. `transfer()` and `transferFrom()` revert. Participants earn and claim but cannot trade. Owner calls `enableTransfers()` (one-way toggle) when the network matures.

Mint authority restricted to `AntseedEmissionsV2` contract (`setEmissionsContract()` — one-time setter).

### AntseedEmissionsV2

Deployed upgrade of the original `AntseedEmissions`. Backward-compatible with V1 by reading V1's genesis, epoch constants, and combining V1 + V2 points for the migration epoch and all earlier epochs.

- **Base mainnet address:** `0xF13bE52c4A3afC6AE29536f073588d01A0564088`
- **Genesis:** copied from V1 (`legacyEmissions.genesis()`)
- **Epoch duration / halving interval:** copied from V1

#### Epochs

Epochs advance automatically via block timestamp:

```
currentEpoch = (block.timestamp - genesis) / EPOCH_DURATION
```

No manual `advanceEpoch()` is required. Epoch parameters (share percentages and per-epoch caps) are snapshotted on first V2 touch of each epoch and remain immutable for that epoch.

#### Emission Schedule

- Epoch emission: `e_e = e_0 / 2^(epoch / HALVING_INTERVAL)` — halving every ~6 months
- Epoch duration: configurable (default 1 week, 26 epochs per halving interval)

#### Emission Split (per-epoch snapshot)

| Bucket | Default | Purpose |
|---|---|---|
| Seller share | 50% | Proven delivery (locked rewards pool until unlocked) |
| Buyer share | 20% | Rewards network usage and feedback |
| Reserve share | 15% | Protocol Reserve (network sustainability, liquidity) |
| Team share | 15% | Protocol team |

#### Points Accrual

During `settle()` / `close()`, `AntseedChannels` calls one of:

- `accrueSellerPoints(seller, pointsDelta)`
- `accrueBuyerPoints(buyer, pointsDelta)`
- `accruePoints(channelId, buyer, seller, pointsDelta)` — optional pair-aware hook for future channels

For epochs `<= MIGRATION_EPOCH`, V1 points are combined with V2 points on claim. For later epochs, only V2 points are used.

#### Points Policy Hook

`AntseedUsageAccounting` exposes one `IAntseedPointsPolicy` hook. New deployments set that hook to an owned `AntseedPointsPolicyRegistry`, which contains at most eight `IAntseedPointsPenaltyPolicy` contracts. Each registered policy declares a nonzero penalty category and independently returns seller and buyer penalties between 0 and 10,000 basis points for the original settled usage.

Policies in the same category may describe overlapping evidence, so only the largest seller and buyer penalty in each category applies. Category maxima are added across categories. Ordinary combined penalties saturate at 9,000 BPS, preserving 10% of raw points; a single 10,000-BPS result is an explicit hard veto for that side and reduces its points to zero. The final penalty is applied once to raw points, making results independent of registration order and preventing policies from amplifying points. An empty registry passes raw points through unchanged.

Registration validates the policy's category, and each evaluation call has a 100,000 gas allowance. If any policy reverts, exhausts its allowance, lacks the expected selector, returns malformed data, or reports a penalty above 10,000 BPS, the registry fails the complete evaluation. Usage accounting catches that failure, emits `PointsPolicyFailed`, and records zero points for both sides without reverting channel settlement.

`AntseedWashTradingRegistry` accepts one pinned RISC Zero seller-penalty proof. The guest authenticates a seller-to-funder USDC path, funding of at least three distinct buyers, and at least 1,000 USDC of authentic `ChannelSettled` volume occurring after each buyer's funding. It pins Base chain ID and the USDC, Channels, and Deposits addresses, rejects duplicate log references, and commits every referenced Base block number and hash.

The proof is deliberately not a complete P0/P1 analysis. Enforcement uses only monotonic positive evidence: omitting evidence can only reduce the proven buyer count or volume and therefore make a penalty harder to obtain. It cannot create an unsupported penalty. For this reason the enforcement path has no candidate lifecycle, findings root, challenge period, fraud proof, watcher dependency, buyer finding, or finding-materialization step. Full P0/P1 scans remain reporting-only.

After the verifier accepts the receipt, `IBaseAnalysisStateOracle` must authenticate every referenced historical Base block from finalized OP Stack/L1 commitments. An RPC response is not production-safe, EVM `blockhash()` reaches only 256 blocks, and a keeper cannot authenticate historical blocks it did not checkpoint. A valid proof sets a fixed 9,000-BPS reduction for the seller's future points. Buyer points and existing locked rewards are unchanged; there is no clawback or confiscation.

Operators first run `DeployWashTradingEnforcement.s.sol` with the RISC Zero verifier, finalized Base state oracle, and seller-penalty guest image ID. They then run `RegisterWashTradingPointsPolicy.s.sol` with the deployed proof registry and points-policy registry.

#### Per-Epoch Pro-Rata Distribution

Claiming computes rewards per finalized epoch:

```
sellerBudget = epochEmission * sellerSharePct / 100
sellerReward = (userSellerPoints / epochTotalSellerPoints) * sellerBudget

buyerBudget  = epochEmission * buyerSharePct / 100
buyerReward  = (userBuyerPoints / epochTotalBuyerPoints) * buyerBudget
```

#### Per-Epoch Caps

- **Seller cap:** `maxSellerSharePct` (default 50% of the seller bucket). Excess redirected to reserve.
- **Buyer cap:** `maxBuyerSharePct` (default 5% of the buyer bucket). Excess redirected to reserve.

#### Seller Claiming

Sellers call `claimSellerEmissions(epochs[])` for finalized epochs.

If `sellerUnlockPolicy.canClaimSellerUnlocked(seller)` returns true, ANTS are minted directly to the seller.

If the policy returns false (or is not set), ANTS are minted to `AntseedSellerRewardsPool` and recorded as locked for that seller. They remain locked until the unlock policy later allows release.

#### Buyer Claiming

Anyone can call `claimBuyerEmissions(buyer, epochs[])` provided `msg.sender == Deposits.getOperator(buyer)`. Reward is minted to `msg.sender`.

#### Reserve & Team

Reserve and team shares accumulate in the contract until flushed by owner:

- `flushReserve()` — mints accumulated reserve ANTS to `registry.protocolReserve()`
- `flushTeam()` — mints accumulated team ANTS to `registry.teamWallet()`

### Legacy V1 Backward Compatibility

`AntseedEmissionsV2` reads the legacy `AntseedEmissions` contract for:

- `genesis`, `EPOCH_DURATION`, `HALVING_INTERVAL`, `INITIAL_EMISSION`
- Claimed state for epochs `< MIGRATION_EPOCH`
- User points and total points for epochs `<= MIGRATION_EPOCH`

This ensures sellers and buyers do not lose historical points during the upgrade.

## 9. Contract Architecture

```
ANTSToken (ERC-20)              ── mint restricted to AntseedEmissionsV2
AntseedDeposits                 ── buyer USDC deposits, holds ALL buyer USDC
AntseedChannels                 ── Reserve→Settle/Close lifecycle (holds NO USDC, swappable)
AntseedStaking                  ── seller stake bound to ERC-8004 agentId
AntseedStats                    ── factual per-agent session metrics
AntseedEmissionsV2              ── USDC volume-based epoch emissions (backward-compatible with V1)
AntseedSellerRewardsPool        ── holds locked ANTS for sellers pending unlock policy
AntseedSellerUnlockPolicy       ── on-chain policy determining if seller can claim unlocked
MockERC8004Registry             ── local testing only (mainnet: deployed ERC-8004)
```

Contracts reference each other by address (set at deployment, updateable by owner). No inheritance between contracts — only interface calls.

**Interaction flow:**
- `AntseedChannels` calls `AntseedDeposits.lockForChannel()` on reserve
- `AntseedChannels` calls `AntseedDeposits.chargeAndCreditPayouts()` on settle/close
- `AntseedChannels` calls `AntseedStats.updateStats()` on settle/close
- `AntseedChannels` calls `AntseedEmissionsV2.accrueSellerPoints()` / `accrueBuyerPoints()` on settle/close
- `AntseedChannels` reads from `AntseedStaking` (seller stake verification)
- `AntseedEmissionsV2` calls `ANTSToken.mint()` on claim

## 11. P2P Messages

Payment messages occupy `0x50-0x5F`. Payloads are UTF-8 JSON capped at 64 KiB;
uint256 values are decimal strings, and receivers MUST validate every field —
payloads are untrusted peer input.

| Type | Name | Direction | Description |
|---|---|---|---|
| 0x50 | `SpendingAuth` | Buyer → Seller | EIP-712 signed cumulative spending authorization (carries the opening ReserveAuth on the first send) |
| 0x51 | `AuthAck` | Seller → Buyer | Reservation confirmed |
| 0x52 | `FreeUsageOpen` | Buyer → Seller | Open a zero-price usage channel |
| 0x53 | `FreeUsageAuth` | Buyer → Seller | Signed cumulative zero-price usage record |
| 0x54 | `FreeUsageAck` | Seller → Buyer | Zero-price open/record accepted |
| 0x55 | `NeedFreeUsageAuth` | Seller → Buyer | Request a zero-price usage signature |
| 0x56 | `PaymentRequired` | Seller → Buyer | Payment terms accompanying an HTTP 402 |
| 0x58 | `NeedAuth` | Seller → Buyer | Per-request cost report + required cumulative |
| 0x59 | `CloseChannelRequest` | Buyer → Seller | Ask the seller to close the channel now (§1) |
| 0x5A | `CloseChannelResult` | Seller → Buyer | Close verdict: `closed` + txHash, or `rejected` + code |

`CloseChannelResult` rejection codes: `busy`, `pending_auth`, `no_channel`,
`invalid_auth`, `close_failed`, `unsupported`.

## 12. Session Persistence

Session state is persisted to SQLite in the node SDK. Schema:

- `sessions` table: channel_id, peer_id, role, EVM addresses, salt, max_amount, deadline, cumulative_amount, request_count, timestamps, status
- `receipts` table: channel_id, cumulative_amount, request_count, metadata_hash, seller_sig, buyer_spending_auth_sig, timestamp

## 13. Supported Chains

| Chain ID | Network | Purpose |
|---|---|---|
| `base-sepolia` | Base Sepolia testnet | Testing and development |
| `base-mainnet` | Base mainnet | Production |
