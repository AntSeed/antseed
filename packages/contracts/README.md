# AntSeed Smart Contracts

Solidity contracts implementing the streaming payment, staking, stats, emission, and subscription system.

## Contract Architecture

```
ANTSToken (ERC-20)          ── phase-locked transfers, mint restricted to AntseedEmissions
AntseedDeposits             ── buyer USDC deposits, holds ALL buyer USDC
AntseedChannels             ── Reserve→Settle/Close lifecycle, EIP-712 (swappable, holds NO USDC)
AntseedStaking              ── seller stake bound to ERC-8004 agentId
AntseedStats                ── factual per-agent session metrics (sessionCount, volume, requests)
AntseedEmissions            ── USDC volume-based epoch emissions
AntseedSubPool              ── subscription tiers, daily budgets, revenue distribution
MockERC8004Registry         ── mock ERC-8004 IdentityRegistry (local testing only)
```

Identity uses the deployed ERC-8004 IdentityRegistry (Base: `0x8004A169...`).
Feedback uses the deployed ERC-8004 ReputationRegistry (Base: `0x8004BAa1...`).

Contracts reference each other by address set at deployment. No inheritance — only interface calls.

```
AntseedChannels ──calls──► AntseedDeposits.lockForSession() (on reserve)
AntseedChannels ──calls──► AntseedDeposits.chargeAndCreditEarnings() (on settle/close)
AntseedChannels ──calls──► AntseedStats.updateStats() (on settle/close)
AntseedChannels ──calls──► AntseedEmissions.accrueSellerPoints() / accrueBuyerPoints()
AntseedChannels ──reads──► AntseedStaking (seller stake verification)
AntseedEmissions ──calls──► ANTSToken.mint()
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

## Contracts

### ANTSToken.sol

ERC-20 token (`AntSeed` / `ANTS`). No pre-mine, no initial supply.

- `mint(address to, uint256 amount)` — restricted to emissions contract
- `setEmissionsContract(address)` — owner-only, one-time setter
- `enableTransfers()` — owner-only, one-way toggle (Phase 1: transfers disabled)
- `transferOwnership(address)` — transfer owner role
- `_update()` override — reverts on transfer/transferFrom unless `transfersEnabled == true` (mint/burn always allowed)

### AntseedDeposits.sol

Buyer USDC deposit management with dynamic credit limits and withdrawal timelock.

**Buyer operations:**
- `deposit(uint256 amount)` — USDC deposit, enforces `MIN_BUYER_DEPOSIT` and dynamic credit limit
- `requestWithdrawal(uint256 amount)` — starts inactivity timer
- `executeWithdrawal()` — after `BUYER_INACTIVITY_PERIOD` of no activity
- `cancelWithdrawal()`
- `getBuyerBalance(address)` → available, reserved, pendingWithdrawal
- `setCreditLimitOverride(address, uint256)` — owner overrides buyer limit

### AntseedChannels.sol

Session lifecycle with EIP-712 ReserveAuth + SpendingAuth. Holds NO USDC — all funds stay in AntseedDeposits. Swappable: can be redeployed by re-pointing stable contracts.

**Seller operations:**
- `reserve(address buyer, bytes32 salt, uint128 maxAmount, uint256 deadline, bytes calldata buyerSig)` — validates ReserveAuth EIP-712 sig, calls Deposits.lockForSession()
- `settle(bytes32 channelId, uint128 amount, bytes32 metadataHash, bytes calldata buyerSig)` — validates SpendingAuth, calls Deposits.chargeAndCreditEarnings(), session stays open
- `close(bytes32 channelId, uint128 amount, bytes32 metadataHash, bytes calldata buyerSig)` — like settle but finalizes session, releases remaining lock

**Timeout (permissionless):**
- `requestTimeout(bytes32 channelId)` — after deadline, marks session timed out
- `withdraw(bytes32 channelId)` — after 15min grace, releases locked funds to buyer

**EIP-712 types (domain: name="AntseedChannels", version="7"):**
```
ReserveAuth(bytes32 channelId, uint128 maxAmount, uint256 deadline)
SpendingAuth(bytes32 channelId, uint256 cumulativeAmount, bytes32 metadataHash)
```

channelId = keccak256(abi.encode(buyer, seller, salt))

**Owner functions:**
- `pause()` / `unpause()` — emergency circuit breaker

### AntseedStats.sol

Factual per-agent session metrics keyed by ERC-8004 agentId. Updated by AntseedChannels during settlement.

- `updateStats(uint256 agentId, StatsUpdate calldata)` — restricted to channels contract
- `getStats(uint256 agentId)` — returns sessionCount, totalVolumeUsdc, totalRequests

### AntseedStaking.sol

Seller USDC staking bound to ERC-8004 agentId.

- `stake(uint256 agentId, uint256 amount)` — locks USDC, binds to agentId
- `unstake(uint256 agentId)` — returns stake

### AntseedSubPool.sol

Subscription management with daily budgets and epoch-based revenue distribution.

- `subscribe(uint256 tier)` — pay monthly fee in USDC
- `cancelSubscription()` — stops at end of current period
- `setTier(uint256 tierId, uint256 monthlyFee, uint256 dailyTokenBudget)` — owner
- `optIn(uint256 agentId)` — peer opts in (requires ERC-8004 agentId)
- `optOut(uint256 agentId)` — peer opts out
- `claimRevenue(uint256 agentId)` — claim share proportional to stats
- `distributionEpoch()` — callable by anyone, distributes current epoch revenue

Reads from AntseedStats (delivery metrics) and AntseedChannels (session verification).

### AntseedEmissions.sol

ANTS emission controller using the Synthetix reward-per-point pattern. O(1) gas per interaction.

**Epoch management:**
- `advanceEpoch()` — callable by anyone when `EPOCH_DURATION` has passed
- `getEpochInfo()` → current epoch, emission amount, time remaining

**Point accrual (restricted to AntseedChannels):**
- `accrueSellerPoints(address seller, uint256 pointsDelta)`
- `accrueBuyerPoints(address buyer, uint256 pointsDelta)`

**Claiming:**
- `claimEmissions()` — mints accrued ANTS. 15% per-seller cap, excess to reserve
- `pendingEmissions(address)` → ANTS available to claim

**Reserve:**
- `setReserveDestination(address)` — owner-only
- `flushReserve()` — sends accumulated reserve to destination

## Deployment Order

1. **ANTSToken** — deploy (no dependencies)
2. **MockERC8004Registry** — deploy for local testing (on mainnet use deployed ERC-8004)
3. **AntseedDeposits** — deploy with `(usdcAddress)`
4. **AntseedStaking** — deploy with `(usdcAddress, registryAddress)`
5. **AntseedStats** — deploy, then set channels contract
6. **AntseedChannels** — deploy with `(depositsAddress, stakingAddress, statsAddress)`, then authorize on Deposits and Stats
7. **AntseedEmissions** — deploy with `(antsTokenAddress, channelsAddress)`, then call `antsToken.setEmissionsContract(emissions)`
8. **AntseedSubPool** — deploy with `(usdcAddress, statsAddress, channelsAddress)`

## Configuration

All constants are configurable by the contract owner via dedicated setter functions (e.g., `setFirstSignCap()`, `setWithdrawalDelay()`).

### AntseedDeposits / AntseedChannels / AntseedStaking

| Constant | Default | Description |
|---|---|---|
| `MIN_BUYER_DEPOSIT` | 10 USDC | Minimum deposit to participate |
| `MIN_SELLER_STAKE` | 10 USDC | Minimum stake to accept sessions |
| `TIMEOUT_GRACE_PERIOD` | 15 min | Grace period after requestTimeout before withdraw |
| `PLATFORM_FEE_BPS` | 500 (5%) | Platform fee in basis points |
| `MAX_PLATFORM_FEE_BPS` | 1000 (10%) | Maximum platform fee |

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
