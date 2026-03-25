# PRD-11: AntseedStaking + AntseedIdentity Cleanup

**Created:** 2026-03-25T11:00Z
**Depends on:** PRD-01
**Blocked by:** None (can run in parallel with PRD-02 through PRD-10)

## Summary

Remove the tokenRate concept from AntseedStaking (pricing now lives in vouchers/off-chain), simplify AntseedIdentity reputation from the multi-tier proven-sign model to a straightforward settlement-based model, and add a `stakeFor()` helper so third parties can stake on behalf of a seller. All changes propagate through Solidity interfaces and TypeScript clients.

---

## Tasks

### Task 1: AntseedStaking Contract Changes

**File:** `packages/node/contracts/AntseedStaking.sol`

1. **Remove `tokenRate` from `SellerAccount` struct** -- drop the `uint256 tokenRate` field. Struct becomes:
   ```solidity
   struct SellerAccount {
       uint256 stake;
       uint256 stakedAt;
   }
   ```

2. **Delete `setTokenRate()`** (line 93-98) entirely.

3. **Delete `getTokenRate()`** (line 133-135) entirely.

4. **Simplify `validateSeller()`** -- remove tokenRate check, just check `isStakedAboveMin`. Change return type from `uint256 tokenRate` to `bool`:
   ```solidity
   function validateSeller(address seller) external view returns (bool) {
       return sellers[seller].stake >= MIN_SELLER_STAKE;
   }
   ```

5. **Add `stakeFor(address seller, uint256 amount)`** -- third party stakes on behalf of a registered seller. Same approve-and-transfer pattern as `stake()` but `msg.sender` pays and `seller` gets credit:
   ```solidity
   function stakeFor(address seller, uint256 amount) external nonReentrant {
       if (amount == 0) revert InvalidAmount();
       if (seller == address(0)) revert InvalidAddress();
       if (!identityContract.isRegistered(seller)) revert NotRegistered();

       usdc.safeTransferFrom(msg.sender, address(this), amount);

       SellerAccount storage sa = sellers[seller];
       sa.stake += amount;
       sa.stakedAt = block.timestamp;

       emit Staked(seller, amount);
   }
   ```

6. **Update `getSellerAccount()`** -- remove `tokenRate` from return tuple:
   ```solidity
   function getSellerAccount(address seller)
       external view returns (uint256 stakeAmt, uint256 stakedAt)
   {
       SellerAccount storage sa = sellers[seller];
       return (sa.stake, sa.stakedAt);
   }
   ```

7. **Update `effectiveProvenSigns()` -> `effectiveSettlements()`** -- rewrite to use the new `Reputation` struct from AntseedIdentity. Replace references to `qualifiedProvenSignCount` with `sessionCount`:
   ```solidity
   function effectiveSettlements(address seller) external view returns (uint256) {
       uint256 sellerTokenId = identityContract.getTokenId(seller);
       IAntseedIdentity.Reputation memory rep = identityContract.getReputation(sellerTokenId);

       uint256 sessions = uint256(rep.sessionCount);
       uint256 stakeCap = (sellers[seller].stake * REPUTATION_CAP_COEFFICIENT) / 1_000_000;

       return sessions < stakeCap ? sessions : stakeCap;
   }
   ```

8. **Update `_calculateSlash()`** -- rewrite slashing tiers to use the new reputation fields (`sessionCount`, `ghostCount`, `totalSettledVolume`, `lastSettledAt`) instead of the old proven-sign fields. New tiers:
   - Tier 1: ghosts >= threshold and zero sessions -> full slash
   - Tier 2: has sessions but ghost ratio above threshold -> half slash
   - Tier 3: has sessions but inactive (lastSettledAt + SLASH_INACTIVITY_DAYS < now) -> 20% slash
   - Tier 4: no slash

9. **Remove `tokenRate` from `unstake()` cleanup** -- `sa.tokenRate = 0` no longer needed (field gone), but verify unstake still zeroes `stake` and `stakedAt`.

10. **Update NatSpec** -- remove "token rates" from the contract-level `@notice`.

**Verify:** contract compiles, `stake()` / `stakeFor()` / `unstake()` / `validateSeller()` all work with updated struct.

---

### Task 2: IAntseedStaking Interface Update

**File:** `packages/node/contracts/interfaces/IAntseedStaking.sol`

1. **Remove** `getTokenRate(address seller)` signature.

2. **Add** `stakeFor(address seller, uint256 amount)` signature.

3. **Update** `validateSeller` return type from `uint256 tokenRate` to `bool`.

Updated interface:
```solidity
interface IAntseedStaking {
    function stake(uint256 amount) external;
    function stakeFor(address seller, uint256 amount) external;
    function validateSeller(address seller) external view returns (bool);
    function getStake(address seller) external view returns (uint256);
    function isStakedAboveMin(address seller) external view returns (bool);
    function incrementActiveSessions(address seller) external;
    function decrementActiveSessions(address seller) external;
}
```

**Verify:** all contracts that import `IAntseedStaking` still compile (check AntseedIdentity.sol `deregister()` which calls `getStake()` -- unchanged, still fine).

---

### Task 3: AntseedIdentity Reputation Overhaul

**File:** `packages/node/contracts/AntseedIdentity.sol`

1. **Replace `ProvenReputation` struct** with `Reputation`:
   ```solidity
   struct Reputation {
       uint64 sessionCount;          // Settled sessions
       uint64 ghostCount;            // Pattern-based ghost marks
       uint256 totalSettledVolume;   // Cumulative USDC from all settlements
       uint128 totalInputTokens;    // Cumulative input tokens from all settlements
       uint128 totalOutputTokens;   // Cumulative output tokens from all settlements
       uint64 lastSettledAt;         // Timestamp of last settlement
   }
   ```
   Drop: `firstSignCount`, `qualifiedProvenSignCount`, `unqualifiedProvenSignCount`, `totalQualifiedTokenVolume`, `lastProvenAt`.

2. **Update `_reputation` mapping** type from `ProvenReputation` to `Reputation`.

3. **Replace `ReputationUpdate` struct:**
   ```solidity
   struct ReputationUpdate {
       uint8 updateType;              // 0=settlement, 1=ghost
       uint256 settledVolume;         // USDC settled (for type 0)
       uint128 inputTokens;           // input tokens (for type 0)
       uint128 outputTokens;          // output tokens (for type 0)
   }
   ```
   Drop: `tokenVolume`.

4. **Rewrite `updateReputation()`** with two update types:
   ```solidity
   function updateReputation(uint256 tokenId, ReputationUpdate calldata update) external {
       if (msg.sender != sessionsContract) revert NotAuthorized();
       if (_ownerOf(tokenId) == address(0)) revert InvalidToken();

       Reputation storage rep = _reputation[tokenId];
       if (update.updateType == 0) {
           // Settlement
           rep.sessionCount++;
           rep.totalSettledVolume += update.settledVolume;
           rep.totalInputTokens += update.inputTokens;
           rep.totalOutputTokens += update.outputTokens;
           rep.lastSettledAt = uint64(block.timestamp);
       } else if (update.updateType == 1) {
           // Ghost
           rep.ghostCount++;
       }
   }
   ```

5. **Update `getReputation()` return type** from `ProvenReputation` to `Reputation`.

6. **Update `deregister()`** -- `delete _reputation[tokenId]` still works (deletes the whole struct), no change needed.

**Verify:** contract compiles, `updateReputation()` handles both update types, `getReputation()` returns the new struct.

---

### Task 4: IAntseedIdentity Interface Update

**File:** `packages/node/contracts/interfaces/IAntseedIdentity.sol`

1. **Replace `ProvenReputation` struct** with `Reputation` (same as Task 3).

2. **Replace `ReputationUpdate` struct** (same as Task 3).

3. **Update `getReputation()` return type** from `ProvenReputation memory` to `Reputation memory`.

4. **`updateReputation()` signature** stays the same (still takes `ReputationUpdate calldata`) but the struct shape changes.

Updated interface:
```solidity
interface IAntseedIdentity {
    struct Reputation {
        uint64 sessionCount;
        uint64 ghostCount;
        uint256 totalSettledVolume;
        uint128 totalInputTokens;
        uint128 totalOutputTokens;
        uint64 lastSettledAt;
    }

    struct ReputationUpdate {
        uint8 updateType;
        uint256 settledVolume;
        uint128 inputTokens;
        uint128 outputTokens;
    }

    function updateReputation(uint256 tokenId, ReputationUpdate calldata update) external;
    function getReputation(uint256 tokenId) external view returns (Reputation memory);
    function getTokenId(address addr) external view returns (uint256);
    function isRegistered(address addr) external view returns (bool);
}
```

**Verify:** `AntseedStaking.sol` (which imports this interface for `_calculateSlash` and `effectiveSettlements`) compiles against the updated interface.

---

### Task 5: TypeScript Client Updates

#### 5a: `staking-client.ts`

**File:** `packages/node/src/payments/evm/staking-client.ts`

1. **Remove `tokenRate` from `SellerAccountInfo`** interface:
   ```typescript
   export interface SellerAccountInfo {
     stake: bigint;
     stakedAt: bigint;
   }
   ```

2. **Remove from `STAKING_ABI`:**
   - `'function setTokenRate(uint256 rate) external'`
   - `'function getTokenRate(address seller) external view returns (uint256)'`
   - Update `getSellerAccount` signature to remove `tokenRate` from return tuple.

3. **Add to `STAKING_ABI`:**
   - `'function stakeFor(address seller, uint256 amount) external'`
   - `'function validateSeller(address seller) external view returns (bool)'`

4. **Delete methods:** `setTokenRate()`, `getTokenRate()`.

5. **Add `stakeFor()` method:**
   ```typescript
   async stakeFor(signer: AbstractSigner, seller: string, amount: bigint): Promise<string> {
     return this._approveAndExec(signer, this._usdcAddress, amount, STAKING_ABI, 'stakeFor', seller, amount);
   }
   ```

6. **Add `validateSeller()` method:**
   ```typescript
   async validateSeller(sellerAddr: string): Promise<boolean> {
     const contract = new Contract(this._contractAddress, STAKING_ABI, this._provider);
     return contract.getFunction('validateSeller')(sellerAddr) as Promise<boolean>;
   }
   ```

7. **Update `getSellerAccount()`** -- remove `tokenRate` from result mapping (index `[2]` gone).

#### 5b: `identity-client.ts`

**File:** `packages/node/src/payments/evm/identity-client.ts`

1. **Replace `ProvenReputation` interface** with `Reputation`:
   ```typescript
   export interface Reputation {
     sessionCount: number;
     ghostCount: number;
     totalSettledVolume: bigint;
     totalInputTokens: bigint;
     totalOutputTokens: bigint;
     lastSettledAt: number;
   }
   ```

2. **Update `IDENTITY_ABI`** -- replace `getReputation` and `updateReputation` signatures:
   ```
   'function getReputation(uint256 tokenId) external view returns (uint64 sessionCount, uint64 ghostCount, uint256 totalSettledVolume, uint128 totalInputTokens, uint128 totalOutputTokens, uint64 lastSettledAt)'
   'function updateReputation(uint256 tokenId, tuple(uint8 updateType, uint256 settledVolume, uint128 inputTokens, uint128 outputTokens) update) external'
   ```

3. **Update `getReputation()` method** -- map result indices to new field names:
   ```typescript
   async getReputation(tokenId: number): Promise<Reputation> {
     const contract = new Contract(this._contractAddress, IDENTITY_ABI, this._provider);
     const result = await contract.getFunction('getReputation')(tokenId);
     return {
       sessionCount: Number(result[0]),
       ghostCount: Number(result[1]),
       totalSettledVolume: result[2] as bigint,
       totalInputTokens: result[3] as bigint,
       totalOutputTokens: result[4] as bigint,
       lastSettledAt: Number(result[5]),
     };
   }
   ```

4. **Update `getReputationByPeerId()`** return type from `ProvenReputation` to `Reputation` (implementation delegates to `getReputation()`, no logic change).

5. **Search for any other imports of `ProvenReputation`** across the codebase and update to `Reputation`.

**Verify:** `pnpm run typecheck` passes for `packages/node`.
