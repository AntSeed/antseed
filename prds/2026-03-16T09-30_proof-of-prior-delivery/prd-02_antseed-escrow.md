# PRD-02: AntseedEscrow — Proof of Prior Delivery

**Created:** 2026-03-16T10:15Z
**Depends On:** PRD-01
**Estimated Tasks:** 16

---

## Overview

Complete rewrite of `AntseedEscrow.sol` implementing the Proof of Prior Delivery protocol: Reserve→Serve→Settle lifecycle, EIP-712 SpendingAuth with proof chain, buyer deposits with anti-gaming defences, seller staking with slashing, and configurable constants. Updates the TypeScript EscrowClient and signatures module. Full Foundry test coverage.

---

## Task 1: AntseedEscrow contract — state variables, structs, constants, errors, events

### Description
Replace the existing `AntseedEscrow.sol` with the new contract skeleton. All configurable constants, structs, enums, state variables, events, errors, and modifiers.

##### REPLACE: `packages/node/contracts/AntseedEscrow.sol`

**Key structures:**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

interface IERC20 { /* transferFrom, transfer, balanceOf */ }
interface IAntseedIdentity { /* updateReputation, getReputation, isRegistered, getTokenId */ }
interface IAntseedEmissions { /* accrueSellerPoints, accrueBuyerPoints */ }

contract AntseedEscrow is EIP712, Pausable {
    // ─── Configurable Constants ───
    uint256 public FIRST_SIGN_CAP;                // default 1_000_000 (1 USDC)
    uint256 public MIN_BUYER_DEPOSIT;              // default 10_000_000 (10 USDC)
    uint256 public MIN_SELLER_STAKE;               // default 10_000_000 (10 USDC)
    uint256 public MIN_TOKEN_THRESHOLD;            // default 1000
    uint256 public BUYER_DIVERSITY_THRESHOLD;      // default 3
    uint256 public PROVEN_SIGN_COOLDOWN;           // default 7 days
    uint256 public BUYER_INACTIVITY_PERIOD;        // default 90 days
    uint256 public SETTLE_TIMEOUT;                 // default 24 hours
    uint256 public REPUTATION_CAP_COEFFICIENT;     // default 20 (per $1 staked)
    uint256 public SLASH_RATIO_THRESHOLD;          // default 30 (percent)
    uint256 public SLASH_GHOST_THRESHOLD;          // default 5
    uint256 public SLASH_INACTIVITY_DAYS;          // default 30 days
    uint256 public PLATFORM_FEE_BPS;               // default 500 (5%)
    uint256 public MAX_PLATFORM_FEE_BPS;           // default 1000 (10%)

    // ─── EIP-712 ───
    bytes32 public constant SPENDING_AUTH_TYPEHASH = keccak256(
        "SpendingAuth(address seller,bytes32 sessionId,uint256 maxAmount,uint256 nonce,uint256 deadline,uint256 previousConsumption,bytes32 previousSessionId)"
    );

    // ─── Enums ───
    enum SessionStatus { None, Reserved, Settled, TimedOut }

    // ─── Structs ───
    struct Session {
        address buyer;
        address seller;
        uint256 maxAmount;
        uint256 nonce;
        uint256 deadline;
        uint256 previousConsumption;
        bytes32 previousSessionId;
        uint256 reservedAt;
        uint256 settledAmount;
        SessionStatus status;
        bool isFirstSign;
        bool isProvenSign;
        bool isQualifiedProvenSign;
    }

    struct BuyerAccount {
        uint256 balance;
        uint256 reserved;            // total locked across active sessions
        uint256 withdrawalAmount;    // pending withdrawal request
        uint256 withdrawalRequestedAt;
        uint256 lastActivityAt;      // resets inactivity timer
    }

    struct SellerAccount {
        uint256 stake;
        uint256 earnings;
        uint256 stakedAt;
        uint256 tokenRate;           // credits per token (seller-published)
    }

    // ─── State ───
    IERC20 public immutable usdc;
    IAntseedIdentity public identityContract;
    IAntseedEmissions public emissionsContract;
    address public owner;
    address public protocolReserve;
    bool private _locked;

    mapping(bytes32 => Session) public sessions;
    mapping(address => BuyerAccount) public buyers;
    mapping(address => SellerAccount) public sellers;
    mapping(address => uint256) public uniqueSellersCharged;  // buyer → count of unique sellers
    mapping(address => mapping(address => bool)) private _buyerSellerPairs; // buyer→seller→charged
    mapping(address => mapping(address => uint256)) public firstSessionTimestamp; // buyer→seller→timestamp
    mapping(address => mapping(address => bytes32)) public latestSessionId; // buyer→seller→sessionId

    // ─── Events ───
    event Deposited(address indexed buyer, uint256 amount);
    event WithdrawalRequested(address indexed buyer, uint256 amount);
    event WithdrawalExecuted(address indexed buyer, uint256 amount);
    event WithdrawalCancelled(address indexed buyer);
    event Staked(address indexed seller, uint256 amount);
    event Unstaked(address indexed seller, uint256 amount, uint256 slashed);
    event Reserved(bytes32 indexed sessionId, address indexed buyer, address indexed seller, uint256 maxAmount, uint8 signType);
    event Settled(bytes32 indexed sessionId, uint256 chargedAmount, uint256 platformFee);
    event SettledTimeout(bytes32 indexed sessionId, uint256 returnedAmount);
    event EarningsClaimed(address indexed seller, uint256 amount);
    event ConstantUpdated(bytes32 indexed key, uint256 value);

    // ─── Errors ───
    error NotOwner();
    error InvalidAddress();
    error InvalidAmount();
    error InvalidSession();
    error InvalidSignature();
    error SessionExists();
    error SessionNotReserved();
    error SessionExpired();
    error InsufficientBalance();
    error InsufficientStake();
    error NotRegistered();
    error NonTransferable();
    error NotAuthorized();
    error Reentrancy();
    error TimeoutNotReached();
    error InactivityNotReached();
    error InvalidFee();
    error FirstSignCapExceeded();
    error CooldownNotElapsed();
    error InvalidProofChain();
    error BelowMinDeposit();
    error TransferFailed();
}
```

#### Acceptance Criteria
- [ ] `forge build` compiles without errors
- [ ] All constants have correct default values
- [ ] EIP-712 typehash matches the SpendingAuth struct fields exactly

---

## Task 2: AntseedEscrow — buyer deposit and withdrawal

### Description
Implement buyer deposit, withdrawal request/execute/cancel, and balance view.

##### MODIFY: `packages/node/contracts/AntseedEscrow.sol`

**Add constructor:**
```solidity
constructor(address _usdc, address _identity)
    EIP712("AntseedEscrow", "1")
{
    usdc = IERC20(_usdc);
    identityContract = IAntseedIdentity(_identity);
    owner = msg.sender;
    // Set defaults
    FIRST_SIGN_CAP = 1_000_000;
    MIN_BUYER_DEPOSIT = 10_000_000;
    // ... all other defaults ...
}
```

**Implement:**
- `deposit(uint256 amount)` — transfers USDC, enforces MIN_BUYER_DEPOSIT on first deposit, updates lastActivityAt
- `requestWithdrawal(uint256 amount)` — validates (balance - reserved - withdrawalAmount) >= amount, sets withdrawalAmount and timestamp
- `executeWithdrawal()` — validates BUYER_INACTIVITY_PERIOD elapsed since lastActivityAt, transfers USDC, zeros withdrawal
- `cancelWithdrawal()` — zeros withdrawalAmount
- `getBuyerBalance(address buyer) → (uint256 available, uint256 reserved, uint256 pendingWithdrawal, uint256 lastActivityAt)` — available = balance - reserved - withdrawalAmount

**Key logic:**
- `lastActivityAt` resets on: deposit, new session reserve, settle
- Withdrawal amount is a reservation — not deducted from balance until execution
- Available = balance - reserved - withdrawalAmount (chargeable amount)

#### Acceptance Criteria
- [ ] First deposit below MIN_BUYER_DEPOSIT reverts
- [ ] Subsequent deposits of any amount work
- [ ] Withdrawal only after BUYER_INACTIVITY_PERIOD of no activity
- [ ] `lastActivityAt` resets correctly on deposit
- [ ] Available balance correctly accounts for reservations and pending withdrawals

---

## Task 3: AntseedEscrow — seller staking

##### MODIFY: `packages/node/contracts/AntseedEscrow.sol`

**Implement:**
- `stake(uint256 amount)` — requires `identityContract.isRegistered(msg.sender)`, transfers USDC, updates stake and stakedAt
- `setTokenRate(uint256 rate)` — seller sets their credit-per-token rate
- `unstake()` — calculates slash based on reputation, returns (stake - slashAmount), sends slashed to protocolReserve
- `claimEarnings()` — transfers accumulated earnings to seller
- `getSellerAccount(address seller) → (uint256 stake, uint256 earnings, uint256 stakedAt, uint256 tokenRate)`

**Slashing logic in `_calculateSlash(address seller) → uint256`:**
```solidity
uint256 tokenId = identityContract.getTokenId(seller);
ProvenReputation memory rep = identityContract.getReputation(tokenId);
uint256 totalSigns = rep.firstSignCount + rep.qualifiedProvenSignCount + rep.unqualifiedProvenSignCount;

if (rep.qualifiedProvenSignCount == 0 && totalSigns > 0) return stake; // 100%
if (rep.qualifiedProvenSignCount > 0) {
    uint256 ratio = (rep.qualifiedProvenSignCount * 100) / totalSigns;
    if (ratio < SLASH_RATIO_THRESHOLD) return stake / 2; // 50%
}
if (rep.ghostCount >= SLASH_GHOST_THRESHOLD && rep.qualifiedProvenSignCount == 0) return stake; // 100%
if (rep.qualifiedProvenSignCount > 0) {
    uint256 ratio = (rep.qualifiedProvenSignCount * 100) / totalSigns;
    if (ratio >= SLASH_RATIO_THRESHOLD && (block.timestamp - rep.lastProvenAt) > SLASH_INACTIVITY_DAYS) {
        return stake / 5; // 20%
    }
}
return 0; // clean exit
```

#### Acceptance Criteria
- [ ] Only registered peers can stake
- [ ] Unregistered address reverts on stake()
- [ ] Slashing correctly applies all 5 tiers
- [ ] Slashed funds sent to protocolReserve
- [ ] Earnings claimable separately from stake

---

## Task 4: AntseedEscrow — reserve() with EIP-712 and proof chain

### Description
The core function. Validates buyer's EIP-712 signature, validates proof chain, classifies sign type, locks credits, updates reputation.

##### MODIFY: `packages/node/contracts/AntseedEscrow.sol`

**Implement `reserve()`:**

```solidity
function reserve(
    address buyer,
    bytes32 sessionId,
    uint256 maxAmount,
    uint256 nonce,
    uint256 deadline,
    uint256 previousConsumption,
    bytes32 previousSessionId,
    bytes calldata buyerSig
) external nonReentrant whenNotPaused {
    // 1. Basic validation
    if (sessions[sessionId].status != SessionStatus.None) revert SessionExists();
    if (block.timestamp > deadline) revert SessionExpired();
    if (sellers[msg.sender].stake == 0) revert InsufficientStake();

    // 2. EIP-712 signature verification
    bytes32 structHash = keccak256(abi.encode(
        SPENDING_AUTH_TYPEHASH,
        msg.sender,     // seller
        sessionId,
        maxAmount,
        nonce,
        deadline,
        previousConsumption,
        previousSessionId
    ));
    bytes32 digest = _hashTypedDataV4(structHash);
    address recoveredBuyer = ECDSA.recover(digest, buyerSig);
    if (recoveredBuyer != buyer) revert InvalidSignature();

    // 3. Classify sign type
    bool isFirstSign = (previousConsumption == 0 && previousSessionId == bytes32(0));
    bool isProvenSign = false;
    bool isQualifiedProvenSign = false;

    if (isFirstSign) {
        if (maxAmount > FIRST_SIGN_CAP) revert FirstSignCapExceeded();
        if (firstSessionTimestamp[buyer][msg.sender] == 0) {
            firstSessionTimestamp[buyer][msg.sender] = block.timestamp;
        }
    } else {
        // Validate proof chain
        Session storage prevSession = sessions[previousSessionId];
        if (prevSession.buyer != buyer || prevSession.seller != msg.sender) revert InvalidProofChain();
        if (prevSession.status != SessionStatus.Reserved && prevSession.status != SessionStatus.Settled)
            revert InvalidProofChain();
        if (previousConsumption < MIN_TOKEN_THRESHOLD) revert InvalidProofChain();

        // Check cooldown
        uint256 firstTime = firstSessionTimestamp[buyer][msg.sender];
        if (block.timestamp < firstTime + PROVEN_SIGN_COOLDOWN) revert CooldownNotElapsed();

        isProvenSign = true;

        // Check if qualified (buyer diversity)
        if (uniqueSellersCharged[buyer] >= BUYER_DIVERSITY_THRESHOLD) {
            isQualifiedProvenSign = true;
        }
    }

    // 4. Check buyer balance
    BuyerAccount storage ba = buyers[buyer];
    uint256 available = ba.balance - ba.reserved - ba.withdrawalAmount;
    if (available < maxAmount) revert InsufficientBalance();

    // 5. Lock credits
    ba.reserved += maxAmount;
    ba.lastActivityAt = block.timestamp;

    // 6. Store session
    sessions[sessionId] = Session({
        buyer: buyer,
        seller: msg.sender,
        maxAmount: maxAmount,
        nonce: nonce,
        deadline: deadline,
        previousConsumption: previousConsumption,
        previousSessionId: previousSessionId,
        reservedAt: block.timestamp,
        settledAmount: 0,
        status: SessionStatus.Reserved,
        isFirstSign: isFirstSign,
        isProvenSign: isProvenSign,
        isQualifiedProvenSign: isQualifiedProvenSign
    });

    // 7. Update latest session tracking
    latestSessionId[buyer][msg.sender] = sessionId;

    // 8. Update reputation on identity contract
    uint256 tokenId = identityContract.getTokenId(msg.sender);
    if (isFirstSign) {
        identityContract.updateReputation(tokenId, IAntseedIdentity.ReputationUpdate(0, 0));
    } else if (isQualifiedProvenSign) {
        identityContract.updateReputation(tokenId, IAntseedIdentity.ReputationUpdate(1, previousConsumption));
    } else if (isProvenSign) {
        identityContract.updateReputation(tokenId, IAntseedIdentity.ReputationUpdate(2, previousConsumption));
    }

    emit Reserved(sessionId, buyer, msg.sender, maxAmount,
        isFirstSign ? 0 : (isQualifiedProvenSign ? 2 : 1));
}
```

#### Acceptance Criteria
- [ ] Valid EIP-712 signature accepted
- [ ] Invalid signature reverts
- [ ] First sign: maxAmount capped at FIRST_SIGN_CAP
- [ ] Proven sign: previousSessionId must exist between same buyer-seller pair
- [ ] Proven sign: previousConsumption >= MIN_TOKEN_THRESHOLD
- [ ] Proven sign: cooldown enforced
- [ ] Qualified proven: buyer diversity >= BUYER_DIVERSITY_THRESHOLD
- [ ] Credits locked from buyer's available balance
- [ ] Reputation updated on AntseedIdentity

---

## Task 5: AntseedEscrow — settle() and settleTimeout()

##### MODIFY: `packages/node/contracts/AntseedEscrow.sol`

**Implement `settle()`:**
```solidity
function settle(bytes32 sessionId, uint256 tokenCount) external nonReentrant {
    Session storage s = sessions[sessionId];
    if (s.status != SessionStatus.Reserved) revert SessionNotReserved();
    if (s.seller != msg.sender) revert NotAuthorized();

    // Calculate charge: tokens * seller's token rate
    uint256 chargeAmount = tokenCount * sellers[msg.sender].tokenRate;
    if (chargeAmount > s.maxAmount) chargeAmount = s.maxAmount; // cap at reservation

    // Platform fee
    uint256 platformFee = (chargeAmount * PLATFORM_FEE_BPS) / 10000;
    uint256 sellerPayout = chargeAmount - platformFee;
    uint256 buyerRefund = s.maxAmount - chargeAmount;

    // Update buyer
    BuyerAccount storage ba = buyers[s.buyer];
    ba.balance -= chargeAmount;
    ba.reserved -= s.maxAmount;
    ba.lastActivityAt = block.timestamp;

    // Update seller
    sellers[msg.sender].earnings += sellerPayout;

    // Track buyer diversity
    if (!_buyerSellerPairs[s.buyer][msg.sender]) {
        _buyerSellerPairs[s.buyer][msg.sender] = true;
        uniqueSellersCharged[s.buyer]++;
    }

    // Update session
    s.settledAmount = chargeAmount;
    s.status = SessionStatus.Settled;

    // Transfer platform fee
    if (platformFee > 0 && protocolReserve != address(0)) {
        _safeTransfer(protocolReserve, platformFee);
    }

    // Accrue emission points (if emissions contract set)
    if (address(emissionsContract) != address(0)) {
        // Seller points
        uint256 tokenId = identityContract.getTokenId(msg.sender);
        if (s.isQualifiedProvenSign) {
            uint256 effectiveProven = _effectiveProvenSigns(msg.sender);
            uint256 sellerPointsDelta = effectiveProven * tokenCount;
            emissionsContract.accrueSellerPoints(msg.sender, sellerPointsDelta);
        }
        // Buyer points (if proven sign)
        if (s.isProvenSign) {
            uint256 buyerDiversity = uniqueSellersCharged[s.buyer];
            uint256 diversityMult = buyerDiversity > BUYER_DIVERSITY_THRESHOLD
                ? (buyerDiversity * 1e18 / BUYER_DIVERSITY_THRESHOLD)
                : 1e18;
            if (diversityMult > 2e18) diversityMult = 2e18; // cap at 2x
            uint256 buyerPointsDelta = (tokenCount * diversityMult) / 1e18;
            emissionsContract.accrueBuyerPoints(s.buyer, buyerPointsDelta);
        }
    }

    emit Settled(sessionId, chargeAmount, platformFee);
}
```

**Implement `settleTimeout()`:**
```solidity
function settleTimeout(bytes32 sessionId) external nonReentrant {
    Session storage s = sessions[sessionId];
    if (s.status != SessionStatus.Reserved) revert SessionNotReserved();
    if (block.timestamp < s.reservedAt + SETTLE_TIMEOUT) revert TimeoutNotReached();

    // Return all credits to buyer
    BuyerAccount storage ba = buyers[s.buyer];
    ba.reserved -= s.maxAmount;

    // Record ghost
    s.status = SessionStatus.TimedOut;
    uint256 tokenId = identityContract.getTokenId(s.seller);
    identityContract.updateReputation(tokenId, IAntseedIdentity.ReputationUpdate(3, 0)); // ghost

    emit SettledTimeout(sessionId, s.maxAmount);
}
```

**Helper:**
```solidity
function _effectiveProvenSigns(address seller) internal view returns (uint256) {
    uint256 tokenId = identityContract.getTokenId(seller);
    IAntseedIdentity.ProvenReputation memory rep = identityContract.getReputation(tokenId);
    uint256 stakeCap = (sellers[seller].stake * REPUTATION_CAP_COEFFICIENT) / 1_000_000;
    return rep.qualifiedProvenSignCount < stakeCap
        ? rep.qualifiedProvenSignCount
        : stakeCap;
}
```

#### Acceptance Criteria
- [ ] settle() charges tokenCount * tokenRate, capped at maxAmount
- [ ] Platform fee deducted correctly
- [ ] Buyer balance and reserved updated atomically
- [ ] Seller earnings incremented
- [ ] Buyer diversity tracked on first charge per pair
- [ ] Emission points accrued when emissions contract is set
- [ ] settleTimeout() only after SETTLE_TIMEOUT elapsed
- [ ] settleTimeout() returns all credits to buyer
- [ ] settleTimeout() records ghost event on identity

---

## Task 6: AntseedEscrow — admin functions

##### MODIFY: `packages/node/contracts/AntseedEscrow.sol`

**Implement:**
```solidity
function setConstant(bytes32 key, uint256 value) external onlyOwner {
    if (key == "FIRST_SIGN_CAP") FIRST_SIGN_CAP = value;
    else if (key == "MIN_BUYER_DEPOSIT") MIN_BUYER_DEPOSIT = value;
    else if (key == "MIN_SELLER_STAKE") MIN_SELLER_STAKE = value;
    else if (key == "MIN_TOKEN_THRESHOLD") MIN_TOKEN_THRESHOLD = value;
    else if (key == "BUYER_DIVERSITY_THRESHOLD") BUYER_DIVERSITY_THRESHOLD = value;
    else if (key == "PROVEN_SIGN_COOLDOWN") PROVEN_SIGN_COOLDOWN = value;
    else if (key == "BUYER_INACTIVITY_PERIOD") BUYER_INACTIVITY_PERIOD = value;
    else if (key == "SETTLE_TIMEOUT") SETTLE_TIMEOUT = value;
    else if (key == "REPUTATION_CAP_COEFFICIENT") REPUTATION_CAP_COEFFICIENT = value;
    else if (key == "SLASH_RATIO_THRESHOLD") SLASH_RATIO_THRESHOLD = value;
    else if (key == "SLASH_GHOST_THRESHOLD") SLASH_GHOST_THRESHOLD = value;
    else if (key == "SLASH_INACTIVITY_DAYS") SLASH_INACTIVITY_DAYS = value;
    else revert InvalidSession(); // reuse for unknown key
    emit ConstantUpdated(key, value);
}

function setPlatformFee(uint256 bps) external onlyOwner {
    if (bps > MAX_PLATFORM_FEE_BPS) revert InvalidFee();
    PLATFORM_FEE_BPS = bps;
}

function setProtocolReserve(address _reserve) external onlyOwner {
    protocolReserve = _reserve;
}

function setIdentityContract(address _identity) external onlyOwner {
    identityContract = IAntseedIdentity(_identity);
}

function setEmissionsContract(address _emissions) external onlyOwner {
    emissionsContract = IAntseedEmissions(_emissions);
}

function transferOwnership(address newOwner) external onlyOwner {
    if (newOwner == address(0)) revert InvalidAddress();
    owner = newOwner;
}
```

Also implement `pause()` / `unpause()` using OpenZeppelin Pausable. Add `nonReentrant` modifier and safe transfer helpers (carry over from current contract).

#### Acceptance Criteria
- [ ] All constants updatable by owner
- [ ] Non-owner reverts
- [ ] Platform fee capped at MAX_PLATFORM_FEE_BPS
- [ ] Pause/unpause works on reserve()

---

## Task 7: AntseedEscrow Foundry tests — buyer deposit/withdrawal

##### CREATE: `packages/node/contracts/test/AntseedEscrow.t.sol`

**Setup:**
- Deploy MockUSDC, ANTSToken, AntseedIdentity, AntseedEscrow
- Wire contracts: identity.setEscrowContract(escrow), mint USDC to test buyers
- Register a test seller on identity contract, stake

**Buyer tests:**
- **test_deposit:** First deposit >= MIN_BUYER_DEPOSIT works
- **test_deposit_revert_belowMin:** First deposit below threshold reverts
- **test_deposit_subsequent:** Additional deposits of any amount work
- **test_requestWithdrawal:** Sets withdrawal amount and timestamp
- **test_executeWithdrawal:** After inactivity period, transfers USDC
- **test_executeWithdrawal_revert_tooEarly:** Before inactivity period reverts
- **test_executeWithdrawal_revert_activityResets:** New activity resets timer
- **test_cancelWithdrawal:** Zeros pending withdrawal
- **test_getBuyerBalance:** Returns correct available, reserved, pending

#### Acceptance Criteria
- [ ] `forge test --match-contract AntseedEscrowBuyerTest` — all pass

---

## Task 8: AntseedEscrow Foundry tests — seller staking and slashing

**Test cases:**
- **test_stake:** Registered seller stakes USDC
- **test_stake_revert_notRegistered:** Unregistered address reverts
- **test_setTokenRate:** Seller sets rate
- **test_unstake_cleanExit:** Good ratio, recent activity → 0% slash
- **test_unstake_slash100_noProven:** Q=0, total>0 → 100% slash
- **test_unstake_slash50_lowRatio:** Ratio < 30% → 50% slash
- **test_unstake_slash100_ghosts:** 5+ ghosts, Q=0 → 100% slash
- **test_unstake_slash20_inactive:** Good ratio, no recent activity → 20% slash
- **test_claimEarnings:** Seller claims accumulated earnings

#### Acceptance Criteria
- [ ] `forge test --match-contract AntseedEscrowStakingTest` — all pass
- [ ] All 5 slashing tiers verified

---

## Task 9: AntseedEscrow Foundry tests — reserve() with proof chain

**Helper functions:**
```solidity
function _signSpendingAuth(
    uint256 buyerPrivateKey,
    address seller,
    bytes32 sessionId,
    uint256 maxAmount,
    uint256 nonce,
    uint256 deadline,
    uint256 previousConsumption,
    bytes32 previousSessionId
) internal view returns (bytes memory) {
    bytes32 structHash = keccak256(abi.encode(
        escrow.SPENDING_AUTH_TYPEHASH(),
        seller, sessionId, maxAmount, nonce, deadline,
        previousConsumption, previousSessionId
    ));
    bytes32 digest = MessageHashUtils.toTypedDataHash(escrow.DOMAIN_SEPARATOR(), structHash);
    (uint8 v, bytes32 r, bytes32 s) = vm.sign(buyerPrivateKey, digest);
    return abi.encodePacked(r, s, v);
}
```

**Test cases:**
- **test_reserve_firstSign:** previousConsumption=0, previousSessionId=0, maxAmount<=FIRST_SIGN_CAP
- **test_reserve_firstSign_revert_overCap:** maxAmount > FIRST_SIGN_CAP reverts
- **test_reserve_provenSign:** Chain from previous session, previousConsumption >= MIN_TOKEN_THRESHOLD
- **test_reserve_provenSign_revert_invalidChain:** Wrong previousSessionId reverts
- **test_reserve_provenSign_revert_belowMinTokens:** previousConsumption < MIN_TOKEN_THRESHOLD reverts
- **test_reserve_provenSign_revert_cooldown:** Before 7-day cooldown reverts
- **test_reserve_qualifiedProven:** Buyer has 3+ unique sellers → qualified
- **test_reserve_unqualifiedProven:** Buyer has < 3 sellers → unqualified
- **test_reserve_revert_invalidSig:** Tampered signature reverts
- **test_reserve_revert_expired:** Past deadline reverts
- **test_reserve_revert_insufficientBalance:** Buyer has insufficient available balance
- **test_reserve_revert_duplicateSession:** Same sessionId reverts
- **test_reserve_revert_noStake:** Unstaked seller reverts
- **test_reserve_updatesReputation:** Identity contract reputation counters updated

#### Acceptance Criteria
- [ ] `forge test --match-contract AntseedEscrowReserveTest` — all pass
- [ ] Full proof chain validated across multiple sessions

---

## Task 10: AntseedEscrow Foundry tests — settle() and settleTimeout()

**Test cases:**
- **test_settle:** Charges tokenCount * tokenRate, platform fee deducted, buyer refunded excess
- **test_settle_capAtMax:** When tokenCount * rate > maxAmount, charges maxAmount
- **test_settle_updatesDiversity:** First charge between buyer-seller increments uniqueSellersCharged
- **test_settle_revert_notSeller:** Non-seller reverts
- **test_settle_revert_notReserved:** Session not in Reserved status reverts
- **test_settleTimeout:** After SETTLE_TIMEOUT, credits returned to buyer
- **test_settleTimeout_revert_tooEarly:** Before timeout reverts
- **test_settleTimeout_recordsGhost:** Ghost count incremented on identity
- **test_settle_emissionPoints:** Seller and buyer points accrued when emissions contract set

#### Acceptance Criteria
- [ ] `forge test --match-contract AntseedEscrowSettleTest` — all pass

---

## Task 11: AntseedEscrow Foundry tests — admin and edge cases

**Test cases:**
- **test_setConstant:** Each constant updatable by owner
- **test_setConstant_revert_notOwner:** Non-owner reverts
- **test_setPlatformFee:** Valid fee set
- **test_setPlatformFee_revert_overMax:** Over MAX_PLATFORM_FEE_BPS reverts
- **test_pause_unpause:** Reserve reverts when paused
- **test_fullLifecycle:** Deposit → first sign → serve → disconnect → proven sign → settle → claim
- **test_multiSessionChain:** 5 sessions chained, each referencing previous
- **test_withdrawalReservation:** Pending withdrawal reduces available balance for reserve

#### Acceptance Criteria
- [ ] `forge test --match-contract AntseedEscrowAdminTest` — all pass
- [ ] Full lifecycle test demonstrates end-to-end flow

---

## Task 12: Update EIP-712 signatures module

##### MODIFY: `packages/node/src/payments/evm/signatures.ts`

**Replace ECDSA lock message builders with EIP-712 SpendingAuth:**

```typescript
export const SPENDING_AUTH_TYPES = {
  SpendingAuth: [
    { name: 'seller', type: 'address' },
    { name: 'sessionId', type: 'bytes32' },
    { name: 'maxAmount', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
    { name: 'previousConsumption', type: 'uint256' },
    { name: 'previousSessionId', type: 'bytes32' },
  ],
} as const;

export interface SpendingAuthMessage {
  seller: string;
  sessionId: string;
  maxAmount: bigint;
  nonce: number;
  deadline: number;
  previousConsumption: bigint;
  previousSessionId: string;
}

export function makeEscrowDomain(chainId: number, contractAddress: string): TypedDataDomain {
  return {
    name: 'AntseedEscrow',
    version: '1',
    chainId,
    verifyingContract: contractAddress,
  };
}

export async function signSpendingAuth(
  signer: AbstractSigner,
  domain: TypedDataDomain,
  msg: SpendingAuthMessage,
): Promise<string> {
  return signer.signTypedData(domain, SPENDING_AUTH_TYPES, msg);
}
```

**Keep Ed25519 receipt/ack functions unchanged** (buildReceiptMessage, buildAckMessage, sign/verify Ed25519).

**Remove deprecated functions:** `buildLockMessageHash`, `buildSettlementMessageHash`, `buildExtendLockMessageHash`, `signMessageEcdsa`.

#### Acceptance Criteria
- [ ] TypeScript compiles
- [ ] EIP-712 domain matches contract's EIP712 constructor ("AntseedEscrow", "1")
- [ ] SpendingAuth type matches contract's SPENDING_AUTH_TYPEHASH fields exactly
- [ ] Ed25519 functions preserved

---

## Task 13: Update EscrowClient TypeScript

##### MODIFY: `packages/node/src/payments/evm/escrow-client.ts`

**Replace ABI** with new contract interface (deposit, requestWithdrawal, executeWithdrawal, cancelWithdrawal, stake, unstake, setTokenRate, reserve, settle, settleTimeout, claimEarnings, getBuyerBalance, getSellerAccount, sessions view).

**Replace methods:**
- Remove: `commitLock`, `extendLock`, `settle` (old signature), `openDispute`, `respondDispute`, `releaseExpiredLock`
- Add: `deposit(signer, amount)`, `requestWithdrawal(signer, amount)`, `executeWithdrawal(signer)`, `cancelWithdrawal(signer)`
- Add: `stake(signer, amount)`, `unstake(signer)`, `setTokenRate(signer, rate)`, `claimEarnings(signer)`
- Add: `reserve(signer, buyer, sessionId, maxAmount, nonce, deadline, previousConsumption, previousSessionId, buyerSig)`
- Add: `settle(signer, sessionId, tokenCount)`
- Add: `settleTimeout(signer, sessionId)`
- Add: `getBuyerBalance(buyer)` → `{available, reserved, pendingWithdrawal, lastActivityAt}`
- Add: `getSellerAccount(seller)` → `{stake, earnings, stakedAt, tokenRate}`
- Add: `getSession(sessionId)` → Session struct

**Update config interface** to include `identityAddress` field.

#### Acceptance Criteria
- [ ] TypeScript compiles
- [ ] All new contract methods have corresponding client methods
- [ ] Return types match contract outputs
- [ ] Nonce management preserved

---

## Task 14: Update protocol types for SpendingAuth

##### MODIFY: `packages/node/src/types/protocol.ts`

**Replace message types:**
```typescript
// Payment message types
SpendingAuth = 0x50,      // was SessionLockAuth
AuthAck = 0x51,           // was SessionLockConfirm
// 0x52 reserved (was SessionLockReject — now rejection is implicit via no AuthAck)
SellerReceipt = 0x53,     // unchanged
BuyerAck = 0x54,          // unchanged
TopUpRequest = 0x55,      // was SessionEnd
// 0x56, 0x57 reserved
```

**Replace payload types:**
```typescript
export interface SpendingAuthPayload {
  sessionId: string;
  maxAmountUsdc: string;
  nonce: number;
  deadline: number;
  buyerSig: string;
  buyerEvmAddr: string;
  previousConsumption: string;
  previousSessionId: string;
}

export interface AuthAckPayload {
  sessionId: string;
  nonce: number;
}

// SellerReceiptPayload — unchanged
// BuyerAckPayload — unchanged

export interface TopUpRequestPayload {
  sessionId: string;
  currentUsed: string;
  currentMax: string;
  requestedAdditional: string;
}
```

**Remove:** SessionLockAuthPayload, SessionLockConfirmPayload, SessionLockRejectPayload, SessionEndPayload, TopUpAuthPayload, DisputeNotifyPayload.

#### Acceptance Criteria
- [ ] TypeScript compiles
- [ ] No references to removed types remain

---

## Task 15: Update PaymentCodec and PaymentMux

##### MODIFY: `packages/node/src/p2p/payment-codec.ts`

Replace codec functions to match new message types:
- `encodeSpendingAuth` / `decodeSpendingAuth` (replaces SessionLockAuth codec)
- `encodeAuthAck` / `decodeAuthAck` (replaces SessionLockConfirm codec)
- Keep: `encodeSellerReceipt` / `decodeSellerReceipt`
- Keep: `encodeBuyerAck` / `decodeBuyerAck`
- Keep: `encodeTopUpRequest` / `decodeTopUpRequest`
- Remove: SessionLockReject, SessionEnd, TopUpAuth, DisputeNotify codecs

##### MODIFY: `packages/node/src/p2p/payment-mux.ts`

Replace handler registration and send methods:
- `onSpendingAuth` / `sendSpendingAuth` (replaces onSessionLockAuth)
- `onAuthAck` / `sendAuthAck` (replaces onSessionLockConfirm)
- Keep: `onSellerReceipt` / `sendSellerReceipt`
- Keep: `onBuyerAck` / `sendBuyerAck`
- Keep: `onTopUpRequest` / `sendTopUpRequest`
- Remove: SessionLockReject, SessionEnd, TopUpAuth, DisputeNotify handlers/senders

Update `handleFrame` dispatch switch to match new message type codes.

#### Acceptance Criteria
- [ ] TypeScript compiles
- [ ] Round-trip encode/decode works for all message types
- [ ] PaymentMux dispatches correctly

---

## Task 16: Update existing tests

##### MODIFY: `packages/node/tests/payment-codec.test.ts`
Update to test SpendingAuth/AuthAck codecs instead of SessionLockAuth/Confirm/Reject/End.

##### MODIFY: `packages/node/tests/payment-mux.test.ts`
Update handler names and message types. Test dispatch for SpendingAuth, AuthAck, SellerReceipt, BuyerAck, TopUpRequest.

##### MODIFY: `packages/node/tests/buyer-payment-manager.test.ts`
Will need significant updates in PRD-03, but for now ensure it compiles with the new types (may need to stub/skip tests that reference removed message types).

#### Acceptance Criteria
- [ ] `pnpm --filter @antseed/node run test` — passes (some payment manager tests may be skipped pending PRD-03)
- [ ] Codec round-trip tests pass for all new message types
- [ ] Mux dispatch tests pass
