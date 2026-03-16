# PRD-04: Subscription Pool Contract

**Created:** 2026-03-16T10:45Z
**Depends On:** PRD-02
**Estimated Tasks:** 8

---

## Overview

Separate contract managing monthly subscriptions, daily token budgets, and revenue distribution to peers proportional to proven delivery. Foundry tests and TypeScript client.

---

## Task 1: AntseedSubPool contract — subscription management

##### CREATE: `packages/node/contracts/AntseedSubPool.sol`

**State and structures:**
```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 { /* transfer, transferFrom, balanceOf */ }
interface IAntseedIdentity { /* getReputation, isRegistered, getTokenId */ }

contract AntseedSubPool {
    struct Tier {
        uint256 monthlyFee;         // USDC base units
        uint256 dailyTokenBudget;   // tokens per day
        bool active;
    }

    struct Subscription {
        uint256 tierId;
        uint256 startedAt;
        uint256 expiresAt;
        uint256 tokensUsedToday;
        uint256 lastResetDay;       // day number (block.timestamp / 1 days)
    }

    struct PeerOpt {
        bool optedIn;
        uint256 tokenId;            // AntseedIdentity token
        uint256 lastClaimedEpoch;
        uint256 pendingRevenue;
    }

    IERC20 public immutable usdc;
    IAntseedIdentity public identityContract;
    address public escrowContract;
    address public owner;

    mapping(uint256 => Tier) public tiers;
    uint256 public tierCount;
    mapping(address => Subscription) public subscriptions;
    mapping(address => PeerOpt) public peerOpts;    // seller address → opt-in state
    address[] public optedInPeers;

    uint256 public currentEpochRevenue;             // USDC accumulated this epoch
    uint256 public epochDuration;                    // default 1 week
    uint256 public epochStart;
    uint256 public currentEpoch;
}
```

**Implement:**
- `setTier(uint256 tierId, uint256 monthlyFee, uint256 dailyTokenBudget)` — owner creates/updates tiers
- `subscribe(uint256 tierId)` — buyer pays monthlyFee in USDC, sets expiresAt = now + 30 days
- `renewSubscription()` — extends by another 30 days if active
- `cancelSubscription()` — no refund, subscription active until expiresAt
- `isSubscriptionActive(address buyer) → bool`
- `getRemainingDailyBudget(address buyer) → uint256` — dailyTokenBudget - tokensUsedToday (resets daily)
- `recordTokenUsage(address buyer, uint256 tokens)` — called by escrow during session, enforces daily budget

#### Acceptance Criteria
- [ ] `forge build` compiles
- [ ] Tiers manageable by owner
- [ ] Monthly fee transferred on subscribe
- [ ] Daily budget resets each day
- [ ] Token usage correctly tracked and capped

---

## Task 2: AntseedSubPool — peer opt-in and revenue distribution

##### MODIFY: `packages/node/contracts/AntseedSubPool.sol`

**Implement:**
- `optIn(uint256 tokenId)` — peer opts in, must own the identity NFT
- `optOut(uint256 tokenId)` — peer opts out
- `distributeRevenue()` — callable by anyone when epoch ends
  - Reads reputation from AntseedIdentity for each opted-in peer
  - Weight = peer's qualifiedProvenSignCount (capped by stake via REPUTATION_CAP_COEFFICIENT)
  - Each peer's share = (peerWeight / totalWeight) × currentEpochRevenue
  - Stores pendingRevenue per peer
  - Resets currentEpochRevenue, advances epoch
- `claimRevenue()` — peer withdraws pendingRevenue in USDC
- `getProjectedRevenue(address seller) → uint256` — view, estimated share for current epoch

**Note:** Revenue distribution loops over opted-in peers. For v1 this is acceptable (expected <100 peers). If scaling becomes an issue, switch to Synthetix pattern in v2.

#### Acceptance Criteria
- [ ] Only identity NFT owners can opt in
- [ ] Revenue distributed proportional to proven reputation
- [ ] Peers with zero reputation get zero revenue
- [ ] Revenue claimable after distribution

---

## Task 3: AntseedSubPool Foundry tests — subscriptions

##### CREATE: `packages/node/contracts/test/AntseedSubPool.t.sol`

**Tests:**
- **test_setTier:** Owner creates tier with fee and budget
- **test_subscribe:** Buyer subscribes, USDC transferred, subscription active
- **test_subscribe_revert_insufficientBalance:** Reverts without USDC approval
- **test_isSubscriptionActive:** True before expiry, false after
- **test_renewSubscription:** Extends expiry
- **test_cancelSubscription:** Active until expiry, then inactive
- **test_dailyBudget:** Budget resets each day, usage tracked correctly
- **test_recordTokenUsage_revert_overBudget:** Exceeding daily budget reverts

#### Acceptance Criteria
- [ ] `forge test --match-contract AntseedSubPoolSubscriptionTest` — all pass

---

## Task 4: AntseedSubPool Foundry tests — revenue distribution

**Tests:**
- **test_optIn:** Registered peer opts in
- **test_optIn_revert_notRegistered:** Unregistered reverts
- **test_distributeRevenue:** Revenue split proportional to reputation
- **test_distributeRevenue_zeroReputation:** Peer with 0 qualified signs gets 0
- **test_distributeRevenue_singlePeer:** Solo peer gets all revenue
- **test_claimRevenue:** Peer claims, USDC transferred, pending zeroed
- **test_distributeRevenue_revert_epochNotEnded:** Too early reverts
- **test_multiEpochDistribution:** Revenue accumulates across subscribe events, distributes per epoch

#### Acceptance Criteria
- [ ] `forge test --match-contract AntseedSubPoolRevenueTest` — all pass

---

## Task 5: TypeScript SubPoolClient

##### CREATE: `packages/node/src/payments/evm/subpool-client.ts`

```typescript
export interface SubPoolClientConfig {
  rpcUrl: string;
  contractAddress: string;
}

export class SubPoolClient {
  async subscribe(signer, tierId: number): Promise<string>
  async cancelSubscription(signer): Promise<string>
  async isSubscriptionActive(buyer: string): Promise<boolean>
  async getRemainingDailyBudget(buyer: string): Promise<bigint>
  async optIn(signer, tokenId: number): Promise<string>
  async optOut(signer, tokenId: number): Promise<string>
  async claimRevenue(signer): Promise<string>
  async getProjectedRevenue(seller: string): Promise<bigint>
  async getTier(tierId: number): Promise<{monthlyFee: bigint, dailyTokenBudget: bigint, active: boolean}>
}
```

##### MODIFY: `packages/node/src/payments/index.ts`
Add export for SubPoolClient.

#### Acceptance Criteria
- [ ] TypeScript compiles
- [ ] All contract methods wrapped

---

## Task 6: SubPoolClient TypeScript tests

##### CREATE: `packages/node/tests/subpool-client.test.ts`

- **test_config:** Client initializes
- **test_tierTypes:** Tier struct maps correctly

#### Acceptance Criteria
- [ ] Tests pass

---

## Task 7: Wire subscription check into node.ts

##### MODIFY: `packages/node/src/node.ts`

When a buyer connects and has an active subscription (checked via SubPoolClient), the seller can serve them using the subscription pool's daily budget instead of requiring a direct SpendingAuth.

Add to request guard:
```typescript
// Check subscription as alternative to SpendingAuth
if (!isAuthorized && this._subPoolClient) {
  const isSubscribed = await this._subPoolClient.isSubscriptionActive(buyerEvmAddr);
  const budget = await this._subPoolClient.getRemainingDailyBudget(buyerEvmAddr);
  if (isSubscribed && budget > 0n) {
    isAuthorized = true;
    session.isSubscription = true;
  }
}
```

After serving, record usage:
```typescript
if (session.isSubscription) {
  await this._subPoolClient.recordTokenUsage(buyerEvmAddr, tokensUsed);
}
```

#### Acceptance Criteria
- [ ] Subscription buyers can use the network without SpendingAuth
- [ ] Daily budget enforced
- [ ] Token usage recorded on-chain

---

## Task 8: Integration test — subscription lifecycle

##### CREATE: `packages/node/tests/subscription-integration.test.ts`

End-to-end test (mocked on-chain):
1. Owner creates tier
2. Buyer subscribes
3. Peer opts in
4. Buyer uses service, tokens deducted from daily budget
5. Epoch ends, revenue distributed
6. Peer claims revenue

#### Acceptance Criteria
- [ ] Full lifecycle verified
- [ ] Revenue proportional to reputation
