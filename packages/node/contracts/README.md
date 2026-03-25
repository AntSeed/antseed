# AntSeed Smart Contracts

Five Solidity contracts implementing the Proof of Prior Delivery payment, identity, emission, and subscription system.

## Contract Architecture

```
ANTSToken (ERC-20)        ── phase-locked transfers, mint restricted to AntseedEmissions
AntseedIdentity (ERC-721) ── soulbound peer identity, dual lookup, reputation, ERC-8004 feedback
AntseedDeposits           ── buyer USDC deposits, credit limits, withdrawal timelock
AntseedSessions           ── Reserve→Settle, proof chain, anti-gaming
AntseedStaking            ── seller stake, slashing conditions
AntseedEmissions          ── epoch halving, Synthetix reward-per-point, 65/25/10 split
AntseedSubPool            ── subscription tiers, daily budgets, revenue distribution
```

Contracts reference each other by address set at deployment. No inheritance — only interface calls.

```
AntseedSessions ──calls──► AntseedIdentity.updateReputation()
AntseedSessions ──calls──► AntseedEmissions.accrueSellerPoints() / accrueBuyerPoints()
AntseedSessions ──reads──► AntseedDeposits (buyer balances) + AntseedStaking (seller stake)
AntseedEmissions ──calls──► ANTSToken.mint()
AntseedSubPool ──reads──► AntseedIdentity (reputation) + AntseedSessions (proven stats)
```

## Build

```bash
cd packages/node
forge build
```

Requires [Foundry](https://getfoundry.sh/) and OpenZeppelin contracts (installed via `forge install`).

## Test

```bash
cd packages/node
forge test
```

Expected: 173 tests across 6 test files.

| Test File | Tests |
|---|---|
| `ANTSToken.t.sol` | 19 |
| `AntseedIdentity.t.sol` | 15 |
| `AntseedIdentityReputation.t.sol` | 18 |
| `AntseedSessions.t.sol` | 58 |
| `AntseedSubPool.t.sol` | 41 |
| `AntseedEmissions.t.sol` | 22 |

## Contracts

### ANTSToken.sol

ERC-20 token (`AntSeed` / `ANTS`). No pre-mine, no initial supply.

- `mint(address to, uint256 amount)` — restricted to emissions contract
- `setEmissionsContract(address)` — owner-only, one-time setter
- `enableTransfers()` — owner-only, one-way toggle (Phase 1: transfers disabled)
- `transferOwnership(address)` — transfer owner role
- `_update()` override — reverts on transfer/transferFrom unless `transfersEnabled == true` (mint/burn always allowed)

### AntseedIdentity.sol

Soulbound ERC-721 with dual lookup and two reputation layers.

**Identity:**
- `register(bytes32 peerId, string metadataURI)` — mints non-transferable NFT to caller
- `updateMetadata(uint256 tokenId, string metadataURI)` — token owner only
- `deregister(uint256 tokenId)` — burns NFT, requires zero active stake
- `_update()` override — reverts on transfer (mint/burn allowed)
- Dual lookup: `addressToTokenId` + `peerIdToTokenId`
- Views: `isRegistered(address)`, `getTokenId(address)`, `getTokenIdByPeerId(bytes32)`, `getPeerId(uint256)`

**Custom Reputation (updated by AntseedSessions):**
- `updateReputation(uint256 tokenId, ReputationUpdate calldata)` — restricted to sessions contract
- `getReputation(uint256 tokenId)` → `ProvenReputation`
- `setSessionsContract(address)` — owner-only, authorizes caller
- Fields: `firstSignCount`, `qualifiedProvenSignCount`, `unqualifiedProvenSignCount`, `ghostCount`, `totalQualifiedTokenVolume`, `lastProvenAt`

**ERC-8004 Feedback Registry:**
- `giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, bytes32 tag1, bytes32 tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)`
- `getSummary(uint256 agentId, address client, bytes32 tag)` → count, summaryValue, summaryValueDecimals
- `readFeedback(uint256 agentId, address client, uint256 index)` → FeedbackEntry
- `revokeFeedback(uint256 agentId, uint256 index)` — submitter only

### AntseedDeposits.sol

Buyer USDC deposit management with dynamic credit limits and withdrawal timelock.

**Buyer operations:**
- `deposit(uint256 amount)` — USDC deposit, enforces `MIN_BUYER_DEPOSIT` and dynamic credit limit
- `requestWithdrawal(uint256 amount)` — starts inactivity timer
- `executeWithdrawal()` — after `BUYER_INACTIVITY_PERIOD` of no activity
- `cancelWithdrawal()`
- `getBuyerBalance(address)` → available, reserved, pendingWithdrawal
- `setCreditLimitOverride(address, uint256)` — owner overrides buyer limit

### AntseedSessions.sol

Session lifecycle with EIP-712 spending authorizations, proof chain, and anti-gaming.

**Seller operations:**
- `reserve(SpendingAuth calldata auth, bytes calldata buyerSig)` — validates EIP-712 sig, classifies sign type, locks buyer credits, updates reputation
- `settle(bytes32 sessionId, uint256 tokenCount)` — charges actual consumption, deducts platform fee, releases remainder
- `settleTimeout(bytes32 sessionId)` — after `SETTLE_TIMEOUT` (24h), returns credits to buyer, records ghost
- `claimEarnings()` — withdraw accumulated earnings

**EIP-712 SpendingAuth type:**
```
SpendingAuth(address seller, bytes32 sessionId, uint256 maxAmount, uint256 nonce,
             uint256 deadline, uint256 previousConsumption, bytes32 previousSessionId)
```

**Owner functions:**
- `setConstant(bytes32 key, uint256 value)` — update any configurable constant
- `setPlatformFee(uint256 bps)` — capped at `MAX_PLATFORM_FEE_BPS`
- `setProtocolReserve(address)` — slashed funds destination
- `pause()` / `unpause()` — emergency circuit breaker

### AntseedStaking.sol

Seller USDC staking with 5-tier slash conditions.

- `stake(uint256 amount)` — locks USDC, requires registered AntseedIdentity
- `unstake()` — runs 5-tier slash check, returns `stake - slashAmount`

### AntseedSubPool.sol

Subscription management with daily budgets and epoch-based revenue distribution.

- `subscribe(uint256 tier)` — pay monthly fee in USDC
- `cancelSubscription()` — stops at end of current period
- `setTier(uint256 tierId, uint256 monthlyFee, uint256 dailyTokenBudget)` — owner
- `optIn(uint256 tokenId)` — peer opts in (requires AntseedIdentity)
- `optOut(uint256 tokenId)` — peer opts out
- `claimRevenue(uint256 tokenId)` — claim share proportional to proven reputation
- `distributionEpoch()` — callable by anyone, distributes current epoch revenue

Reads from AntseedIdentity (reputation weighting) and AntseedSessions (delivery verification).

### AntseedEmissions.sol

ANTS emission controller using the Synthetix reward-per-point pattern. O(1) gas per interaction.

**Epoch management:**
- `advanceEpoch()` — callable by anyone when `EPOCH_DURATION` has passed
- `getEpochInfo()` → current epoch, emission amount, time remaining

**Point accrual (restricted to AntseedSessions):**
- `accrueSellerPoints(address seller, uint256 pointsDelta)`
- `accrueBuyerPoints(address buyer, uint256 pointsDelta)`

**Claiming:**
- `claimEmissions()` — mints accrued ANTS. 15% per-seller cap, excess to reserve
- `pendingEmissions(address)` → ANTS available to claim

**Reserve:**
- `setReserveDestination(address)` — owner-only
- `flushReserve()` — sends accumulated reserve to destination

## Deployment Order

1. **AntseedIdentity** — deploy first (no dependencies)
2. **ANTSToken** — deploy (no dependencies)
3. **AntseedDeposits** — deploy with `(usdcAddress)`
4. **AntseedStaking** — deploy with `(usdcAddress, identityAddress)`
5. **AntseedSessions** — deploy with `(usdcAddress, identityAddress, depositsAddress, stakingAddress)`, then call `identity.setSessionsContract(sessions)`
6. **AntseedEmissions** — deploy with `(antsTokenAddress, sessionsAddress)`, then call `antsToken.setEmissionsContract(emissions)` and `sessions.setEmissionsContract(emissions)`
7. **AntseedSubPool** — deploy with `(usdcAddress, identityAddress, sessionsAddress)`, then optionally set as reserve destination on emissions

## Configuration

All constants are configurable by the contract owner via `setConstant()` or dedicated setters.

### AntseedDeposits / AntseedSessions / AntseedStaking

| Constant | Default | Description |
|---|---|---|
| `FIRST_SIGN_CAP` | 1 USDC | Max auth amount for first-sign sessions |
| `MIN_BUYER_DEPOSIT` | 10 USDC | Minimum deposit to participate |
| `MIN_SELLER_STAKE` | 10 USDC | Minimum stake to accept sessions |
| `MIN_TOKEN_THRESHOLD` | 1000 | Minimum previousConsumption for proven sign |
| `BUYER_DIVERSITY_THRESHOLD` | 3 | Unique sellers needed for qualified proven sign |
| `PROVEN_SIGN_COOLDOWN` | 7 days | Time between first session and proven sign per pair |
| `BUYER_INACTIVITY_PERIOD` | 90 days | Inactivity period before balance lock |
| `SETTLE_TIMEOUT` | 24 hours | Time before seller can call settleTimeout |
| `REPUTATION_CAP_COEFFICIENT` | 20 | k in `min(provenSigns, stake * k)` |
| `SLASH_RATIO_THRESHOLD` | 30 | Qualified proven ratio below which 50% slash applies |
| `SLASH_GHOST_THRESHOLD` | 5 | Ghost count triggering 100% slash |
| `SLASH_INACTIVITY_DAYS` | 30 days | Inactivity window for 20% stale slash |
| `PLATFORM_FEE_BPS` | 500 (5%) | Platform fee in basis points |
| `MAX_PLATFORM_FEE_BPS` | 1000 (10%) | Maximum platform fee |
| `BASE_CREDIT_LIMIT` | 10 USDC | Starting buyer credit limit |
| `PEER_INTERACTION_BONUS` | 5 USDC | Credit limit increase per unique seller |
| `TIME_BONUS` | 0.5 USDC | Credit limit increase per day since first session |
| `PROVEN_SESSION_BONUS` | 10 USDC | Credit limit increase per proven buy |
| `FEEDBACK_BONUS` | 2 USDC | Credit limit increase per feedback submitted |
| `MAX_CREDIT_LIMIT` | 500 USDC | Hard cap on buyer credit limit |

### AntseedEmissions

| Constant | Default | Description |
|---|---|---|
| `EPOCH_DURATION` | 1 week | Duration of each emission epoch |
| `HALVING_INTERVAL` | 26 epochs (~6 months) | Epochs between emission halvings |
| `INITIAL_EMISSION` | Set at deployment | Total ANTS emitted in epoch 0 |
| `SELLER_SHARE_PCT` | 65% | Seller share of epoch emissions |
| `BUYER_SHARE_PCT` | 25% | Buyer share of epoch emissions |
| `RESERVE_SHARE_PCT` | 10% | Reserve share of epoch emissions |
| `MAX_SELLER_SHARE_PCT` | 15% | Per-seller cap of seller pool |

### Supported Chains

| Network | Purpose |
|---|---|
| Base Sepolia | Testnet deployment |
| Base Mainnet | Production deployment |
