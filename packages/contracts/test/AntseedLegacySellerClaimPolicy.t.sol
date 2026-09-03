// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

import { ANTSToken } from "../core/ANTSToken.sol";
import { AntseedRegistry } from "../core/AntseedRegistry.sol";
import { AntseedEmissions } from "../legacy/AntseedEmissions.sol";
import { AntseedEmissionsV2 } from "../legacy/AntseedEmissionsV2.sol";
import { AntseedSellerRewardsPool } from "../rewards/AntseedSellerRewardsPool.sol";
import { AntseedSellerUnlockPolicy } from "../policies/AntseedSellerUnlockPolicy.sol";
import { AntseedLegacySellerClaimPolicy } from "../policies/AntseedLegacySellerClaimPolicy.sol";
import { IAntseedWashTradingStatus } from "../interfaces/IAntseedWashTradingStatus.sol";

contract MockWashTradingStatus is IAntseedWashTradingStatus {
    mapping(address => bool) public wash;

    function set(address seller, bool value) external {
        wash[seller] = value;
    }

    function isProvenWashTrader(address seller) external view returns (bool) {
        return wash[seller];
    }
}

contract MockDepositsForClaimPolicy {
    function getOperator(address buyer) external pure returns (address) {
        return buyer;
    }
}

contract AntseedLegacySellerClaimPolicyTest is Test {
    uint256 constant INITIAL_EMISSION = 1000 ether;
    uint256 constant EPOCH_DURATION = 1 weeks;
    uint256 constant RELEASE_BPS = 1538; // ~10/65

    ANTSToken token;
    AntseedRegistry registry;
    AntseedEmissions legacy;
    AntseedEmissionsV2 v2;
    AntseedSellerRewardsPool pool;
    AntseedSellerUnlockPolicy unlockPolicy;
    MockWashTradingStatus washRegistry;

    address seller1 = address(0x10);
    address seller2 = address(0x20);
    address unlocked = address(0x30);

    function setUp() public {
        vm.warp(1_700_000_000);

        token = new ANTSToken();
        registry = new AntseedRegistry();
        registry.setChannels(address(this));
        registry.setDeposits(address(new MockDepositsForClaimPolicy()));
        registry.setAntsToken(address(token));
        registry.setProtocolReserve(address(0x50));
        registry.setTeamWallet(address(0x51));

        legacy = new AntseedEmissions(address(registry), INITIAL_EMISSION, EPOCH_DURATION);
        registry.setEmissions(address(legacy));
        token.setRegistry(address(registry));

        // V1 points in epoch 0 and in the migration epoch (4).
        legacy.accrueSellerPoints(seller1, 100);
        _warpToEpoch(4);
        legacy.accrueSellerPoints(seller1, 100);

        pool = new AntseedSellerRewardsPool(address(registry));
        unlockPolicy = new AntseedSellerUnlockPolicy();
        v2 = new AntseedEmissionsV2(address(registry), address(legacy), address(pool));
        v2.setSellerUnlockPolicy(address(unlockPolicy));
        registry.setEmissions(address(v2));
        token.setTransferWhitelist(address(pool), true);

        washRegistry = new MockWashTradingStatus();

        // V2 points in migration epoch and the next one.
        v2.accrueSellerPoints(seller1, 100);
        v2.accrueSellerPoints(seller2, 200);
        _warpToEpoch(5);
        v2.accrueSellerPoints(seller1, 300);
        v2.accrueSellerPoints(seller2, 100);
        _warpToEpoch(6);
    }

    function _warpToEpoch(uint256 epoch) internal {
        vm.warp(legacy.genesis() + EPOCH_DURATION * epoch + 1);
    }

    function _epochs(uint256 a) internal pure returns (uint256[] memory e) {
        e = new uint256[](1);
        e[0] = a;
    }

    function _epochs(uint256 a, uint256 b) internal pure returns (uint256[] memory e) {
        e = new uint256[](2);
        e[0] = a;
        e[1] = b;
    }

    function _deployPolicy(uint256 lastEpoch, uint256 vestStart, uint256 vestEpochs)
        internal
        returns (AntseedLegacySellerClaimPolicy policy)
    {
        policy = new AntseedLegacySellerClaimPolicy(
            address(v2), address(legacy), lastEpoch, RELEASE_BPS, vestStart, vestEpochs, address(washRegistry)
        );
        pool.setSellerClaimPolicy(address(policy));
    }

    function _expectedReward(uint256 epoch, uint256 userSP, uint256 totalSP) internal view returns (uint256) {
        (uint256 sellerShare,,,, uint256 maxSellerShare,,) = v2.epochParams(epoch);
        uint256 sBudget = (v2.getEpochEmission(epoch) * sellerShare) / 100;
        uint256 reward = (userSP * sBudget) / totalSP;
        uint256 maxReward = (sBudget * maxSellerShare) / 100;
        return reward > maxReward ? maxReward : reward;
    }

    // ─────────────────────────────────────────────────────────────────────

    function test_cumulativeLockedMirrorsV2Claim() public {
        AntseedLegacySellerClaimPolicy policy = _deployPolicy(10, 0, 0);

        vm.prank(seller1);
        v2.claimSellerEmissions(_epochs(4, 5));

        uint256 locked = pool.lockedRewards(seller1);
        assertGt(locked, 0);
        assertEq(policy.cumulativeLocked(seller1), locked, "policy must reproduce pool locked amount exactly");

        // migration epoch: V1 100 + V2 100 user, V1 100 + V2 300 total -> capped at 50%
        uint256 e4 = _expectedReward(4, 200, 400);
        uint256 e5 = _expectedReward(5, 300, 400);
        assertEq(locked, e4 + e5);
    }

    function test_claimReleasesConfiguredShareOnce() public {
        AntseedLegacySellerClaimPolicy policy = _deployPolicy(10, 0, 0);

        vm.prank(seller1);
        v2.claimSellerEmissions(_epochs(4, 5));
        uint256 locked = pool.lockedRewards(seller1);
        uint256 expected = (locked * RELEASE_BPS) / 10_000;

        assertEq(policy.claimableSellerRewards(seller1, locked), expected);

        vm.prank(seller1);
        pool.claim(seller1);
        assertEq(token.balanceOf(seller1), expected);
        assertEq(pool.lockedRewards(seller1), locked - expected);

        // Nothing more to claim: released == entitled.
        assertEq(policy.claimableSellerRewards(seller1, pool.lockedRewards(seller1)), 0);
        vm.prank(seller1);
        vm.expectRevert(AntseedSellerRewardsPool.NothingToClaim.selector);
        pool.claim(seller1);
    }

    function test_claimTracksNewlyLockedEpochs() public {
        AntseedLegacySellerClaimPolicy policy = _deployPolicy(10, 0, 0);

        vm.prank(seller1);
        v2.claimSellerEmissions(_epochs(4));
        vm.prank(seller1);
        pool.claim(seller1);
        uint256 firstPaid = token.balanceOf(seller1);

        // Lock another epoch later; only its releaseBps share becomes claimable.
        vm.prank(seller1);
        v2.claimSellerEmissions(_epochs(5));
        uint256 e5 = _expectedReward(5, 300, 400);
        uint256 cumulative = policy.cumulativeLocked(seller1);
        uint256 entitled = (cumulative * RELEASE_BPS) / 10_000;
        assertEq(policy.claimableSellerRewards(seller1, pool.lockedRewards(seller1)), entitled - firstPaid);
        assertApproxEqAbs(entitled - firstPaid, (e5 * RELEASE_BPS) / 10_000, 1);
    }

    function test_provenWashTraderCannotClaim() public {
        AntseedLegacySellerClaimPolicy policy = _deployPolicy(10, 0, 0);

        vm.prank(seller1);
        v2.claimSellerEmissions(_epochs(4, 5));
        uint256 locked = pool.lockedRewards(seller1);
        assertGt(policy.claimableSellerRewards(seller1, locked), 0);

        washRegistry.set(seller1, true);
        assertTrue(policy.isWashTrader(seller1));
        assertEq(policy.claimableSellerRewards(seller1, locked), 0);

        vm.prank(seller1);
        vm.expectRevert(AntseedSellerRewardsPool.NothingToClaim.selector);
        pool.claim(seller1);

        // Funds remain locked in the pool.
        assertEq(pool.lockedRewards(seller1), locked);
    }

    function test_ownerFlagBlocksClaimWithoutRegistry() public {
        AntseedLegacySellerClaimPolicy policy = _deployPolicy(10, 0, 0);
        policy.setWashTradingRegistry(address(0));

        vm.prank(seller1);
        v2.claimSellerEmissions(_epochs(4));
        uint256 locked = pool.lockedRewards(seller1);
        assertGt(policy.claimableSellerRewards(seller1, locked), 0);

        policy.setSellerFlagged(seller1, true);
        assertEq(policy.claimableSellerRewards(seller1, locked), 0);

        policy.setSellerFlagged(seller1, false);
        assertGt(policy.claimableSellerRewards(seller1, locked), 0);
    }

    function test_onlyOwnerCanFlagOrSetRegistry() public {
        AntseedLegacySellerClaimPolicy policy = _deployPolicy(10, 0, 0);
        vm.prank(seller2);
        vm.expectRevert();
        policy.setSellerFlagged(seller1, true);
        vm.prank(seller2);
        vm.expectRevert();
        policy.setWashTradingRegistry(address(0));
    }

    function test_linearVesting() public {
        // vest over 10 epochs starting at epoch 6 (now)
        AntseedLegacySellerClaimPolicy policy = _deployPolicy(10, 6, 10);

        vm.prank(seller1);
        v2.claimSellerEmissions(_epochs(4, 5));
        uint256 locked = pool.lockedRewards(seller1);
        uint256 full = (locked * RELEASE_BPS) / 10_000;

        assertEq(policy.claimableSellerRewards(seller1, locked), 0, "nothing at vest start");

        _warpToEpoch(11);
        assertEq(policy.claimableSellerRewards(seller1, locked), full / 2, "half vested");

        vm.prank(seller1);
        pool.claim(seller1);
        assertEq(token.balanceOf(seller1), full / 2);

        _warpToEpoch(16);
        uint256 remaining = pool.lockedRewards(seller1);
        assertEq(policy.claimableSellerRewards(seller1, remaining), full - full / 2, "fully vested");

        _warpToEpoch(40);
        assertEq(policy.claimableSellerRewards(seller1, remaining), full - full / 2, "no over-release after vest");
    }

    function test_vestingBeforeStartReturnsZero() public {
        AntseedLegacySellerClaimPolicy policy = _deployPolicy(10, 20, 10);
        vm.prank(seller1);
        v2.claimSellerEmissions(_epochs(4));
        assertEq(policy.claimableSellerRewards(seller1, pool.lockedRewards(seller1)), 0);
    }

    function test_preMigrationEpochClaimedThroughV2Counts() public {
        AntseedLegacySellerClaimPolicy policy = _deployPolicy(10, 0, 0);

        vm.prank(seller1);
        v2.claimSellerEmissions(_epochs(0));
        uint256 locked = pool.lockedRewards(seller1);
        assertGt(locked, 0);
        assertEq(policy.cumulativeLocked(seller1), locked);
    }

    function test_unlockedSellerNeverUnderCounts() public {
        // A seller eligible for direct mint has sellerEpochClaimed set but nothing in the pool.
        unlockPolicy.setSellerEligibility(seller2, true);
        AntseedLegacySellerClaimPolicy policy = _deployPolicy(10, 0, 0);

        vm.prank(seller2);
        v2.claimSellerEmissions(_epochs(4));
        assertEq(pool.lockedRewards(seller2), 0);
        assertGt(token.balanceOf(seller2), 0);
        assertEq(policy.claimableSellerRewards(seller2, 0), 0);
    }

    function test_claimableNeverExceedsLocked() public {
        AntseedLegacySellerClaimPolicy policy =
            new AntseedLegacySellerClaimPolicy(address(v2), address(legacy), 10, 10_000, 0, 0, address(0));
        pool.setSellerClaimPolicy(address(policy));

        vm.prank(seller1);
        v2.claimSellerEmissions(_epochs(4, 5));
        uint256 locked = pool.lockedRewards(seller1);
        assertEq(policy.claimableSellerRewards(seller1, locked), locked);
        assertEq(policy.claimableSellerRewards(seller1, locked / 3), locked / 3);
    }

    function test_constructorValidation() public {
        vm.expectRevert(AntseedLegacySellerClaimPolicy.InvalidValue.selector);
        new AntseedLegacySellerClaimPolicy(address(v2), address(legacy), 10, 0, 0, 0, address(0));
        vm.expectRevert(AntseedLegacySellerClaimPolicy.InvalidValue.selector);
        new AntseedLegacySellerClaimPolicy(address(v2), address(legacy), 10, 10_001, 0, 0, address(0));
        vm.expectRevert(AntseedLegacySellerClaimPolicy.InvalidValue.selector);
        new AntseedLegacySellerClaimPolicy(address(v2), address(legacy), 3, 1538, 0, 0, address(0));
        vm.expectRevert(AntseedLegacySellerClaimPolicy.InvalidAddress.selector);
        new AntseedLegacySellerClaimPolicy(address(0), address(legacy), 10, 1538, 0, 0, address(0));
    }
}
