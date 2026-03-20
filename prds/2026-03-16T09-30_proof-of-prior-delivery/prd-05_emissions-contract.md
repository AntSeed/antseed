# PRD-05: Emissions Contract

**Created:** 2026-03-16T10:50Z
**Depends On:** PRD-01, PRD-02
**Estimated Tasks:** 8

---

## Overview

ANTS token emission controller using the Synthetix reward-per-point pattern. Epoch-based emission with halving, O(1) gas per interaction, configurable seller/buyer/reserve split. Foundry tests and TypeScript client.

---

## Task 1: AntseedEmissions contract — core state and epoch management

##### CREATE: `packages/node/contracts/AntseedEmissions.sol`

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IANTSToken { function mint(address to, uint256 amount) external; }
interface IAntseedIdentity { function getSummary(uint256 agentId, bytes32 tag) external view returns (uint256, int256, uint8); }

contract AntseedEmissions {
    // ─── Configuration (all owner-settable) ───
    address public owner;
    IANTSToken public antsToken;
    address public escrowContract;            // authorized to accrue points
    address public identityContract;
    address public reserveDestination;

    uint256 public EPOCH_DURATION;            // default 1 weeks
    uint256 public HALVING_INTERVAL;          // default 26 (epochs)
    uint256 public INITIAL_EMISSION;          // set at deployment (18 decimals)
    uint256 public SELLER_SHARE_PCT;          // default 65
    uint256 public BUYER_SHARE_PCT;           // default 25
    uint256 public RESERVE_SHARE_PCT;         // default 10
    uint256 public MAX_SELLER_SHARE_PCT;      // default 15 (of seller pool per seller)

    // Feedback multiplier tiers (configurable)
    int256 public FEEDBACK_TIER_1_THRESHOLD;  // default -50
    int256 public FEEDBACK_TIER_2_THRESHOLD;  // default 0
    int256 public FEEDBACK_TIER_4_THRESHOLD;  // default 50
    int256 public FEEDBACK_TIER_5_THRESHOLD;  // default 80
    uint256 public FEEDBACK_MULT_1;           // default 5000  (0.5x, basis 10000)
    uint256 public FEEDBACK_MULT_2;           // default 7500  (0.75x)
    uint256 public FEEDBACK_MULT_3;           // default 10000 (1.0x)
    uint256 public FEEDBACK_MULT_4;           // default 12500 (1.25x)
    uint256 public FEEDBACK_MULT_5;           // default 15000 (1.5x)

    uint256 public FEEDBACK_WEIGHT;           // buyer points per feedback submission
    uint256 public BASE_DIVERSITY;            // default 3
    uint256 public MAX_DIVERSITY_MULT;        // default 20000 (2x, basis 10000)

    // ─── Epoch State ───
    uint256 public currentEpoch;
    uint256 public epochStart;
    uint256 public currentEmissionRate;       // tokens per second for current epoch

    // ─── Seller Reward Accumulator (Synthetix pattern) ───
    uint256 public sellerRewardPerPointStored;
    uint256 public totalSellerPoints;
    uint256 public sellerLastUpdateTime;

    struct SellerReward {
        uint256 points;
        uint256 rewardPerPointPaid;
        uint256 pendingReward;
    }
    mapping(address => SellerReward) public sellerRewards;

    // ─── Buyer Reward Accumulator ───
    uint256 public buyerRewardPerPointStored;
    uint256 public totalBuyerPoints;
    uint256 public buyerLastUpdateTime;

    struct BuyerReward {
        uint256 points;
        uint256 rewardPerPointPaid;
        uint256 pendingReward;
    }
    mapping(address => BuyerReward) public buyerRewards;

    // ─── Reserve ───
    uint256 public reserveAccumulated;

    // ─── Events ───
    event EpochAdvanced(uint256 indexed epoch, uint256 emission);
    event SellerPointsAccrued(address indexed seller, uint256 pointsDelta);
    event BuyerPointsAccrued(address indexed buyer, uint256 pointsDelta);
    event EmissionsClaimed(address indexed claimer, uint256 amount);
    event ReserveFlushed(address indexed destination, uint256 amount);
}
```

**Implement constructor:**
```solidity
constructor(address _antsToken, uint256 _initialEmission, uint256 _epochDuration) {
    owner = msg.sender;
    antsToken = IANTSToken(_antsToken);
    INITIAL_EMISSION = _initialEmission;
    EPOCH_DURATION = _epochDuration;
    epochStart = block.timestamp;
    // Set defaults for all configurable params
    // Calculate initial emission rate
    currentEmissionRate = _calcEmissionRate(0);
    sellerLastUpdateTime = block.timestamp;
    buyerLastUpdateTime = block.timestamp;
}
```

**Implement `advanceEpoch()`:**
```solidity
function advanceEpoch() external {
    require(block.timestamp >= epochStart + EPOCH_DURATION, "Epoch not ended");
    _updateSellerReward();
    _updateBuyerReward();
    // Accumulate reserve for this epoch
    uint256 epochEmission = _calcEpochEmission(currentEpoch);
    reserveAccumulated += (epochEmission * RESERVE_SHARE_PCT) / 100;
    currentEpoch++;
    currentEmissionRate = _calcEmissionRate(currentEpoch);
    epochStart = block.timestamp;
    emit EpochAdvanced(currentEpoch, _calcEpochEmission(currentEpoch));
}

function _calcEpochEmission(uint256 epoch) internal view returns (uint256) {
    return INITIAL_EMISSION >> (epoch / HALVING_INTERVAL); // divide by 2^(epoch/interval)
}

function _calcEmissionRate(uint256 epoch) internal view returns (uint256) {
    return _calcEpochEmission(epoch) / EPOCH_DURATION; // tokens per second
}
```

#### Acceptance Criteria
- [ ] `forge build` compiles
- [ ] Epoch advances correctly
- [ ] Emission halves at correct intervals
- [ ] Reserve accumulates per epoch

---

## Task 2: AntseedEmissions — Synthetix reward accumulators

##### MODIFY: `packages/node/contracts/AntseedEmissions.sol`

**Implement seller reward accumulator:**
```solidity
function _updateSellerReward() internal {
    if (totalSellerPoints > 0) {
        uint256 elapsed = block.timestamp - sellerLastUpdateTime;
        uint256 sellerEmissionRate = (currentEmissionRate * SELLER_SHARE_PCT) / 100;
        sellerRewardPerPointStored += (sellerEmissionRate * elapsed * 1e18) / totalSellerPoints;
    }
    sellerLastUpdateTime = block.timestamp;
}

function _updateSellerAccount(address seller) internal {
    _updateSellerReward();
    SellerReward storage sr = sellerRewards[seller];
    sr.pendingReward += (sr.points * (sellerRewardPerPointStored - sr.rewardPerPointPaid)) / 1e18;
    sr.rewardPerPointPaid = sellerRewardPerPointStored;
}

function accrueSellerPoints(address seller, uint256 pointsDelta) external {
    require(msg.sender == escrowContract, "Not authorized");
    _updateSellerAccount(seller);
    sellerRewards[seller].points += pointsDelta;
    totalSellerPoints += pointsDelta;
    emit SellerPointsAccrued(seller, pointsDelta);
}
```

**Same pattern for buyer:**
```solidity
function _updateBuyerReward() internal { /* same as seller with BUYER_SHARE_PCT */ }
function _updateBuyerAccount(address buyer) internal { /* same pattern */ }
function accrueBuyerPoints(address buyer, uint256 pointsDelta) external {
    require(msg.sender == escrowContract, "Not authorized");
    _updateBuyerAccount(buyer);
    buyerRewards[buyer].points += pointsDelta;
    totalBuyerPoints += pointsDelta;
    emit BuyerPointsAccrued(buyer, pointsDelta);
}
```

#### Acceptance Criteria
- [ ] Reward-per-point accumulator updates correctly
- [ ] Points from different sellers tracked independently
- [ ] O(1) gas per accrual (no loops)

---

## Task 3: AntseedEmissions — claiming and reserve

##### MODIFY: `packages/node/contracts/AntseedEmissions.sol`

```solidity
function claimEmissions() external {
    _updateSellerAccount(msg.sender);
    _updateBuyerAccount(msg.sender);
    uint256 sellerReward = sellerRewards[msg.sender].pendingReward;
    uint256 buyerReward = buyerRewards[msg.sender].pendingReward;

    // Enforce 15% per-seller cap
    uint256 maxSellerReward = (_calcEpochEmission(currentEpoch) * SELLER_SHARE_PCT * MAX_SELLER_SHARE_PCT) / 10000;
    if (sellerReward > maxSellerReward) {
        uint256 excess = sellerReward - maxSellerReward;
        sellerReward = maxSellerReward;
        reserveAccumulated += excess;
    }

    uint256 total = sellerReward + buyerReward;
    if (total == 0) return;

    sellerRewards[msg.sender].pendingReward = 0;
    buyerRewards[msg.sender].pendingReward = 0;

    antsToken.mint(msg.sender, total);
    emit EmissionsClaimed(msg.sender, total);
}

function pendingEmissions(address account) external view returns (uint256 seller, uint256 buyer) {
    // Calculate without mutating state (view-safe)
    SellerReward memory sr = sellerRewards[account];
    uint256 sellerRPP = sellerRewardPerPointStored;
    if (totalSellerPoints > 0) {
        uint256 elapsed = block.timestamp - sellerLastUpdateTime;
        uint256 sellerEmRate = (currentEmissionRate * SELLER_SHARE_PCT) / 100;
        sellerRPP += (sellerEmRate * elapsed * 1e18) / totalSellerPoints;
    }
    seller = sr.pendingReward + (sr.points * (sellerRPP - sr.rewardPerPointPaid)) / 1e18;

    // Same for buyer
    BuyerReward memory br = buyerRewards[account];
    uint256 buyerRPP = buyerRewardPerPointStored;
    if (totalBuyerPoints > 0) {
        uint256 elapsed = block.timestamp - buyerLastUpdateTime;
        uint256 buyerEmRate = (currentEmissionRate * BUYER_SHARE_PCT) / 100;
        buyerRPP += (buyerEmRate * elapsed * 1e18) / totalBuyerPoints;
    }
    buyer = br.pendingReward + (br.points * (buyerRPP - br.rewardPerPointPaid)) / 1e18;
}

function setReserveDestination(address _dest) external onlyOwner {
    reserveDestination = _dest;
}

function flushReserve() external {
    require(reserveDestination != address(0), "No destination");
    uint256 amount = reserveAccumulated;
    reserveAccumulated = 0;
    antsToken.mint(reserveDestination, amount);
    emit ReserveFlushed(reserveDestination, amount);
}
```

**Admin functions:**
- `setConstant(bytes32 key, uint256 value)` — for all configurable params
- `setEscrowContract(address)`, `setIdentityContract(address)` — owner only
- Validate SELLER_SHARE_PCT + BUYER_SHARE_PCT + RESERVE_SHARE_PCT == 100

#### Acceptance Criteria
- [ ] Claiming mints correct ANTS amount
- [ ] 15% per-seller cap enforced, excess goes to reserve
- [ ] pendingEmissions() view matches actual claim amount
- [ ] Reserve flushable to destination
- [ ] Share percentages must sum to 100

---

## Task 4: AntseedEmissions Foundry tests — epoch and halving

##### CREATE: `packages/node/contracts/test/AntseedEmissions.t.sol`

**Setup:** Deploy ANTSToken, set emissions contract on token, deploy AntseedEmissions.

**Tests:**
- **test_initialState:** Epoch 0, correct emission rate
- **test_advanceEpoch:** Epoch increments, emission rate updates
- **test_advanceEpoch_revert_tooEarly:** Before epoch duration reverts
- **test_halvingSchedule:** After HALVING_INTERVAL epochs, emission halves
- **test_multipleHalvings:** Verify emission curve across 4 halvings
- **test_totalSupplyConverges:** After many epochs, total minted approaches 2 * ε₀ * h

#### Acceptance Criteria
- [ ] `forge test --match-contract AntseedEmissionsEpochTest` — all pass

---

## Task 5: AntseedEmissions Foundry tests — reward accumulation and claiming

**Tests:**
- **test_accrueSellerPoints:** Points tracked, reward accumulates over time
- **test_accrueSellerPoints_revert_notEscrow:** Non-escrow caller reverts
- **test_accrueBuyerPoints:** Same pattern for buyers
- **test_claimEmissions_seller:** Correct ANTS minted
- **test_claimEmissions_buyer:** Correct ANTS minted
- **test_claimEmissions_both:** Address is both seller and buyer, gets combined
- **test_sellerCap:** Seller exceeding 15% cap, excess to reserve
- **test_multipleParticipants:** Two sellers with different points, share proportional
- **test_pendingEmissions_matchesClaim:** View function matches actual claim
- **test_reserveFlush:** Reserve minted to destination
- **test_reserveFlush_revert_noDestination:** Reverts without destination set
- **test_sharePercentages_revert_invalidSum:** Sum != 100 reverts

#### Acceptance Criteria
- [ ] `forge test --match-contract AntseedEmissionsRewardTest` — all pass
- [ ] O(1) gas verified (no loops in accrue/claim)

---

## Task 6: AntseedEmissions Foundry tests — feedback multiplier

**Tests:**
- **test_feedbackMultiplier_default:** No feedback → 1.0x multiplier
- **test_feedbackMultiplier_positive:** avgFeedback > 80 → 1.5x
- **test_feedbackMultiplier_negative:** avgFeedback < -50 → 0.5x
- **test_feedbackMultiplier_configurable:** Change tier thresholds, verify new behavior

Note: The feedback multiplier is applied in the escrow contract's settle() when computing pointsDelta before calling accrueSellerPoints(). These tests verify the multiplier lookup function in the emissions contract (or escrow, depending on where it's computed).

#### Acceptance Criteria
- [ ] All multiplier tiers verified
- [ ] Configurable thresholds work

---

## Task 7: TypeScript EmissionsClient

##### CREATE: `packages/node/src/payments/evm/emissions-client.ts`

```typescript
export interface EmissionsClientConfig {
  rpcUrl: string;
  contractAddress: string;
}

export class EmissionsClient {
  async advanceEpoch(signer): Promise<string>
  async claimEmissions(signer): Promise<string>
  async pendingEmissions(address: string): Promise<{seller: bigint, buyer: bigint}>
  async getEpochInfo(): Promise<{epoch: number, emission: bigint, epochStart: number, epochDuration: number}>
  async flushReserve(signer): Promise<string>
}
```

##### MODIFY: `packages/node/src/payments/index.ts`
Add export for EmissionsClient.

#### Acceptance Criteria
- [ ] TypeScript compiles
- [ ] All contract methods wrapped

---

## Task 8: EmissionsClient TypeScript tests

##### CREATE: `packages/node/tests/emissions-client.test.ts`

- **test_config:** Client initializes
- **test_pendingEmissions_types:** Return types correct

#### Acceptance Criteria
- [ ] Tests pass
