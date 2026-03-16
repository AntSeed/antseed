// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {AntseedEscrow} from "../AntseedEscrow.sol";
import {AntseedIdentity} from "../AntseedIdentity.sol";
import {AntseedEmissions} from "../AntseedEmissions.sol";
import {AntseedSubPool} from "../AntseedSubPool.sol";
import {ANTSToken} from "../ANTSToken.sol";
import {MockUSDC} from "../MockUSDC.sol";

/**
 * @title E2EIntegration
 * @notice Full system integration tests deploying ALL contracts, wiring them together,
 *         and running complete lifecycle scenarios across escrow, identity, emissions,
 *         subscriptions, and anti-gaming defences.
 */
contract E2EIntegration is Test {
    // ─── Contracts ───
    MockUSDC public usdc;
    ANTSToken public antsToken;
    AntseedIdentity public identity;
    AntseedEscrow public escrow;
    AntseedEmissions public emissions;
    AntseedSubPool public subPool;

    // ─── Actors ───
    address public owner;
    uint256 public buyerPk;
    address public buyer;
    address public seller1;
    address public seller2;
    address public seller3;
    address public protocolReserve;

    bytes32 constant SELLER1_PEER_ID = keccak256("e2e-seller1");
    bytes32 constant SELLER2_PEER_ID = keccak256("e2e-seller2");
    bytes32 constant SELLER3_PEER_ID = keccak256("e2e-seller3");

    // Emissions config
    uint256 constant INITIAL_EMISSION = 1_000_000 ether; // 1M ANTS per epoch
    uint256 constant EPOCH_DURATION = 7 days;

    function setUp() public {
        owner = address(this);
        buyerPk = 0xA11CE;
        buyer = vm.addr(buyerPk);
        seller1 = address(0x1001);
        seller2 = address(0x1002);
        seller3 = address(0x1003);
        protocolReserve = address(0xFEE);

        // 1. Deploy MockUSDC
        usdc = new MockUSDC();

        // 2. Deploy ANTSToken
        antsToken = new ANTSToken();

        // 3. Deploy AntseedIdentity
        identity = new AntseedIdentity();

        // 4. Deploy AntseedEscrow(usdc, identity)
        escrow = new AntseedEscrow(address(usdc), address(identity));

        // 5. Deploy AntseedEmissions(antsToken, initialEmission, epochDuration)
        emissions = new AntseedEmissions(address(antsToken), INITIAL_EMISSION, EPOCH_DURATION);

        // 6. Deploy AntseedSubPool(usdc, identity, escrow)
        subPool = new AntseedSubPool(address(usdc), address(identity));

        // ─── Wire contracts ───
        identity.setEscrowContract(address(escrow));
        escrow.setIdentityContract(address(identity));
        escrow.setEmissionsContract(address(emissions));
        escrow.setProtocolReserve(protocolReserve);
        antsToken.setEmissionsContract(address(emissions));
        emissions.setEscrowContract(address(escrow));

        // ─── Fund buyer ───
        usdc.mint(buyer, 1_000_000_000); // 1000 USDC
        vm.prank(buyer);
        usdc.approve(address(escrow), type(uint256).max);
        vm.prank(buyer);
        usdc.approve(address(subPool), type(uint256).max);

        // Override credit limit for tests
        escrow.setCreditLimitOverride(buyer, 500_000_000);

        // ─── Register + stake sellers ───
        _registerAndStake(seller1, SELLER1_PEER_ID, 100_000_000);
        _registerAndStake(seller2, SELLER2_PEER_ID, 100_000_000);
        _registerAndStake(seller3, SELLER3_PEER_ID, 100_000_000);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        HELPERS
    // ═══════════════════════════════════════════════════════════════════

    function _registerAndStake(address s, bytes32 peerId, uint256 stakeAmount) internal {
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
        uint256 deadline = block.timestamp + 3600;
        bytes memory sig = _signSpendingAuth(buyerPk, _seller, sessionId, maxAmount, 1, deadline, 0, bytes32(0));
        vm.prank(_seller);
        escrow.reserve(buyer, sessionId, maxAmount, 1, deadline, 0, bytes32(0), sig);
    }

    function _settleSession(address _seller, bytes32 sessionId, uint256 tokenCount) internal {
        vm.prank(_seller);
        escrow.settle(sessionId, tokenCount);
    }

    function _doFirstSignAndSettle(
        address _seller,
        bytes32 sessionId,
        uint256 maxAmount,
        uint256 tokenCount
    ) internal {
        _reserveFirstSign(_seller, sessionId, maxAmount);
        _settleSession(_seller, sessionId, tokenCount);
    }

    function _reserveProvenSign(
        address _seller,
        bytes32 prevSessionId,
        uint256 prevConsumption,
        bytes32 newSessionId,
        uint256 maxAmount,
        uint256 nonce
    ) internal {
        uint256 deadline = block.timestamp + 3600;
        bytes memory sig = _signSpendingAuth(
            buyerPk, _seller, newSessionId, maxAmount, nonce, deadline, prevConsumption, prevSessionId
        );
        vm.prank(_seller);
        escrow.reserve(buyer, newSessionId, maxAmount, nonce, deadline, prevConsumption, prevSessionId, sig);
    }

    // ═══════════════════════════════════════════════════════════════════
    //           TEST 1: FULL LIFECYCLE — 3-session proof chain
    // ═══════════════════════════════════════════════════════════════════

    function test_fullLifecycle() public {
        // 1. Register seller1 identity — already done in setUp
        // 2. Buyer deposits 50 USDC
        _depositBuyer(50_000_000);

        // Need diversity for qualified status: first sign + settle with seller2, seller3
        _doFirstSignAndSettle(seller2, keccak256("fl-d1"), 1_000_000, 10_000);
        _doFirstSignAndSettle(seller3, keccak256("fl-d2"), 1_000_000, 10_000);

        // 3. Session 1: First sign with seller1 (maxAmount = 1 USDC cap = 1_000_000)
        bytes32 sid1 = keccak256("fl-s1");
        _doFirstSignAndSettle(seller1, sid1, 1_000_000, 10_000);

        // 4. Verify diversity is 3
        assertEq(escrow.uniqueSellersCharged(buyer), 3);

        // 5. vm.warp(8 days) — past cooldown
        vm.warp(block.timestamp + 8 days);

        // 6. Session 2: Proven sign (references session 1, previousConsumption = 10000)
        bytes32 sid2 = keccak256("fl-s2");
        _reserveProvenSign(seller1, sid1, 10_000, sid2, 5_000_000, 2);

        // Verify it's qualified proven
        (,,,,,,,,,,,, bool isQualified2) = escrow.sessions(sid2);
        assertTrue(isQualified2, "Session 2 should be qualified proven");

        // 7. Settle session 2 (20000 tokens)
        _settleSession(seller1, sid2, 20_000);

        // 8. vm.warp past cooldown again
        vm.warp(block.timestamp + 8 days);

        // 9. Session 3: Proven sign (references session 2)
        bytes32 sid3 = keccak256("fl-s3");
        _reserveProvenSign(seller1, sid2, 20_000, sid3, 5_000_000, 3);
        _settleSession(seller1, sid3, 30_000);

        // 10. Verify reputation
        uint256 tokenId1 = identity.getTokenId(seller1);
        AntseedIdentity.ProvenReputation memory rep = identity.getReputation(tokenId1);
        assertEq(uint256(rep.firstSignCount), 1, "firstSignCount should be 1");
        assertGe(uint256(rep.qualifiedProvenSignCount), 2, "should have >= 2 qualified proven signs");

        // 11. Seller claims earnings
        (, uint256 earnings,,) = escrow.getSellerAccount(seller1);
        assertGt(earnings, 0, "seller should have earnings");

        uint256 sellerBalBefore = usdc.balanceOf(seller1);
        vm.prank(seller1);
        escrow.claimEarnings();
        uint256 sellerBalAfter = usdc.balanceOf(seller1);

        // 12. Verify USDC transferred correctly
        assertEq(sellerBalAfter - sellerBalBefore, earnings, "seller should receive full earnings");
    }

    // ═══════════════════════════════════════════════════════════════════
    //    TEST 2: QUALIFIED PROVEN WITH BUYER DIVERSITY
    // ═══════════════════════════════════════════════════════════════════

    function test_qualifiedProvenWithDiversity() public {
        _depositBuyer(50_000_000);

        // First sign + settle with all 3 sellers
        _doFirstSignAndSettle(seller1, keccak256("qd-s1"), 1_000_000, 10_000);
        _doFirstSignAndSettle(seller2, keccak256("qd-s2"), 1_000_000, 10_000);
        _doFirstSignAndSettle(seller3, keccak256("qd-s3"), 1_000_000, 10_000);

        assertEq(escrow.uniqueSellersCharged(buyer), 3, "buyer should have 3 unique sellers");

        // vm.warp past cooldown
        vm.warp(block.timestamp + 8 days);

        // Proven sign with seller1 — NOW this is qualified (buyer has 3 unique sellers)
        bytes32 provenSid = keccak256("qd-p1");
        _reserveProvenSign(seller1, keccak256("qd-s1"), 10_000, provenSid, 5_000_000, 2);

        // Verify it's qualified
        (,,,,,,,,,,,, bool isQualified) = escrow.sessions(provenSid);
        assertTrue(isQualified, "proven sign should be qualified");

        // Verify qualifiedProvenSignCount incremented on seller1's identity
        uint256 tokenId1 = identity.getTokenId(seller1);
        AntseedIdentity.ProvenReputation memory rep = identity.getReputation(tokenId1);
        assertEq(uint256(rep.qualifiedProvenSignCount), 1, "seller1 should have 1 qualified proven sign");
    }

    // ═══════════════════════════════════════════════════════════════════
    //              TEST 3: GHOST TIMEOUT PATH
    // ═══════════════════════════════════════════════════════════════════

    function test_ghostTimeoutPath() public {
        _depositBuyer(50_000_000);

        // First sign reserve (not settled)
        bytes32 sid = keccak256("ghost-s1");
        _reserveFirstSign(seller1, sid, 500_000);

        // vm.warp(25 hours) — past SETTLE_TIMEOUT (24 hours)
        vm.warp(block.timestamp + 25 hours);

        // Call settleTimeout — credits returned to buyer
        uint256 buyerAvailBefore;
        (buyerAvailBefore,,,) = escrow.getBuyerBalance(buyer);

        escrow.settleTimeout(sid);

        uint256 buyerAvailAfter;
        (buyerAvailAfter,,,) = escrow.getBuyerBalance(buyer);
        // Reserved amount should be returned (available should increase by maxAmount since no charge)
        assertGt(buyerAvailAfter, buyerAvailBefore, "buyer available should increase after timeout");

        // Verify ghostCount = 1 on identity
        uint256 tokenId = identity.getTokenId(seller1);
        AntseedIdentity.ProvenReputation memory rep = identity.getReputation(tokenId);
        assertEq(uint256(rep.ghostCount), 1, "ghost count should be 1");
    }

    // ═══════════════════════════════════════════════════════════════════
    //              TEST 4: SLASHING ON UNSTAKE
    // ═══════════════════════════════════════════════════════════════════

    function test_slashingOnUnstake() public {
        _depositBuyer(50_000_000);

        // Create first sign session + settle (unqualified proven to get totalSigns > 0)
        _doFirstSignAndSettle(seller1, keccak256("slash-s1"), 1_000_000, 10_000);

        // Proven sign (unqualified — buyer only has 1 unique seller, threshold is 3)
        vm.warp(block.timestamp + 8 days);
        _reserveProvenSign(seller1, keccak256("slash-s1"), 10_000, keccak256("slash-p1"), 5_000_000, 2);
        _settleSession(seller1, keccak256("slash-p1"), 10_000);

        // Now seller1 has Q=0, unqualifiedProvenSignCount=1, totalSigns=1
        // Tier 1: Q==0 && totalSigns>0 => 100% slash
        uint256 protocolBalBefore = usdc.balanceOf(protocolReserve);
        uint256 sellerBalBefore = usdc.balanceOf(seller1);

        vm.prank(seller1);
        escrow.unstake();

        uint256 sellerBalAfter = usdc.balanceOf(seller1);
        uint256 protocolBalAfter = usdc.balanceOf(protocolReserve);

        // Seller gets 0 from stake
        assertEq(sellerBalAfter - sellerBalBefore, 0, "seller should receive 0 from 100% slash");
        // Protocol reserve receives slashed amount (100M)
        assertEq(protocolBalAfter - protocolBalBefore, 100_000_000, "protocol reserve should receive slashed stake");
    }

    // ═══════════════════════════════════════════════════════════════════
    //              TEST 5: EMISSIONS FLOW
    // ═══════════════════════════════════════════════════════════════════

    function test_emissionsFlow() public {
        _depositBuyer(50_000_000);

        // First sign + settle with 3 sellers for diversity
        _doFirstSignAndSettle(seller1, keccak256("em-s1"), 1_000_000, 10_000);
        _doFirstSignAndSettle(seller2, keccak256("em-s2"), 1_000_000, 10_000);
        _doFirstSignAndSettle(seller3, keccak256("em-s3"), 1_000_000, 10_000);

        // Buyer is now qualified (3 unique sellers)
        assertEq(escrow.uniqueSellersCharged(buyer), 3);

        // Qualified proven sign + settle — emission points accrued
        vm.warp(block.timestamp + 8 days);
        bytes32 provenSid = keccak256("em-p1");
        _reserveProvenSign(seller1, keccak256("em-s1"), 10_000, provenSid, 5_000_000, 2);
        _settleSession(seller1, provenSid, 20_000);

        // Verify points accrued
        (uint256 sellerPoints,,) = emissions.sellerRewards(seller1);
        assertGt(sellerPoints, 0, "seller should have emission points");

        (uint256 buyerPoints,,) = emissions.buyerRewards(buyer);
        assertGt(buyerPoints, 0, "buyer should have emission points");

        // vm.warp(1 second) — let some rewards accumulate
        vm.warp(block.timestamp + 1);

        // Seller claims emissions — verify ANTS minted
        vm.prank(seller1);
        emissions.claimEmissions();
        uint256 sellerAnts = antsToken.balanceOf(seller1);
        assertGt(sellerAnts, 0, "seller should have ANTS tokens after claiming");

        // Buyer claims emissions — verify ANTS minted
        vm.prank(buyer);
        emissions.claimEmissions();
        uint256 buyerAnts = antsToken.balanceOf(buyer);
        assertGt(buyerAnts, 0, "buyer should have ANTS tokens after claiming");
    }

    // ═══════════════════════════════════════════════════════════════════
    //              TEST 6: SUBSCRIPTION FLOW
    // ═══════════════════════════════════════════════════════════════════

    function test_subscriptionFlow() public {
        // 1. Owner creates tier (10 USDC/month, 100000 tokens/day)
        subPool.setTier(0, 10_000_000, 100_000);

        // 2. Buyer subscribes
        vm.prank(buyer);
        subPool.subscribe(0);

        // Verify subscription active
        assertTrue(subPool.isSubscriptionActive(buyer), "buyer should be subscribed");

        // 3. Seller1 opts in
        uint256 tokenId1 = identity.getTokenId(seller1);
        vm.prank(seller1);
        subPool.optIn(tokenId1);

        // 4. Record token usage
        subPool.recordTokenUsage(buyer, 50_000);

        // Give seller1 qualified proven reputation so distribution works
        // We need to create real sessions for this
        _depositBuyer(50_000_000);
        _doFirstSignAndSettle(seller1, keccak256("sub-s1"), 1_000_000, 10_000);
        _doFirstSignAndSettle(seller2, keccak256("sub-s2"), 1_000_000, 10_000);
        _doFirstSignAndSettle(seller3, keccak256("sub-s3"), 1_000_000, 10_000);
        vm.warp(block.timestamp + 8 days);
        _reserveProvenSign(seller1, keccak256("sub-s1"), 10_000, keccak256("sub-p1"), 5_000_000, 2);
        _settleSession(seller1, keccak256("sub-p1"), 10_000);

        // 5. vm.warp(epoch duration) to end epoch
        vm.warp(block.timestamp + 7 days + 1);

        // 6. Distribute revenue
        subPool.distributeRevenue();

        // 7. Seller claims — verify USDC received
        uint256 sellerBalBefore = usdc.balanceOf(seller1);
        vm.prank(seller1);
        subPool.claimRevenue();
        uint256 sellerBalAfter = usdc.balanceOf(seller1);
        assertGt(sellerBalAfter, sellerBalBefore, "seller should receive subscription revenue");
    }

    // ═══════════════════════════════════════════════════════════════════
    //         TEST 7: ANTI-GAMING — FIRST SIGN CAP
    // ═══════════════════════════════════════════════════════════════════

    function test_antiGaming_firstSignCap() public {
        _depositBuyer(50_000_000);

        uint256 overCap = escrow.FIRST_SIGN_CAP() + 1;
        bytes32 sid = keccak256("cap-over");
        uint256 deadline = block.timestamp + 3600;
        bytes memory sig = _signSpendingAuth(buyerPk, seller1, sid, overCap, 1, deadline, 0, bytes32(0));

        // 1. Try to reserve with maxAmount > FIRST_SIGN_CAP — reverts
        vm.prank(seller1);
        vm.expectRevert(AntseedEscrow.FirstSignCapExceeded.selector);
        escrow.reserve(buyer, sid, overCap, 1, deadline, 0, bytes32(0), sig);

        // 2. Reserve with maxAmount = FIRST_SIGN_CAP — succeeds
        bytes32 sid2 = keccak256("cap-ok");
        uint256 cap = escrow.FIRST_SIGN_CAP();
        bytes memory sig2 = _signSpendingAuth(buyerPk, seller1, sid2, cap, 2, deadline, 0, bytes32(0));
        vm.prank(seller1);
        escrow.reserve(buyer, sid2, cap, 2, deadline, 0, bytes32(0), sig2);

        (address sBuyer,,,,,,,,,,,,) = escrow.sessions(sid2);
        assertEq(sBuyer, buyer, "session should be created at cap");
    }

    // ═══════════════════════════════════════════════════════════════════
    //         TEST 8: ANTI-GAMING — COOLDOWN
    // ═══════════════════════════════════════════════════════════════════

    function test_antiGaming_cooldown() public {
        _depositBuyer(50_000_000);

        // First sign + settle
        bytes32 sid1 = keccak256("cd-s1");
        _doFirstSignAndSettle(seller1, sid1, 1_000_000, 10_000);

        // Immediately try proven sign — reverts CooldownNotElapsed
        bytes32 sid2 = keccak256("cd-s2");
        uint256 deadline = block.timestamp + 3600;
        bytes memory sig = _signSpendingAuth(buyerPk, seller1, sid2, 5_000_000, 2, deadline, 10_000, sid1);

        vm.prank(seller1);
        vm.expectRevert(AntseedEscrow.CooldownNotElapsed.selector);
        escrow.reserve(buyer, sid2, 5_000_000, 2, deadline, 10_000, sid1, sig);

        // vm.warp(8 days), retry — succeeds
        vm.warp(block.timestamp + 8 days);
        uint256 deadline2 = block.timestamp + 3600;
        bytes memory sig2 = _signSpendingAuth(buyerPk, seller1, sid2, 5_000_000, 2, deadline2, 10_000, sid1);
        vm.prank(seller1);
        escrow.reserve(buyer, sid2, 5_000_000, 2, deadline2, 10_000, sid1, sig2);

        (address sBuyer,,,,,,,,,,,,) = escrow.sessions(sid2);
        assertEq(sBuyer, buyer, "proven sign should succeed after cooldown");
    }

    // ═══════════════════════════════════════════════════════════════════
    //         TEST 9: DYNAMIC CREDIT LIMIT
    // ═══════════════════════════════════════════════════════════════════

    function test_dynamicCreditLimit() public {
        // Remove override to test natural credit limit
        escrow.setCreditLimitOverride(buyer, 0);

        // 1. New buyer: credit limit = BASE_CREDIT_LIMIT (10 USDC = 10_000_000)
        uint256 baseLimit = escrow.getBuyerCreditLimit(buyer);
        assertEq(baseLimit, escrow.BASE_CREDIT_LIMIT(), "initial limit should be BASE_CREDIT_LIMIT");

        // 2. Deposit 10 USDC — works
        _depositBuyer(10_000_000);
        (uint256 available,,,) = escrow.getBuyerBalance(buyer);
        assertEq(available, 10_000_000, "should have 10 USDC deposited");

        // 3. Try deposit 1 more — reverts CreditLimitExceeded
        vm.prank(buyer);
        vm.expectRevert(AntseedEscrow.CreditLimitExceeded.selector);
        escrow.deposit(1);

        // 4. After proven sessions + diversity, limit increases
        // Re-enable override temporarily to run sessions
        escrow.setCreditLimitOverride(buyer, 500_000_000);

        _doFirstSignAndSettle(seller1, keccak256("dcl-s1"), 1_000_000, 10_000);
        _doFirstSignAndSettle(seller2, keccak256("dcl-s2"), 1_000_000, 10_000);
        _doFirstSignAndSettle(seller3, keccak256("dcl-s3"), 1_000_000, 10_000);

        // Now remove override — limit should be higher due to 3 unique sellers
        escrow.setCreditLimitOverride(buyer, 0);

        uint256 newLimit = escrow.getBuyerCreditLimit(buyer);
        // BASE + 3 * PEER_INTERACTION_BONUS = 10M + 3*5M = 25M (+ possible TIME_BONUS)
        assertGt(newLimit, baseLimit, "credit limit should increase with usage");

        // 5. Deposit more — now works (proves limit increased)
        vm.prank(buyer);
        escrow.deposit(5_000_000);
        (uint256 available2,,,) = escrow.getBuyerBalance(buyer);
        // Balance = initial 10M - 3 session charges (3 * 10000 = 30000) + new 5M deposit = 14,970,000
        assertEq(available2, 14_970_000, "should allow additional deposit within new limit");
    }
}
