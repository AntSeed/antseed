// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../AntseedEscrow.sol";
import "../AntseedIdentity.sol";
import "../MockUSDC.sol";

// ═══════════════════════════════════════════════════════════════════
//                       SHARED BASE SETUP
// ═══════════════════════════════════════════════════════════════════

abstract contract AntseedEscrowTestBase is Test {
    AntseedEscrow public escrow;
    AntseedIdentity public identity;
    MockUSDC public usdc;

    address public owner;
    uint256 public buyerPk;
    address public buyer;
    uint256 public sellerPk;
    address public seller;
    address public seller2;
    address public seller3;

    bytes32 public sellerPeerId = keccak256("seller1");
    bytes32 public seller2PeerId = keccak256("seller2");
    bytes32 public seller3PeerId = keccak256("seller3");

    function setUp() public virtual {
        owner = address(this);
        buyerPk = 0xA11CE;
        buyer = vm.addr(buyerPk);
        sellerPk = 0xB0B;
        seller = vm.addr(sellerPk);
        seller2 = address(0x200);
        seller3 = address(0x300);

        // Deploy
        usdc = new MockUSDC();
        identity = new AntseedIdentity();
        escrow = new AntseedEscrow(address(usdc), address(identity));

        // Wire
        identity.setEscrowContract(address(escrow));
        escrow.setProtocolReserve(address(0xFEE));

        // Fund buyer
        usdc.mint(buyer, 1000_000_000); // 1000 USDC
        vm.prank(buyer);
        usdc.approve(address(escrow), type(uint256).max);

        // Register + stake sellers
        _registerAndStake(seller, sellerPk, sellerPeerId, 100_000_000);
        _registerAndStake(seller2, 0, seller2PeerId, 100_000_000);
        _registerAndStake(seller3, 0, seller3PeerId, 100_000_000);
    }

    function _registerAndStake(address s, uint256 /* pk */, bytes32 peerId, uint256 stakeAmount) internal {
        vm.prank(s);
        identity.register(peerId, "");
        usdc.mint(s, stakeAmount);
        vm.startPrank(s);
        usdc.approve(address(escrow), stakeAmount);
        escrow.stake(stakeAmount);
        escrow.setTokenRate(1); // 1 credit per token
        vm.stopPrank();
    }

    function _signSpendingAuth(
        uint256 pk,
        address _seller,
        bytes32 sessionId,
        uint256 maxAmount,
        uint256 nonce,
        uint256 deadline,
        uint256 previousConsumption,
        bytes32 previousSessionId
    ) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(abi.encode(
            escrow.SPENDING_AUTH_TYPEHASH(),
            _seller, sessionId, maxAmount, nonce, deadline,
            previousConsumption, previousSessionId
        ));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", escrow.domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _depositBuyer(uint256 amount) internal {
        vm.prank(buyer);
        escrow.deposit(amount);
    }

    function _reserveFirstSign(address _seller, bytes32 sessionId, uint256 maxAmount) internal {
        uint256 deadline = block.timestamp + 90000;
        bytes memory sig = _signSpendingAuth(buyerPk, _seller, sessionId, maxAmount, 1, deadline, 0, bytes32(0));
        vm.prank(_seller);
        escrow.reserve(buyer, sessionId, maxAmount, 1, deadline, 0, bytes32(0), sig);
    }

    function _settleSession(address _seller, bytes32 sessionId, uint256 tokenCount) internal {
        vm.prank(_seller);
        escrow.settle(sessionId, tokenCount);
    }

    /// @dev Do a complete first-sign + settle cycle with a given seller
    function _doFirstSignAndSettle(
        address _seller,
        bytes32 sessionId,
        uint256 maxAmount,
        uint256 tokenCount
    ) internal {
        _reserveFirstSign(_seller, sessionId, maxAmount);
        _settleSession(_seller, sessionId, tokenCount);
    }

    /// @dev Build a proven sign after a first sign. Warps past cooldown.
    function _reserveProvenSign(
        address _seller,
        bytes32 prevSessionId,
        uint256 prevConsumption,
        bytes32 newSessionId,
        uint256 maxAmount
    ) internal {
        // Warp past cooldown
        vm.warp(block.timestamp + escrow.PROVEN_SIGN_COOLDOWN() + 1);
        uint256 deadline = block.timestamp + 90000;
        bytes memory sig = _signSpendingAuth(
            buyerPk, _seller, newSessionId, maxAmount, 2, deadline, prevConsumption, prevSessionId
        );
        vm.prank(_seller);
        escrow.reserve(buyer, newSessionId, maxAmount, 2, deadline, prevConsumption, prevSessionId, sig);
    }
}

// ═══════════════════════════════════════════════════════════════════
//                  CONTRACT 1: BUYER TESTS (Task 7)
// ═══════════════════════════════════════════════════════════════════

contract AntseedEscrowBuyerTest is AntseedEscrowTestBase {

    function test_deposit() public {
        _depositBuyer(10_000_000); // 10 USDC (= MIN_BUYER_DEPOSIT)
        (uint256 available,,,) = escrow.getBuyerBalance(buyer);
        assertEq(available, 10_000_000);
    }

    function test_deposit_revert_belowMin() public {
        vm.prank(buyer);
        vm.expectRevert(AntseedEscrow.BelowMinDeposit.selector);
        escrow.deposit(9_999_999);
    }

    function test_deposit_revert_creditLimitExceeded() public {
        // Base credit limit is 10 USDC, try to deposit 11
        vm.prank(buyer);
        vm.expectRevert(AntseedEscrow.CreditLimitExceeded.selector);
        escrow.deposit(10_000_001);
    }

    function test_deposit_subsequent() public {
        // First deposit uses full limit
        _depositBuyer(10_000_000);
        // Increase limit via override so subsequent deposits work
        escrow.setCreditLimitOverride(buyer, 50_000_000);
        // Now deposit more
        vm.prank(buyer);
        escrow.deposit(5_000_000);
        (uint256 available,,,) = escrow.getBuyerBalance(buyer);
        assertEq(available, 15_000_000);
    }

    function test_creditLimit_growsWithUsage() public {
        // Override limit so we can deposit enough to run sessions
        escrow.setCreditLimitOverride(buyer, 500_000_000);
        _depositBuyer(100_000_000);

        // Run sessions with 3 different sellers to grow uniqueSellersCharged
        _doFirstSignAndSettle(seller, keccak256("s1"), 1_000_000, 500_000);
        _doFirstSignAndSettle(seller2, keccak256("s2"), 1_000_000, 500_000);
        _doFirstSignAndSettle(seller3, keccak256("s3"), 1_000_000, 500_000);

        // Remove override — computed limit should now be higher than base
        escrow.setCreditLimitOverride(buyer, 0);
        uint256 limit = escrow.getBuyerCreditLimit(buyer);
        // BASE + 3 * PEER_INTERACTION_BONUS = 10M + 3*5M = 25M
        assertGe(limit, 25_000_000);
    }

    function test_creditLimit_override() public {
        escrow.setCreditLimitOverride(buyer, 200_000_000);
        assertEq(escrow.getBuyerCreditLimit(buyer), 200_000_000);
        _depositBuyer(200_000_000);
        (uint256 available,,,) = escrow.getBuyerBalance(buyer);
        assertEq(available, 200_000_000);
    }

    function test_creditLimit_maxCap() public {
        // Set override very high, but computed should cap at MAX_CREDIT_LIMIT
        // To test the formula cap, we need many interactions
        // Easier: set the base ridiculously high via setConstant and check cap
        escrow.setConstant(keccak256("BASE_CREDIT_LIMIT"), 999_000_000_000);
        uint256 limit = escrow.getBuyerCreditLimit(buyer);
        assertEq(limit, escrow.MAX_CREDIT_LIMIT());
    }

    function test_getBuyerCreditLimit() public view {
        // Fresh buyer with no usage: should be BASE_CREDIT_LIMIT
        uint256 limit = escrow.getBuyerCreditLimit(buyer);
        assertEq(limit, escrow.BASE_CREDIT_LIMIT());
    }

    function test_requestWithdrawal() public {
        _depositBuyer(10_000_000);
        vm.prank(buyer);
        escrow.requestWithdrawal(5_000_000);
        (uint256 available,, uint256 pending,) = escrow.getBuyerBalance(buyer);
        assertEq(pending, 5_000_000);
        assertEq(available, 5_000_000);
    }

    function test_executeWithdrawal() public {
        _depositBuyer(10_000_000);
        vm.prank(buyer);
        escrow.requestWithdrawal(5_000_000);

        // Warp past SETTLE_TIMEOUT (request-based timelock)
        vm.warp(block.timestamp + escrow.SETTLE_TIMEOUT() + 1);

        uint256 balBefore = usdc.balanceOf(buyer);
        vm.prank(buyer);
        escrow.executeWithdrawal();
        uint256 balAfter = usdc.balanceOf(buyer);
        assertEq(balAfter - balBefore, 5_000_000);
    }

    function test_executeWithdrawal_revert_tooEarly() public {
        _depositBuyer(10_000_000);
        vm.prank(buyer);
        escrow.requestWithdrawal(5_000_000);

        // Warp less than SETTLE_TIMEOUT
        vm.warp(block.timestamp + escrow.SETTLE_TIMEOUT() - 1);

        vm.prank(buyer);
        vm.expectRevert(AntseedEscrow.TimeoutNotReached.selector);
        escrow.executeWithdrawal();
    }

    function test_executeWithdrawal_revert_activityResets() public {
        _depositBuyer(10_000_000);
        vm.prank(buyer);
        escrow.requestWithdrawal(5_000_000);

        // Warp 20 hours (not past SETTLE_TIMEOUT yet)
        vm.warp(block.timestamp + 20 hours);

        // New deposit — does NOT reset the withdrawal timelock (uses withdrawalRequestedAt)
        escrow.setCreditLimitOverride(buyer, 50_000_000);
        vm.prank(buyer);
        escrow.deposit(1_000_000);

        // Still within SETTLE_TIMEOUT from request — should revert
        vm.prank(buyer);
        vm.expectRevert(AntseedEscrow.TimeoutNotReached.selector);
        escrow.executeWithdrawal();
    }

    function test_cancelWithdrawal() public {
        _depositBuyer(10_000_000);
        vm.prank(buyer);
        escrow.requestWithdrawal(5_000_000);
        vm.prank(buyer);
        escrow.cancelWithdrawal();
        (,, uint256 pending,) = escrow.getBuyerBalance(buyer);
        assertEq(pending, 0);
    }

    function test_getBuyerBalance() public {
        escrow.setCreditLimitOverride(buyer, 50_000_000);
        _depositBuyer(20_000_000);

        // Reserve some via a first sign
        _reserveFirstSign(seller, keccak256("bal1"), 500_000);

        // Request withdrawal
        vm.prank(buyer);
        escrow.requestWithdrawal(1_000_000);

        (uint256 available, uint256 reserved, uint256 pending, uint256 lastActivity) = escrow.getBuyerBalance(buyer);
        assertEq(reserved, 500_000);
        assertEq(pending, 1_000_000);
        assertEq(available, 20_000_000 - 500_000 - 1_000_000);
        assertGt(lastActivity, 0);
    }
}

// ═══════════════════════════════════════════════════════════════════
//                CONTRACT 2: STAKING TESTS (Task 8)
// ═══════════════════════════════════════════════════════════════════

contract AntseedEscrowStakingTest is AntseedEscrowTestBase {

    function test_stake() public {
        // seller already staked in setUp; verify
        (uint256 stakeAmt,,,) = escrow.getSellerAccount(seller);
        assertEq(stakeAmt, 100_000_000);
    }

    function test_stake_revert_notRegistered() public {
        address nobody = address(0x999);
        usdc.mint(nobody, 10_000_000);
        vm.startPrank(nobody);
        usdc.approve(address(escrow), 10_000_000);
        vm.expectRevert(AntseedEscrow.NotRegistered.selector);
        escrow.stake(10_000_000);
        vm.stopPrank();
    }

    function test_setTokenRate() public {
        vm.prank(seller);
        escrow.setTokenRate(42);
        (,,, uint256 rate) = escrow.getSellerAccount(seller);
        assertEq(rate, 42);
    }

    function test_unstake_cleanExit() public {
        // Build good reputation: first sign + settle to get qualified proven status
        escrow.setCreditLimitOverride(buyer, 500_000_000);
        _depositBuyer(100_000_000);

        // Need 3 unique sellers for qualified status
        _doFirstSignAndSettle(seller, keccak256("c1"), 1_000_000, 500_000);
        _doFirstSignAndSettle(seller2, keccak256("c2"), 1_000_000, 500_000);
        _doFirstSignAndSettle(seller3, keccak256("c3"), 1_000_000, 500_000);

        // Now do a proven sign with seller (buyer is qualified — 3 unique sellers)
        _reserveProvenSign(seller, keccak256("c1"), 500_000, keccak256("c1p"), 1_000_000);
        _settleSession(seller, keccak256("c1p"), 500_000);

        // Unstake seller — should have 0% slash (good ratio, recent activity)
        uint256 balBefore = usdc.balanceOf(seller);
        vm.prank(seller);
        escrow.unstake();
        uint256 balAfter = usdc.balanceOf(seller);
        // Full stake returned (100M)
        assertEq(balAfter - balBefore, 100_000_000);
    }

    function test_unstake_slash100_noProven() public {
        // seller has firstSignCount from setUp but no proven signs
        // We need at least one reserve to get firstSignCount > 0 and Q=0 but totalSigns>0
        // Actually _calculateSlash checks qualifiedProvenSignCount + unqualifiedProvenSignCount
        // If Q=0 and totalSigns=0, slash logic falls through to tier 5 (no slash)
        // We need an unqualified proven sign to get totalSigns > 0 with Q=0

        escrow.setCreditLimitOverride(buyer, 500_000_000);
        _depositBuyer(50_000_000);

        // First sign + settle with seller
        _doFirstSignAndSettle(seller, keccak256("ns1"), 1_000_000, 500_000);

        // Proven sign (unqualified — buyer only charged by 1 seller, threshold is 3)
        _reserveProvenSign(seller, keccak256("ns1"), 500_000, keccak256("ns1p"), 1_000_000);
        _settleSession(seller, keccak256("ns1p"), 500_000);

        // Now seller has: Q=0, unqualifiedProvenSignCount=1, totalSigns=1
        // Tier 1: Q==0 && totalSigns>0 → 100% slash
        uint256 balBefore = usdc.balanceOf(seller);
        vm.prank(seller);
        escrow.unstake();
        uint256 balAfter = usdc.balanceOf(seller);
        // 100% slashed — seller gets 0 of their stake
        assertEq(balAfter - balBefore, 0);
    }

    function test_unstake_slash50_lowRatio() public {
        escrow.setCreditLimitOverride(buyer, 500_000_000);
        _depositBuyer(100_000_000);

        // Get qualified proven: need 3 unique sellers
        _doFirstSignAndSettle(seller, keccak256("lr1"), 1_000_000, 500_000);
        _doFirstSignAndSettle(seller2, keccak256("lr2"), 1_000_000, 500_000);
        _doFirstSignAndSettle(seller3, keccak256("lr3"), 1_000_000, 500_000);

        // 1 qualified proven sign with seller
        _reserveProvenSign(seller, keccak256("lr1"), 500_000, keccak256("lr1q"), 1_000_000);
        _settleSession(seller, keccak256("lr1q"), 500_000);
        // Q=1, totalSigns=1 → ratio=100%, not low

        // Add 4 unqualified proven signs to make ratio < 30%
        // We need a second buyer who has < 3 unique sellers
        // Actually, we can use the same buyer but with a different seller pair that hasn't reached diversity
        // Simpler: use vm.store to manipulate reputation directly

        uint256 sellerTokenId = identity.getTokenId(seller);
        // ProvenReputation storage layout in _reputation mapping:
        // slot = keccak256(abi.encode(sellerTokenId, uint256(REPUTATION_SLOT)))
        // Pack: firstSignCount(u64), qualifiedProvenSignCount(u64), unqualifiedProvenSignCount(u64), ghostCount(u64)
        // Let's just set unqualifiedProvenSignCount high via identity update
        // Identity only allows escrow to call updateReputation, and we are the test contract (owner of identity)
        // We need to call from the escrow address. Instead, let's set the escrow contract to this test temporarily.

        address originalEscrow = identity.escrowContract();
        identity.setEscrowContract(address(this));

        // Add 9 unqualified proven signs → Q=1, total=10, ratio=10% < 30%
        for (uint256 i = 0; i < 9; i++) {
            identity.updateReputation(
                sellerTokenId,
                AntseedIdentity.ReputationUpdate({ updateType: 2, tokenVolume: 0 })
            );
        }

        // Restore escrow
        identity.setEscrowContract(originalEscrow);

        // Verify: Q=1, unqualified=9+1=10 (1 from real proven sign), total=11, ratio=1/11*100=9% < 30%
        AntseedIdentity.ProvenReputation memory rep = identity.getReputation(sellerTokenId);
        assertEq(uint256(rep.qualifiedProvenSignCount), 1);
        assertGe(uint256(rep.unqualifiedProvenSignCount), 9);

        uint256 totalSigns = uint256(rep.qualifiedProvenSignCount) + uint256(rep.unqualifiedProvenSignCount);
        uint256 ratio = (uint256(rep.qualifiedProvenSignCount) * 100) / totalSigns;
        assertLt(ratio, 30);

        // Unstake: Tier 2 — 50% slash
        uint256 balBefore = usdc.balanceOf(seller);
        vm.prank(seller);
        escrow.unstake();
        uint256 balAfter = usdc.balanceOf(seller);
        assertEq(balAfter - balBefore, 50_000_000); // 50% of 100M stake
    }

    function test_unstake_slash100_ghosts() public {
        escrow.setCreditLimitOverride(buyer, 500_000_000);
        _depositBuyer(50_000_000);

        // Create 5 sessions and let them timeout to accumulate ghosts
        for (uint256 i = 0; i < 5; i++) {
            bytes32 sid = keccak256(abi.encodePacked("ghost", i));
            _reserveFirstSign(seller, sid, 500_000);
            vm.warp(block.timestamp + escrow.SETTLE_TIMEOUT() + 1);
            vm.prank(buyer);
            escrow.settleTimeout(sid);
        }

        // seller now has ghostCount=5, Q=0, totalSigns=0
        // Tier 3: ghostCount >= SLASH_GHOST_THRESHOLD && Q==0 → 100% slash
        // But wait — Tier 1 checks Q==0 && totalSigns>0. totalSigns = Q + unqualified = 0+0 = 0
        // So Tier 1 won't fire. Tier 3: ghosts>=5 && Q==0 → 100%
        uint256 balBefore = usdc.balanceOf(seller);
        vm.prank(seller);
        escrow.unstake();
        uint256 balAfter = usdc.balanceOf(seller);
        assertEq(balAfter - balBefore, 0); // 100% slashed
    }

    function test_unstake_slash20_inactive() public {
        escrow.setCreditLimitOverride(buyer, 500_000_000);
        _depositBuyer(100_000_000);

        // Build good reputation
        _doFirstSignAndSettle(seller, keccak256("in1"), 1_000_000, 500_000);
        _doFirstSignAndSettle(seller2, keccak256("in2"), 1_000_000, 500_000);
        _doFirstSignAndSettle(seller3, keccak256("in3"), 1_000_000, 500_000);

        // Qualified proven sign
        _reserveProvenSign(seller, keccak256("in1"), 500_000, keccak256("in1q"), 1_000_000);
        _settleSession(seller, keccak256("in1q"), 500_000);

        // Warp past inactivity threshold (30 days)
        vm.warp(block.timestamp + escrow.SLASH_INACTIVITY_DAYS() + 1);

        // Tier 4: good ratio but inactive → 20% slash
        uint256 balBefore = usdc.balanceOf(seller);
        vm.prank(seller);
        escrow.unstake();
        uint256 balAfter = usdc.balanceOf(seller);
        // 20% slash = 80% returned = 80M
        assertEq(balAfter - balBefore, 80_000_000);
    }

    function test_claimEarnings() public {
        escrow.setCreditLimitOverride(buyer, 500_000_000);
        _depositBuyer(50_000_000);

        _doFirstSignAndSettle(seller, keccak256("cl1"), 1_000_000, 500_000);

        // Seller has earnings (500_000 tokens * rate 1 = 500_000 charge, minus 5% fee = 475_000)
        (, uint256 earnings,,) = escrow.getSellerAccount(seller);
        assertEq(earnings, 475_000);

        uint256 balBefore = usdc.balanceOf(seller);
        vm.prank(seller);
        escrow.claimEarnings();
        uint256 balAfter = usdc.balanceOf(seller);
        assertEq(balAfter - balBefore, 475_000);
    }
}

// ═══════════════════════════════════════════════════════════════════
//                CONTRACT 3: RESERVE TESTS (Task 9)
// ═══════════════════════════════════════════════════════════════════

contract AntseedEscrowReserveTest is AntseedEscrowTestBase {

    function setUp() public override {
        super.setUp();
        escrow.setCreditLimitOverride(buyer, 500_000_000);
        _depositBuyer(100_000_000);
    }

    function test_reserve_firstSign() public {
        bytes32 sid = keccak256("fs1");
        _reserveFirstSign(seller, sid, 500_000);

        (address sBuyer, address sSeller,,,,,,,,,,,,, ) = escrow.sessions(sid);
        assertEq(sBuyer, buyer);
        assertEq(sSeller, seller);
    }

    function test_reserve_firstSign_revert_overCap() public {
        bytes32 sid = keccak256("fscap");
        uint256 overCap = escrow.FIRST_SIGN_CAP() + 1;
        uint256 deadline = block.timestamp + 90000;
        bytes memory sig = _signSpendingAuth(buyerPk, seller, sid, overCap, 1, deadline, 0, bytes32(0));
        vm.prank(seller);
        vm.expectRevert(AntseedEscrow.FirstSignCapExceeded.selector);
        escrow.reserve(buyer, sid, overCap, 1, deadline, 0, bytes32(0), sig);
    }

    function test_reserve_provenSign() public {
        bytes32 sid1 = keccak256("ps1");
        _doFirstSignAndSettle(seller, sid1, 1_000_000, 500_000);
        _doFirstSignAndSettle(seller2, keccak256("ps2"), 1_000_000, 500_000);
        _doFirstSignAndSettle(seller3, keccak256("ps3"), 1_000_000, 500_000);

        bytes32 sid2 = keccak256("ps1proven");
        _reserveProvenSign(seller, sid1, 500_000, sid2, 5_000_000);

        (address sBuyer,,,,,,,,,,,,,bool isProven,) = escrow.sessions(sid2);
        assertEq(sBuyer, buyer);
        assertTrue(isProven);
    }

    function test_reserve_provenSign_revert_invalidChain() public {
        _doFirstSignAndSettle(seller, keccak256("ic1"), 1_000_000, 500_000);

        vm.warp(block.timestamp + escrow.PROVEN_SIGN_COOLDOWN() + 1);

        // Use wrong previousSessionId
        bytes32 wrongPrev = keccak256("nonexistent");
        bytes32 sid2 = keccak256("ic2");
        uint256 deadline = block.timestamp + 90000;
        bytes memory sig = _signSpendingAuth(buyerPk, seller, sid2, 5_000_000, 2, deadline, 500_000, wrongPrev);
        vm.prank(seller);
        vm.expectRevert(AntseedEscrow.InvalidProofChain.selector);
        escrow.reserve(buyer, sid2, 5_000_000, 2, deadline, 500_000, wrongPrev, sig);
    }

    function test_reserve_provenSign_revert_belowMinTokens() public {
        bytes32 sid1 = keccak256("mt1");
        _doFirstSignAndSettle(seller, sid1, 1_000_000, 500_000);

        vm.warp(block.timestamp + escrow.PROVEN_SIGN_COOLDOWN() + 1);

        // prevConsumption below MIN_TOKEN_THRESHOLD
        uint256 lowConsumption = escrow.MIN_TOKEN_THRESHOLD() - 1;
        bytes32 sid2 = keccak256("mt2");
        uint256 deadline = block.timestamp + 90000;
        bytes memory sig = _signSpendingAuth(buyerPk, seller, sid2, 5_000_000, 2, deadline, lowConsumption, sid1);
        vm.prank(seller);
        vm.expectRevert(AntseedEscrow.InvalidProofChain.selector);
        escrow.reserve(buyer, sid2, 5_000_000, 2, deadline, lowConsumption, sid1, sig);
    }

    function test_reserve_provenSign_revert_cooldown() public {
        bytes32 sid1 = keccak256("cd1");
        _doFirstSignAndSettle(seller, sid1, 1_000_000, 500_000);

        // Don't warp — cooldown not elapsed
        bytes32 sid2 = keccak256("cd2");
        uint256 deadline = block.timestamp + 90000;
        bytes memory sig = _signSpendingAuth(buyerPk, seller, sid2, 5_000_000, 2, deadline, 500_000, sid1);
        vm.prank(seller);
        vm.expectRevert(AntseedEscrow.CooldownNotElapsed.selector);
        escrow.reserve(buyer, sid2, 5_000_000, 2, deadline, 500_000, sid1, sig);
    }

    function test_reserve_qualifiedProven() public {
        // Charge by 3 different sellers first
        _doFirstSignAndSettle(seller, keccak256("qp1"), 1_000_000, 500_000);
        _doFirstSignAndSettle(seller2, keccak256("qp2"), 1_000_000, 500_000);
        _doFirstSignAndSettle(seller3, keccak256("qp3"), 1_000_000, 500_000);

        assertEq(escrow.uniqueSellersCharged(buyer), 3);

        // Proven sign with seller — should be qualified
        _reserveProvenSign(seller, keccak256("qp1"), 500_000, keccak256("qp1q"), 5_000_000);

        (,,,,,,,,,,,,,, bool isQualified) = escrow.sessions(keccak256("qp1q"));
        assertTrue(isQualified);
    }

    function test_reserve_unqualifiedProven() public {
        // Only 1 seller charged
        _doFirstSignAndSettle(seller, keccak256("uq1"), 1_000_000, 500_000);

        assertLt(escrow.uniqueSellersCharged(buyer), escrow.BUYER_DIVERSITY_THRESHOLD());

        _reserveProvenSign(seller, keccak256("uq1"), 500_000, keccak256("uq1p"), 5_000_000);

        (,,,,,,,,,,,,bool isProven, bool isProvenFlag, bool isQualified) = escrow.sessions(keccak256("uq1p"));
        // isProvenSign should be true, isQualifiedProvenSign should be false
        assertTrue(isProvenFlag);
        assertFalse(isQualified);
    }

    function test_reserve_revert_invalidSig() public {
        bytes32 sid = keccak256("isig");
        uint256 deadline = block.timestamp + 90000;
        // Sign with wrong key
        bytes memory sig = _signSpendingAuth(0xDEAD, seller, sid, 500_000, 1, deadline, 0, bytes32(0));
        vm.prank(seller);
        vm.expectRevert(AntseedEscrow.InvalidSignature.selector);
        escrow.reserve(buyer, sid, 500_000, 1, deadline, 0, bytes32(0), sig);
    }

    function test_reserve_revert_expired() public {
        bytes32 sid = keccak256("exp");
        uint256 deadline = block.timestamp - 1; // past
        bytes memory sig = _signSpendingAuth(buyerPk, seller, sid, 500_000, 1, deadline, 0, bytes32(0));
        vm.prank(seller);
        vm.expectRevert(AntseedEscrow.SessionExpired.selector);
        escrow.reserve(buyer, sid, 500_000, 1, deadline, 0, bytes32(0), sig);
    }

    function test_reserve_revert_shortDeadline() public {
        bytes32 sid = keccak256("short");
        uint256 deadline = block.timestamp + 3600; // 1h < SETTLE_TIMEOUT (24h)
        bytes memory sig = _signSpendingAuth(buyerPk, seller, sid, 500_000, 1, deadline, 0, bytes32(0));
        vm.prank(seller);
        vm.expectRevert(AntseedEscrow.SessionExpired.selector);
        escrow.reserve(buyer, sid, 500_000, 1, deadline, 0, bytes32(0), sig);
    }

    function test_reserve_revert_insufficientBalance() public {
        // Remove override and set buyer balance to just enough for a small deposit
        escrow.setCreditLimitOverride(buyer, 0);
        // Buyer has 100M deposited from setUp. Reserve most of it via multiple first signs.
        // Actually, buyer credit limit is 500M (override set in setUp). Let's use a buyer with low balance.
        // Create a new buyer with minimal deposit
        address buyer2 = address(0x4242);
        uint256 buyer2Pk = 0xCAFE;
        buyer2 = vm.addr(buyer2Pk);
        usdc.mint(buyer2, 10_000_000);
        vm.startPrank(buyer2);
        usdc.approve(address(escrow), type(uint256).max);
        escrow.deposit(10_000_000); // exactly 10 USDC
        vm.stopPrank();

        // Reserve 9M, leaving only 1M available
        bytes32 sid1 = keccak256("ib0");
        uint256 deadline = block.timestamp + 90000;
        bytes memory sig1 = _signSpendingAuth(buyer2Pk, seller, sid1, 900_000, 1, deadline, 0, bytes32(0));
        vm.prank(seller);
        escrow.reserve(buyer2, sid1, 900_000, 1, deadline, 0, bytes32(0), sig1);

        // Now try to reserve 1M with only ~9.1M available — but need > available
        // Available = 10M - 900K = 9.1M. Cap is 1M for first sign. So maxAmount=1M within cap.
        // Actually 9.1M > 1M so it won't fail for balance.
        // We need to exhaust balance. Reserve many times.
        // Simpler: reserve the full remaining amount, then try one more.
        for (uint256 i = 1; i <= 9; i++) {
            bytes32 sid = keccak256(abi.encodePacked("ib", i));
            uint256 dl = block.timestamp + 90000;
            bytes memory s = _signSpendingAuth(buyer2Pk, seller, sid, 1_000_000, uint256(i) + 1, dl, 0, bytes32(0));
            vm.prank(seller);
            escrow.reserve(buyer2, sid, 1_000_000, uint256(i) + 1, dl, 0, bytes32(0), s);
        }
        // Now: reserved = 900K + 9*1M = 9.9M, available = 10M - 9.9M = 100K

        bytes32 sidFinal = keccak256("ibFinal");
        uint256 dlFinal = block.timestamp + 90000;
        bytes memory sigFinal = _signSpendingAuth(buyer2Pk, seller, sidFinal, 200_000, 99, dlFinal, 0, bytes32(0));
        vm.prank(seller);
        vm.expectRevert(AntseedEscrow.InsufficientBalance.selector);
        escrow.reserve(buyer2, sidFinal, 200_000, 99, dlFinal, 0, bytes32(0), sigFinal);
    }

    function test_reserve_revert_duplicateSession() public {
        bytes32 sid = keccak256("dup");
        _reserveFirstSign(seller, sid, 500_000);

        uint256 deadline = block.timestamp + 90000;
        bytes memory sig = _signSpendingAuth(buyerPk, seller2, sid, 500_000, 1, deadline, 0, bytes32(0));
        vm.prank(seller2);
        vm.expectRevert(AntseedEscrow.SessionExists.selector);
        escrow.reserve(buyer, sid, 500_000, 1, deadline, 0, bytes32(0), sig);
    }

    function test_reserve_revert_noStake() public {
        address nobody = address(0x999);
        vm.prank(nobody);
        identity.register(keccak256("nobody"), "");
        // nobody has no stake

        bytes32 sid = keccak256("ns");
        uint256 deadline = block.timestamp + 90000;
        bytes memory sig = _signSpendingAuth(buyerPk, nobody, sid, 500_000, 1, deadline, 0, bytes32(0));
        vm.prank(nobody);
        vm.expectRevert(AntseedEscrow.InsufficientStake.selector);
        escrow.reserve(buyer, sid, 500_000, 1, deadline, 0, bytes32(0), sig);
    }

    function test_reserve_updatesReputation() public {
        uint256 tokenId = identity.getTokenId(seller);
        AntseedIdentity.ProvenReputation memory repBefore = identity.getReputation(tokenId);

        _reserveFirstSign(seller, keccak256("rep1"), 500_000);

        AntseedIdentity.ProvenReputation memory repAfter = identity.getReputation(tokenId);
        assertEq(uint256(repAfter.firstSignCount), uint256(repBefore.firstSignCount) + 1);
    }
}

// ═══════════════════════════════════════════════════════════════════
//                CONTRACT 4: SETTLE TESTS (Task 10)
// ═══════════════════════════════════════════════════════════════════

contract AntseedEscrowSettleTest is AntseedEscrowTestBase {

    function setUp() public override {
        super.setUp();
        escrow.setCreditLimitOverride(buyer, 500_000_000);
        _depositBuyer(100_000_000);
    }

    function test_settle() public {
        bytes32 sid = keccak256("st1");
        _reserveFirstSign(seller, sid, 1_000_000);

        uint256 buyerBalBefore;
        (buyerBalBefore,,,) = escrow.getBuyerBalance(buyer);

        _settleSession(seller, sid, 500_000);

        // chargeAmount = 500_000 * 1 = 500_000
        // platformFee = 500_000 * 500 / 10000 = 25_000
        // sellerPayout = 475_000
        (, uint256 earnings,,) = escrow.getSellerAccount(seller);
        assertEq(earnings, 475_000);

        // Platform fee sent to protocolReserve
        assertEq(usdc.balanceOf(address(0xFEE)), 25_000);
    }

    function test_settle_capAtMax() public {
        bytes32 sid = keccak256("cap1");
        _reserveFirstSign(seller, sid, 500_000); // maxAmount = 500_000

        // Settle with tokenCount that would exceed maxAmount
        _settleSession(seller, sid, 1_000_000); // 1M * rate 1 = 1M > 500K → capped

        // Check charge was capped at maxAmount
        (,,uint256 maxAmt,,,,,,uint256 settledAmt,,,,,,) = escrow.sessions(sid);
        assertEq(settledAmt, maxAmt);
    }

    function test_settle_updatesDiversity() public {
        assertEq(escrow.uniqueSellersCharged(buyer), 0);

        _doFirstSignAndSettle(seller, keccak256("div1"), 1_000_000, 500_000);
        assertEq(escrow.uniqueSellersCharged(buyer), 1);

        _doFirstSignAndSettle(seller2, keccak256("div2"), 1_000_000, 500_000);
        assertEq(escrow.uniqueSellersCharged(buyer), 2);

        // Same seller again — should not increment
        _doFirstSignAndSettle(seller, keccak256("div3"), 1_000_000, 500_000);
        assertEq(escrow.uniqueSellersCharged(buyer), 2);
    }

    function test_settle_revert_notSeller() public {
        bytes32 sid = keccak256("rns1");
        _reserveFirstSign(seller, sid, 500_000);

        vm.prank(seller2); // wrong seller
        vm.expectRevert(AntseedEscrow.NotAuthorized.selector);
        escrow.settle(sid, 100_000);
    }

    function test_settle_revert_notReserved() public {
        bytes32 sid = keccak256("rnr1");
        _doFirstSignAndSettle(seller, sid, 1_000_000, 500_000);

        // Try to settle again (already settled)
        vm.prank(seller);
        vm.expectRevert(AntseedEscrow.SessionNotReserved.selector);
        escrow.settle(sid, 100_000);
    }

    function test_settleTimeout() public {
        bytes32 sid = keccak256("to1");
        _reserveFirstSign(seller, sid, 500_000);

        (, uint256 reservedBefore,,) = escrow.getBuyerBalance(buyer);
        assertEq(reservedBefore, 500_000);

        vm.warp(block.timestamp + escrow.SETTLE_TIMEOUT() + 1);
        vm.prank(buyer);
        escrow.settleTimeout(sid);

        (, uint256 reservedAfter,,) = escrow.getBuyerBalance(buyer);
        assertEq(reservedAfter, 0);
    }

    function test_settleTimeout_revert_tooEarly() public {
        bytes32 sid = keccak256("toe1");
        _reserveFirstSign(seller, sid, 500_000);

        vm.prank(buyer);
        vm.expectRevert(AntseedEscrow.TimeoutNotReached.selector);
        escrow.settleTimeout(sid);
    }

    function test_settleTimeout_recordsGhost() public {
        bytes32 sid = keccak256("gh1");
        _reserveFirstSign(seller, sid, 500_000);

        uint256 tokenId = identity.getTokenId(seller);
        AntseedIdentity.ProvenReputation memory repBefore = identity.getReputation(tokenId);

        vm.warp(block.timestamp + escrow.SETTLE_TIMEOUT() + 1);
        vm.prank(buyer);
        escrow.settleTimeout(sid);

        AntseedIdentity.ProvenReputation memory repAfter = identity.getReputation(tokenId);
        assertEq(uint256(repAfter.ghostCount), uint256(repBefore.ghostCount) + 1);
    }
}

// ═══════════════════════════════════════════════════════════════════
//                CONTRACT 5: ADMIN TESTS (Task 11)
// ═══════════════════════════════════════════════════════════════════

contract AntseedEscrowAdminTest is AntseedEscrowTestBase {

    function test_setConstant_firstSignCap() public {
        escrow.setConstant(keccak256("FIRST_SIGN_CAP"), 2_000_000);
        assertEq(escrow.FIRST_SIGN_CAP(), 2_000_000);
    }

    function test_setConstant_minBuyerDeposit() public {
        escrow.setConstant(keccak256("MIN_BUYER_DEPOSIT"), 5_000_000);
        assertEq(escrow.MIN_BUYER_DEPOSIT(), 5_000_000);
    }

    function test_setConstant_settleTimeout() public {
        escrow.setConstant(keccak256("SETTLE_TIMEOUT"), 48 hours);
        assertEq(escrow.SETTLE_TIMEOUT(), 48 hours);
    }

    function test_setConstant_revert_notOwner() public {
        vm.prank(buyer);
        vm.expectRevert(AntseedEscrow.NotOwner.selector);
        escrow.setConstant(keccak256("FIRST_SIGN_CAP"), 999);
    }

    function test_setConstant_revert_invalidKey() public {
        vm.expectRevert(AntseedEscrow.InvalidAmount.selector);
        escrow.setConstant(keccak256("NONEXISTENT"), 999);
    }

    function test_setPlatformFee() public {
        escrow.setPlatformFee(300);
        assertEq(escrow.PLATFORM_FEE_BPS(), 300);
    }

    function test_setPlatformFee_revert_overMax() public {
        vm.expectRevert(AntseedEscrow.InvalidFee.selector);
        escrow.setPlatformFee(1001); // > MAX_PLATFORM_FEE_BPS (1000 = 10%)
    }

    function test_pause_unpause() public {
        escrow.setCreditLimitOverride(buyer, 500_000_000);
        _depositBuyer(50_000_000);

        escrow.pause();

        // Reserve should revert when paused
        bytes32 sid = keccak256("paused");
        uint256 deadline = block.timestamp + 90000;
        bytes memory sig = _signSpendingAuth(buyerPk, seller, sid, 500_000, 1, deadline, 0, bytes32(0));
        vm.prank(seller);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        escrow.reserve(buyer, sid, 500_000, 1, deadline, 0, bytes32(0), sig);

        // Unpause
        escrow.unpause();

        // Should work now
        vm.prank(seller);
        escrow.reserve(buyer, sid, 500_000, 1, deadline, 0, bytes32(0), sig);
    }

    function test_fullLifecycle() public {
        escrow.setCreditLimitOverride(buyer, 500_000_000);
        _depositBuyer(100_000_000);

        // First sign
        bytes32 sid1 = keccak256("life1");
        _doFirstSignAndSettle(seller, sid1, 1_000_000, 500_000);

        // Settle with 2 more sellers for diversity
        _doFirstSignAndSettle(seller2, keccak256("life2"), 1_000_000, 500_000);
        _doFirstSignAndSettle(seller3, keccak256("life3"), 1_000_000, 500_000);

        // Proven sign after cooldown
        bytes32 sid2 = keccak256("life1p");
        _reserveProvenSign(seller, sid1, 500_000, sid2, 5_000_000);
        _settleSession(seller, sid2, 2_000_000);

        // Claim earnings
        (, uint256 earnings,,) = escrow.getSellerAccount(seller);
        assertGt(earnings, 0);
        vm.prank(seller);
        escrow.claimEarnings();
        (, uint256 earningsAfter,,) = escrow.getSellerAccount(seller);
        assertEq(earningsAfter, 0);
    }

    function test_multiSessionChain() public {
        escrow.setCreditLimitOverride(buyer, 500_000_000);
        _depositBuyer(100_000_000);

        // Also charge from other sellers for diversity
        _doFirstSignAndSettle(seller2, keccak256("chain_d1"), 1_000_000, 500_000);
        _doFirstSignAndSettle(seller3, keccak256("chain_d2"), 1_000_000, 500_000);

        // Session 1: first sign
        bytes32 sid1 = keccak256("chain1");
        _doFirstSignAndSettle(seller, sid1, 1_000_000, 500_000);

        // Session 2: proven sign chained to session 1
        bytes32 sid2 = keccak256("chain2");
        _reserveProvenSign(seller, sid1, 500_000, sid2, 5_000_000);
        _settleSession(seller, sid2, 2_000_000);

        // Session 3: proven sign chained to session 2
        bytes32 sid3 = keccak256("chain3");
        vm.warp(block.timestamp + escrow.PROVEN_SIGN_COOLDOWN() + 1);
        uint256 deadline = block.timestamp + 90000;
        bytes memory sig = _signSpendingAuth(buyerPk, seller, sid3, 5_000_000, 3, deadline, 2_000_000, sid2);
        vm.prank(seller);
        escrow.reserve(buyer, sid3, 5_000_000, 3, deadline, 2_000_000, sid2, sig);

        // Verify chain is valid
        (address b3,,,,,,bytes32 prevSid,,,,,,,,) = escrow.sessions(sid3);
        assertEq(b3, buyer);
        assertEq(prevSid, sid2);
    }

    function test_transferOwnership() public {
        address newOwner = address(0x42);
        escrow.transferOwnership(newOwner);
        assertEq(escrow.owner(), newOwner);

        // Old owner can no longer call onlyOwner
        vm.expectRevert(AntseedEscrow.NotOwner.selector);
        escrow.setPlatformFee(100);
    }

    function test_setProtocolReserve() public {
        address newReserve = address(0x123);
        escrow.setProtocolReserve(newReserve);
        assertEq(escrow.protocolReserve(), newReserve);
    }

    function test_setProtocolReserve_revert_zero() public {
        vm.expectRevert(AntseedEscrow.InvalidAddress.selector);
        escrow.setProtocolReserve(address(0));
    }
}
