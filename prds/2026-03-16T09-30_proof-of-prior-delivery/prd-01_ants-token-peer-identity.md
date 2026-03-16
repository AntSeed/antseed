# PRD-01: ANTS Token + Peer Identity

**Created:** 2026-03-16T10:00Z
**Depends On:** None
**Estimated Tasks:** 11

---

## Overview

Two Solidity contracts (ANTS ERC-20 token, AntseedIdentity soulbound ERC-721 with ERC-8004 reputation), Foundry test suite, and TypeScript client wrappers. This PRD establishes the identity and token foundation that all other PRDs build on.

---

## Task 1: Set up Foundry configuration and OpenZeppelin dependency

### Description
Create Foundry build configuration and add OpenZeppelin contracts as a dependency for Solidity compilation.

##### CREATE: `packages/node/foundry.toml`
```toml
[profile.default]
src = "contracts"
test = "contracts/test"
out = "contracts/out"
cache_path = "contracts/cache_forge"
libs = ["node_modules"]
solc_version = "0.8.24"
optimizer = true
optimizer_runs = 200
via_ir = true
ffi = false

[fmt]
line_length = 120
tab_width = 4
bracket_spacing = true
```

##### MODIFY: `packages/node/package.json`
**Add to devDependencies:**
```json
"@openzeppelin/contracts": "^5.1.0"
```

##### MODIFY: `packages/node/.gitignore`
**Append after existing entries:**
```
# Foundry
contracts/out/
contracts/cache_forge/
```

#### Acceptance Criteria
- [ ] `cd packages/node && forge build` compiles successfully (no source files yet, just config)
- [ ] OpenZeppelin contracts importable from `@openzeppelin/contracts/`
- [ ] Build artifacts excluded from git

---

## Task 2: ANTS Token contract (ERC-20)

### Description
Simple ERC-20 token with mint authority restricted to a single emissions contract address. No pre-mine, no initial supply.

##### CREATE: `packages/node/contracts/ANTSToken.sol`
```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract ANTSToken is ERC20 {
    address public owner;
    address public emissionsContract;
    bool public emissionsContractSet;

    error NotOwner();
    error NotEmissionsContract();
    error EmissionsAlreadySet();
    error InvalidAddress();

    event EmissionsContractSet(address indexed emissionsContract);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor() ERC20("AntSeed", "ANTS") {
        owner = msg.sender;
    }

    /// @notice Set the emissions contract address. Can only be called once.
    function setEmissionsContract(address _emissionsContract) external onlyOwner {
        if (_emissionsContract == address(0)) revert InvalidAddress();
        if (emissionsContractSet) revert EmissionsAlreadySet();
        emissionsContract = _emissionsContract;
        emissionsContractSet = true;
        emit EmissionsContractSet(_emissionsContract);
    }

    /// @notice Mint ANTS tokens. Restricted to emissions contract.
    function mint(address to, uint256 amount) external {
        if (msg.sender != emissionsContract) revert NotEmissionsContract();
        if (to == address(0)) revert InvalidAddress();
        _mint(to, amount);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert InvalidAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }
}
```

#### Acceptance Criteria
- [ ] `forge build` compiles without errors
- [ ] Token name is "AntSeed", symbol is "ANTS"
- [ ] 18 decimals (ERC-20 default)
- [ ] Zero initial supply
- [ ] `mint()` reverts when called by non-emissions address
- [ ] `setEmissionsContract()` reverts on second call
- [ ] `transferOwnership()` works correctly

---

## Task 3: ANTS Token Foundry tests

##### CREATE: `packages/node/contracts/test/ANTSToken.t.sol`

Test contract with:
- **Setup:** Deploy ANTSToken, set up test addresses (owner, emissions, user1, user2)
- **test_initialState:** Zero total supply, correct name/symbol, owner set
- **test_setEmissionsContract:** Owner sets emissions address, event emitted
- **test_setEmissionsContract_revert_notOwner:** Non-owner reverts
- **test_setEmissionsContract_revert_alreadySet:** Second call reverts
- **test_setEmissionsContract_revert_zeroAddress:** Zero address reverts
- **test_mint:** Emissions contract mints tokens, balance and supply update
- **test_mint_revert_notEmissions:** Non-emissions caller reverts
- **test_mint_revert_beforeSet:** Mint reverts before emissions contract is set (emissionsContract == address(0))
- **test_mint_revert_zeroAddress:** Mint to zero address reverts
- **test_transfer:** Standard ERC-20 transfer works
- **test_approve_transferFrom:** Standard ERC-20 approve + transferFrom
- **test_transferOwnership:** Owner transfers, new owner can act
- **test_transferOwnership_revert_notOwner:** Non-owner reverts

#### Acceptance Criteria
- [ ] `forge test --match-contract ANTSTokenTest` — all tests pass
- [ ] 100% branch coverage on ANTSToken.sol

---

## Task 4: AntseedIdentity contract — soulbound ERC-721 identity

##### CREATE: `packages/node/contracts/AntseedIdentity.sol`

**Structure (implement in this order):**

1. **Imports:** OpenZeppelin ERC721, ERC721URIStorage
2. **State variables:**
   - `address public owner`
   - `address public escrowContract` — authorized to update reputation
   - `uint256 private _nextTokenId` — auto-incrementing
   - `mapping(address => uint256) public addressToTokenId` — reverse lookup
   - `mapping(address => bool) public registered` — quick check

3. **Soulbound override:**
   ```solidity
   function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
       address from = _ownerOf(tokenId);
       // Allow mint (from == address(0)) and burn (to == address(0))
       if (from != address(0) && to != address(0)) revert NonTransferable();
       return super._update(to, tokenId, auth);
   }
   ```

4. **Dual lookup mappings:**
   ```solidity
   mapping(address => uint256) public addressToTokenId;
   mapping(bytes32 => uint256) public peerIdToTokenId;
   mapping(uint256 => bytes32) public tokenIdToPeerId;
   mapping(address => bool) public registered;
   ```

5. **Registration:**
   - `register(bytes32 peerId, string calldata metadataURI)` — mints NFT to msg.sender, stores peerId in both mappings, sets URI
   - Reverts if peerId already registered (prevents duplicate peerId)
   - `updateMetadata(uint256 tokenId, string calldata metadataURI)` — token owner only
   - `deregister(uint256 tokenId)` — burns NFT, clears both mappings, requires no active stake (checked via escrow)

6. **Admin:**
   - `setEscrowContract(address)` — onlyOwner
   - `transferOwnership(address)` — onlyOwner

7. **View functions:**
   - `isRegistered(address) → bool`
   - `getTokenId(address) → uint256` — lookup by EVM address
   - `getTokenIdByPeerId(bytes32 peerId) → uint256` — lookup by peerId
   - `getPeerId(uint256 tokenId) → bytes32`

#### Acceptance Criteria
- [ ] `forge build` compiles without errors
- [ ] Transfers between non-zero addresses revert
- [ ] Mint and burn work correctly
- [ ] One NFT per address (second register reverts)
- [ ] Only token owner can update metadata

---

## Task 5: AntseedIdentity — custom reputation storage

### Description
Add proof chain reputation counters to AntseedIdentity. These are updated by AntseedEscrow during reserve/settle.

##### MODIFY: `packages/node/contracts/AntseedIdentity.sol`

**Add struct:**
```solidity
struct ProvenReputation {
    uint64 firstSignCount;
    uint64 qualifiedProvenSignCount;
    uint64 unqualifiedProvenSignCount;
    uint64 ghostCount;
    uint256 totalQualifiedTokenVolume;
    uint64 lastProvenAt;
}
```

**Add state:**
```solidity
mapping(uint256 => ProvenReputation) private _reputation;
```

**Add struct for updates:**
```solidity
struct ReputationUpdate {
    uint8 updateType;        // 0=firstSign, 1=qualifiedProven, 2=unqualifiedProven, 3=ghost
    uint256 tokenVolume;     // tokens delivered (for proven signs)
}
```

**Add methods:**
```solidity
function updateReputation(uint256 tokenId, ReputationUpdate calldata update) external {
    if (msg.sender != escrowContract) revert NotAuthorized();
    if (_ownerOf(tokenId) == address(0)) revert InvalidToken();

    ProvenReputation storage rep = _reputation[tokenId];
    if (update.updateType == 0) {
        rep.firstSignCount++;
    } else if (update.updateType == 1) {
        rep.qualifiedProvenSignCount++;
        rep.totalQualifiedTokenVolume += update.tokenVolume;
        rep.lastProvenAt = uint64(block.timestamp);
    } else if (update.updateType == 2) {
        rep.unqualifiedProvenSignCount++;
    } else if (update.updateType == 3) {
        rep.ghostCount++;
    }
}

function getReputation(uint256 tokenId) external view returns (ProvenReputation memory) {
    return _reputation[tokenId];
}
```

#### Acceptance Criteria
- [ ] Only escrowContract can call `updateReputation()`
- [ ] Each update type increments the correct counter
- [ ] `lastProvenAt` only updates on qualified proven signs
- [ ] `getReputation()` returns correct struct
- [ ] Reputation data is deleted on `deregister()` (burn)

---

## Task 6: AntseedIdentity — ERC-8004 Reputation Registry

### Description
Add ERC-8004 compliant feedback interface for human/client quality signals.

##### MODIFY: `packages/node/contracts/AntseedIdentity.sol`

**Add structs:**
```solidity
struct FeedbackEntry {
    address client;
    int128 value;
    uint8 valueDecimals;
    bytes32 tag1;
    bytes32 tag2;
    uint64 timestamp;
    bool revoked;
}

struct FeedbackSummary {
    uint256 count;
    int256 summaryValue;
    uint8 summaryValueDecimals;
}
```

**Add state:**
```solidity
// agentId (tokenId) => client => FeedbackEntry[]
mapping(uint256 => mapping(address => FeedbackEntry[])) private _feedback;
// agentId => tag => FeedbackSummary (cached)
mapping(uint256 => mapping(bytes32 => FeedbackSummary)) private _feedbackSummary;
// agentId => client[]
mapping(uint256 => address[]) private _feedbackClients;
mapping(uint256 => mapping(address => bool)) private _isClient;
```

**Add methods:**
```solidity
function giveFeedback(
    uint256 agentId,
    int128 value,
    uint8 valueDecimals,
    bytes32 tag1,
    bytes32 tag2
) external {
    if (_ownerOf(agentId) == address(0)) revert InvalidToken();
    // Store feedback
    _feedback[agentId][msg.sender].push(FeedbackEntry({
        client: msg.sender,
        value: value,
        valueDecimals: valueDecimals,
        tag1: tag1,
        tag2: tag2,
        timestamp: uint64(block.timestamp),
        revoked: false
    }));
    // Update summary for tag1
    FeedbackSummary storage summary = _feedbackSummary[agentId][tag1];
    summary.count++;
    summary.summaryValue += int256(value);
    summary.summaryValueDecimals = valueDecimals;
    // Track unique clients
    if (!_isClient[agentId][msg.sender]) {
        _feedbackClients[agentId].push(msg.sender);
        _isClient[agentId][msg.sender] = true;
    }
    emit FeedbackGiven(agentId, msg.sender, value, tag1);
}

function getSummary(uint256 agentId, bytes32 tag) external view
    returns (uint256 count, int256 summaryValue, uint8 summaryValueDecimals) {
    FeedbackSummary memory s = _feedbackSummary[agentId][tag];
    return (s.count, s.summaryValue, s.summaryValueDecimals);
}

function readFeedback(uint256 agentId, address client, uint256 index) external view
    returns (FeedbackEntry memory) {
    return _feedback[agentId][client][index];
}

function revokeFeedback(uint256 agentId, uint256 index) external {
    FeedbackEntry[] storage entries = _feedback[agentId][msg.sender];
    if (index >= entries.length) revert InvalidIndex();
    if (entries[index].revoked) revert AlreadyRevoked();
    entries[index].revoked = true;
    // Update summary
    FeedbackSummary storage summary = _feedbackSummary[agentId][entries[index].tag1];
    summary.count--;
    summary.summaryValue -= int256(entries[index].value);
    emit FeedbackRevoked(agentId, msg.sender, index);
}

function getFeedbackCount(uint256 agentId, address client) external view returns (uint256) {
    return _feedback[agentId][client].length;
}
```

**Add events:**
```solidity
event FeedbackGiven(uint256 indexed agentId, address indexed client, int128 value, bytes32 indexed tag);
event FeedbackRevoked(uint256 indexed agentId, address indexed client, uint256 index);
```

#### Acceptance Criteria
- [ ] Any address can submit feedback for a registered agent
- [ ] Feedback for non-existent agent reverts
- [ ] `getSummary()` returns correct aggregated values
- [ ] `revokeFeedback()` only works for the original submitter
- [ ] Revoking updates the summary (decrements count, subtracts value)
- [ ] Multiple feedbacks from same client tracked separately
- [ ] Unique client tracking works correctly

---

## Task 7: AntseedIdentity Foundry tests — identity and soulbound

##### CREATE: `packages/node/contracts/test/AntseedIdentity.t.sol`

**Setup:**
- Deploy AntseedIdentity
- Set up test addresses: owner, peer1, peer2, escrow

**Test cases:**
- **test_register:** Peer registers, gets tokenId, isRegistered = true
- **test_register_revert_alreadyRegistered:** Second register from same address reverts
- **test_updateMetadata:** Token owner updates URI
- **test_updateMetadata_revert_notOwner:** Non-owner of token reverts
- **test_deregister:** Burns token, isRegistered = false, reputation cleared
- **test_soulbound_revert_transfer:** `transferFrom()` between non-zero addresses reverts
- **test_soulbound_revert_safeTransfer:** `safeTransferFrom()` reverts
- **test_setEscrowContract:** Owner sets escrow address
- **test_setEscrowContract_revert_notOwner:** Non-owner reverts
- **test_getTokenId:** Returns correct tokenId for registered address
- **test_getTokenIdByPeerId:** Returns correct tokenId when looked up by peerId
- **test_getTokenId_revert_unregistered:** Reverts or returns 0 for unregistered
- **test_getPeerId:** Returns correct peerId bytes32
- **test_register_revert_duplicatePeerId:** Same peerId from different address reverts
- **test_deregister_clearsMappings:** Both addressToTokenId and peerIdToTokenId cleared on burn

#### Acceptance Criteria
- [ ] `forge test --match-contract AntseedIdentityTest` — all tests pass
- [ ] Soulbound property verified (transfers blocked)

---

## Task 8: AntseedIdentity Foundry tests — reputation and ERC-8004 feedback

##### CREATE: `packages/node/contracts/test/AntseedIdentityReputation.t.sol`

**Setup:**
- Deploy AntseedIdentity, set escrow contract
- Register a peer (peer1)

**Reputation tests:**
- **test_updateReputation_firstSign:** Increments firstSignCount
- **test_updateReputation_qualifiedProven:** Increments qualifiedProvenSignCount, adds volume, sets lastProvenAt
- **test_updateReputation_unqualifiedProven:** Increments unqualifiedProvenSignCount
- **test_updateReputation_ghost:** Increments ghostCount
- **test_updateReputation_revert_notEscrow:** Non-escrow caller reverts
- **test_updateReputation_revert_invalidToken:** Unregistered token reverts
- **test_getReputation_allFields:** All fields returned correctly after multiple updates

**ERC-8004 Feedback tests:**
- **test_giveFeedback:** Submits feedback, summary updated
- **test_giveFeedback_multipleTags:** Different tags tracked separately
- **test_giveFeedback_multipleClients:** Multiple clients, unique tracking
- **test_giveFeedback_revert_invalidAgent:** Non-existent agentId reverts
- **test_getSummary:** Returns correct count, summaryValue, decimals
- **test_readFeedback:** Returns correct entry by index
- **test_revokeFeedback:** Revokes, summary updated (count--, value subtracted)
- **test_revokeFeedback_revert_notSubmitter:** Non-submitter reverts
- **test_revokeFeedback_revert_alreadyRevoked:** Double revoke reverts
- **test_revokeFeedback_revert_invalidIndex:** Out-of-bounds index reverts
- **test_getFeedbackCount:** Returns correct count per client

#### Acceptance Criteria
- [ ] `forge test --match-contract AntseedIdentityReputationTest` — all tests pass
- [ ] 100% branch coverage on reputation and feedback code

---

## Task 9: TypeScript IdentityClient

### Description
TypeScript wrapper for AntseedIdentity contract, following the BaseEscrowClient pattern.

##### CREATE: `packages/node/src/payments/evm/identity-client.ts`

**Structure:**
```typescript
export interface IdentityClientConfig {
  rpcUrl: string;
  contractAddress: string;
}

export interface ProvenReputation {
  firstSignCount: number;
  qualifiedProvenSignCount: number;
  unqualifiedProvenSignCount: number;
  ghostCount: number;
  totalQualifiedTokenVolume: bigint;
  lastProvenAt: number;
}

export interface FeedbackSummary {
  count: number;
  summaryValue: bigint;
  summaryValueDecimals: number;
}

export class IdentityClient {
  // Constructor takes IdentityClientConfig
  // Private: _provider, _contractAddress, _nonceCursor

  async register(signer: AbstractSigner, peerId: string, metadataURI: string): Promise<string>
  async deregister(signer: AbstractSigner, tokenId: number): Promise<string>
  async updateMetadata(signer: AbstractSigner, tokenId: number, metadataURI: string): Promise<string>
  async isRegistered(address: string): Promise<boolean>
  async getTokenId(address: string): Promise<number>
  async getTokenIdByPeerId(peerId: string): Promise<number>
  async getPeerId(tokenId: number): Promise<string>
  async getReputation(tokenId: number): Promise<ProvenReputation>
  async getReputationByPeerId(peerId: string): Promise<ProvenReputation>
  async submitFeedback(signer: AbstractSigner, agentId: number, value: number, tag: string): Promise<string>
  async getFeedbackSummary(agentId: number, tag: string): Promise<FeedbackSummary>
}
```

**ABI:** Inline const array following escrow-client.ts pattern.
**Nonce management:** Use same `reserveNonce()` pattern as BaseEscrowClient.

##### MODIFY: `packages/node/src/payments/index.ts`
**Add export:**
```typescript
export { IdentityClient } from './evm/identity-client.js';
```

#### Acceptance Criteria
- [ ] TypeScript compiles without errors
- [ ] All methods match contract function signatures
- [ ] Follows same patterns as BaseEscrowClient (nonce management, error handling)

---

## Task 10: TypeScript ANTSTokenClient

##### CREATE: `packages/node/src/payments/evm/ants-token-client.ts`

**Structure:**
```typescript
export interface ANTSTokenClientConfig {
  rpcUrl: string;
  contractAddress: string;
}

export class ANTSTokenClient {
  async balanceOf(address: string): Promise<bigint>
  async totalSupply(): Promise<bigint>
  async setEmissionsContract(signer: AbstractSigner, emissionsAddress: string): Promise<string>
  async transferOwnership(signer: AbstractSigner, newOwner: string): Promise<string>
}
```

Minimal client — most interactions go through the emissions contract, not directly.

##### MODIFY: `packages/node/src/payments/index.ts`
**Add export:**
```typescript
export { ANTSTokenClient } from './evm/ants-token-client.js';
```

#### Acceptance Criteria
- [ ] TypeScript compiles without errors
- [ ] View methods work correctly

---

## Task 11: TypeScript tests for IdentityClient and ANTSTokenClient

##### CREATE: `packages/node/tests/identity-client.test.ts`

Test with mocked provider (following evm-keypair.test.ts pattern):
- **test_config:** Client initializes with config
- **test_register_encodesCorrectly:** Verify ABI encoding matches contract
- **test_reputation_types:** ProvenReputation struct maps correctly
- **test_feedback_summary_types:** FeedbackSummary struct maps correctly

##### CREATE: `packages/node/tests/ants-token-client.test.ts`

- **test_config:** Client initializes with config
- **test_balanceOf_returns_bigint:** Return type is correct

#### Acceptance Criteria
- [ ] `pnpm --filter @antseed/node run test` — new tests pass
- [ ] No regressions in existing tests
