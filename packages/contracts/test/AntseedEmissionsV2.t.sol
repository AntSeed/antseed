// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

import { ANTSToken } from "../core/ANTSToken.sol";
import { AntseedEmissions } from "../legacy/AntseedEmissions.sol";
import { AntseedEmissionsV2 } from "../legacy/AntseedEmissionsV2.sol";
import { AntseedRegistry } from "../core/AntseedRegistry.sol";
import { AntseedSellerRewardsPool } from "../rewards/AntseedSellerRewardsPool.sol";
import { AntseedSellerUnlockPolicy } from "../policies/AntseedSellerUnlockPolicy.sol";
import { IAntseedPointsPolicy } from "../interfaces/IAntseedPointsPolicy.sol";
import { IAntseedSellerClaimPolicy } from "../interfaces/IAntseedSellerClaimPolicy.sol";

contract MockPairPointsPolicy is IAntseedPointsPolicy {
    bytes32 public immutable targetChannelId;
    address public immutable targetBuyer;
    address public immutable targetSeller;

    constructor(bytes32 _targetChannelId, address _targetBuyer, address _targetSeller) {
        targetChannelId = _targetChannelId;
        targetBuyer = _targetBuyer;
        targetSeller = _targetSeller;
    }

    function points(bytes32 channelId, address buyer, address seller, uint256 rawPoints)
        external
        view
        returns (uint256 sellerPoints, uint256 buyerPoints)
    {
        if (channelId == targetChannelId && buyer == targetBuyer && seller == targetSeller) {
            return (rawPoints * 2, rawPoints * 3);
        }
        return (rawPoints, rawPoints);
    }
}

contract MockSellerClaimPolicy is IAntseedSellerClaimPolicy {
    mapping(address => uint256) public claimable;

    function setClaimable(address seller, uint256 amount) external {
        claimable[seller] = amount;
    }

    function claimableSellerRewards(address seller, uint256 lockedAmount) external view returns (uint256 amount) {
        amount = claimable[seller];
        if (amount > lockedAmount) amount = lockedAmount;
    }
}

contract MockDepositsForEmissionsV2 {
    mapping(address => address) private _operators;

    function setOperator(address buyer, address operator) external {
        _operators[buyer] = operator;
    }

    function getOperator(address buyer) external view returns (address) {
        return _operators[buyer];
    }
}

contract AntseedEmissionsV2Test is Test {
    ANTSToken public token;
    AntseedEmissions public legacy;
    AntseedEmissionsV2 public v2;
    AntseedRegistry public antseedRegistry;
    AntseedSellerRewardsPool public rewardsPool;
    AntseedSellerUnlockPolicy public unlockPolicy;
    MockDepositsForEmissionsV2 public mockDeposits;

    address public seller1 = address(0x10);
    address public seller2 = address(0x20);
    address public buyer1 = address(0x30);
    address public buyer2 = address(0x40);
    address public reserveDest = address(0x50);
    address public teamWallet = address(0x51);
    address public operator1 = address(0x60);
    address public operator2 = address(0x70);

    uint256 constant INITIAL_EMISSION = 1000 ether;
    uint256 constant EPOCH_DURATION = 1 weeks;

    function setUp() public {
        vm.warp(1_700_000_000);

        token = new ANTSToken();
        antseedRegistry = new AntseedRegistry();
        mockDeposits = new MockDepositsForEmissionsV2();

        antseedRegistry.setChannels(address(this));
        antseedRegistry.setDeposits(address(mockDeposits));
        antseedRegistry.setAntsToken(address(token));
        antseedRegistry.setProtocolReserve(reserveDest);
        antseedRegistry.setTeamWallet(teamWallet);

        legacy = new AntseedEmissions(address(antseedRegistry), INITIAL_EMISSION, EPOCH_DURATION);
        antseedRegistry.setEmissions(address(legacy));
        token.setRegistry(address(antseedRegistry));

        mockDeposits.setOperator(buyer1, operator1);
        mockDeposits.setOperator(buyer2, operator2);
    }

    function _deployV2WithoutCutover() internal {
        rewardsPool = new AntseedSellerRewardsPool(address(antseedRegistry));
        unlockPolicy = new AntseedSellerUnlockPolicy();
        v2 = new AntseedEmissionsV2(address(antseedRegistry), address(legacy), address(rewardsPool));
        v2.setSellerUnlockPolicy(address(unlockPolicy));
        v2.setMaxBuyerSharePct(5);
    }

    function _deployV2() internal {
        _deployV2WithoutCutover();
        antseedRegistry.setEmissions(address(v2));
    }

    function _epochList(uint256 epoch) internal pure returns (uint256[] memory) {
        uint256[] memory epochs = new uint256[](1);
        epochs[0] = epoch;
        return epochs;
    }

    function test_migrationEpochCombinesLegacyAndV2PointsAndLocksSellerReward() public {
        vm.warp(legacy.genesis() + EPOCH_DURATION * 4 + 1);
        assertEq(legacy.currentEpoch(), 4);

        legacy.accrueSellerPoints(seller1, 100);
        legacy.accrueBuyerPoints(buyer1, 100);

        _deployV2();
        assertEq(v2.MIGRATION_EPOCH(), 4);
        assertEq(v2.currentEpoch(), 4);

        v2.accrueSellerPoints(seller1, 100);
        v2.accrueBuyerPoints(buyer1, 100);
        v2.accrueSellerPoints(seller2, 200);
        v2.accrueBuyerPoints(buyer2, 200);

        vm.warp(legacy.genesis() + EPOCH_DURATION * 5 + 1);

        vm.prank(seller1);
        v2.claimSellerEmissions(_epochList(4));
        vm.prank(operator1);
        v2.claimBuyerEmissions(buyer1, _epochList(4));

        uint256 sellerBudget = (INITIAL_EMISSION * 50) / 100;
        uint256 expectedSeller = (sellerBudget * 200) / 400;
        assertEq(expectedSeller, (sellerBudget * 50) / 100, "expected to sit at seller cap");

        uint256 buyerBudget = (INITIAL_EMISSION * 20) / 100;
        uint256 expectedBuyer = (buyerBudget * 200) / 400;

        assertEq(token.balanceOf(seller1), 0, "seller rewards are locked by default");
        assertEq(token.balanceOf(address(rewardsPool)), expectedSeller);
        assertEq(rewardsPool.lockedRewards(seller1), expectedSeller);
        assertEq(token.balanceOf(operator1), expectedBuyer);
        assertTrue(v2.sellerEpochClaimed(seller1, 4));
        assertTrue(v2.buyerEpochClaimed(buyer1, 4));
    }

    function test_legacyPreviousEpochSellerAndBuyerCanBeClaimedThroughV2() public {
        legacy.accrueSellerPoints(seller1, 100);
        legacy.accrueBuyerPoints(buyer1, 100);

        vm.warp(legacy.genesis() + EPOCH_DURATION * 4 + 1);
        _deployV2();

        vm.prank(seller1);
        v2.claimSellerEmissions(_epochList(0));
        vm.prank(operator1);
        v2.claimBuyerEmissions(buyer1, _epochList(0));

        uint256 sellerBudget = (INITIAL_EMISSION * 50) / 100;
        uint256 maxSellerReward = (sellerBudget * 50) / 100;
        uint256 buyerBudget = (INITIAL_EMISSION * 20) / 100;

        assertEq(rewardsPool.lockedRewards(seller1), maxSellerReward);
        assertEq(token.balanceOf(address(rewardsPool)), maxSellerReward);
        assertEq(token.balanceOf(operator1), buyerBudget);
    }

    function test_legacyPreviousEpochCanBeClaimedThroughV2WithoutDuplicatingBaseReserve() public {
        legacy.accrueSellerPoints(seller1, 1_000_000);

        vm.warp(legacy.genesis() + EPOCH_DURATION * 4 + 1);
        _deployV2();

        vm.prank(seller1);
        v2.claimSellerEmissions(_epochList(0));

        uint256 sellerBudget = (INITIAL_EMISSION * 50) / 100;
        uint256 maxSellerReward = (sellerBudget * 50) / 100;

        assertEq(rewardsPool.lockedRewards(seller1), maxSellerReward);
        assertEq(token.balanceOf(address(rewardsPool)), maxSellerReward);
        assertEq(v2.reserveAccumulated(), sellerBudget - maxSellerReward, "only cap excess moves to V2 reserve");
    }

    function test_preMigrationSellerRewardsAreLockedByDefault() public {
        legacy.accrueSellerPoints(seller1, 100);

        vm.warp(legacy.genesis() + EPOCH_DURATION * 4 + 1);
        _deployV2();

        vm.prank(seller1);
        v2.claimSellerEmissions(_epochList(0));

        uint256 sellerBudget = (INITIAL_EMISSION * 50) / 100;
        uint256 maxSellerReward = (sellerBudget * 50) / 100;

        assertEq(token.balanceOf(seller1), 0);
        assertEq(rewardsPool.lockedRewards(seller1), maxSellerReward);
        assertEq(token.balanceOf(address(rewardsPool)), maxSellerReward);
    }

    function test_legacyClaimedSellerAndBuyerEpochsCannotDoubleClaimThroughV2() public {
        legacy.accrueSellerPoints(seller1, 100);
        legacy.accrueBuyerPoints(buyer1, 100);

        vm.warp(legacy.genesis() + EPOCH_DURATION + 1);
        vm.prank(seller1);
        legacy.claimSellerEmissions(_epochList(0));
        vm.prank(operator1);
        legacy.claimBuyerEmissions(buyer1, _epochList(0));

        uint256 sellerBalanceBefore = token.balanceOf(seller1);
        uint256 operatorBalanceBefore = token.balanceOf(operator1);

        vm.warp(legacy.genesis() + EPOCH_DURATION * 4 + 1);
        _deployV2();

        vm.prank(seller1);
        v2.claimSellerEmissions(_epochList(0));
        vm.prank(operator1);
        v2.claimBuyerEmissions(buyer1, _epochList(0));

        assertEq(token.balanceOf(seller1), sellerBalanceBefore);
        assertEq(token.balanceOf(operator1), operatorBalanceBefore);
        assertEq(token.balanceOf(address(rewardsPool)), 0);
        assertEq(rewardsPool.lockedRewards(seller1), 0);
    }

    function test_buyerCapStartsNextEpochNotMigrationEpoch() public {
        vm.warp(legacy.genesis() + EPOCH_DURATION * 4 + 1);
        legacy.accrueBuyerPoints(buyer1, 100);
        _deployV2();

        v2.accrueBuyerPoints(buyer1, 100);

        vm.warp(legacy.genesis() + EPOCH_DURATION * 5 + 1);
        vm.prank(operator1);
        v2.claimBuyerEmissions(buyer1, _epochList(4));

        uint256 buyerBudget = (INITIAL_EMISSION * 20) / 100;
        assertEq(token.balanceOf(operator1), buyerBudget, "migration epoch keeps legacy no-buyer-cap behavior");

        v2.accrueBuyerPoints(buyer2, 100);

        vm.warp(legacy.genesis() + EPOCH_DURATION * 6 + 1);
        vm.prank(operator2);
        v2.claimBuyerEmissions(buyer2, _epochList(5));

        uint256 cappedReward = (buyerBudget * 5) / 100;
        assertEq(token.balanceOf(operator2), cappedReward, "next epoch applies 5% buyer cap");
    }

    function test_unlockPolicyAllowsImmediateSellerClaim() public {
        vm.warp(legacy.genesis() + EPOCH_DURATION * 4 + 1);
        _deployV2();

        unlockPolicy.setSellerEligibility(seller1, true);
        v2.accrueSellerPoints(seller1, 100);

        vm.warp(legacy.genesis() + EPOCH_DURATION * 5 + 1);

        vm.prank(seller1);
        v2.claimSellerEmissions(_epochList(4));

        uint256 sellerBudget = (INITIAL_EMISSION * 50) / 100;
        uint256 maxSellerReward = (sellerBudget * 50) / 100;

        assertEq(token.balanceOf(seller1), maxSellerReward);
        assertEq(token.balanceOf(address(rewardsPool)), 0);
        assertEq(rewardsPool.lockedRewards(seller1), 0);
    }

    function test_futurePairAccrualSupportsBuyerSellerPolicy() public {
        vm.warp(legacy.genesis() + EPOCH_DURATION * 4 + 1);
        _deployV2();

        bytes32 channelId = keccak256("channel-1");
        MockPairPointsPolicy policy = new MockPairPointsPolicy(channelId, buyer1, seller1);
        v2.setPointsPolicy(address(policy));

        v2.accruePoints(channelId, buyer1, seller1, 100);

        assertEq(v2.userSellerPoints(seller1, 4), 200);
        assertEq(v2.epochTotalSellerPoints(4), 200);
        assertEq(v2.userBuyerPoints(buyer1, 4), 300);
        assertEq(v2.epochTotalBuyerPoints(4), 300);
    }

    function test_legacySeparateAccrualsUseUnknownCounterpartyForPolicy() public {
        vm.warp(legacy.genesis() + EPOCH_DURATION * 4 + 1);
        _deployV2();

        MockPairPointsPolicy policy = new MockPairPointsPolicy(keccak256("channel-1"), buyer1, seller1);
        v2.setPointsPolicy(address(policy));

        v2.accrueSellerPoints(seller1, 100);
        v2.accrueBuyerPoints(buyer1, 100);

        assertEq(v2.userSellerPoints(seller1, 4), 100);
        assertEq(v2.userBuyerPoints(buyer1, 4), 100);
    }

    function test_poolClaim_revert_withoutSellerClaimPolicy() public {
        vm.warp(legacy.genesis() + EPOCH_DURATION * 4 + 1);
        _deployV2();
        v2.accrueSellerPoints(seller1, 100);
        vm.warp(legacy.genesis() + EPOCH_DURATION * 5 + 1);

        vm.prank(seller1);
        v2.claimSellerEmissions(_epochList(4));

        vm.prank(seller1);
        vm.expectRevert(AntseedSellerRewardsPool.NoSellerClaimPolicy.selector);
        rewardsPool.claim(seller1);
    }

    function test_poolClaim_transfersPolicyClaimableAmount() public {
        vm.warp(legacy.genesis() + EPOCH_DURATION * 4 + 1);
        _deployV2();
        v2.accrueSellerPoints(seller1, 100);
        vm.warp(legacy.genesis() + EPOCH_DURATION * 5 + 1);

        vm.prank(seller1);
        v2.claimSellerEmissions(_epochList(4));

        uint256 locked = rewardsPool.lockedRewards(seller1);
        MockSellerClaimPolicy claimPolicy = new MockSellerClaimPolicy();
        uint256 partialClaim = locked / 2;
        claimPolicy.setClaimable(seller1, partialClaim);
        rewardsPool.setSellerClaimPolicy(address(claimPolicy));
        token.setTransferWhitelist(address(rewardsPool), true);

        vm.prank(seller1);
        rewardsPool.claim(seller1);

        assertEq(token.balanceOf(seller1), partialClaim);
        assertEq(rewardsPool.lockedRewards(seller1), locked - partialClaim);
    }

    function test_poolClaim_clampsToLockedAmount() public {
        vm.warp(legacy.genesis() + EPOCH_DURATION * 4 + 1);
        _deployV2();
        v2.accrueSellerPoints(seller1, 100);
        vm.warp(legacy.genesis() + EPOCH_DURATION * 5 + 1);

        vm.prank(seller1);
        v2.claimSellerEmissions(_epochList(4));

        uint256 locked = rewardsPool.lockedRewards(seller1);
        MockSellerClaimPolicy claimPolicy = new MockSellerClaimPolicy();
        claimPolicy.setClaimable(seller1, locked + 1);
        rewardsPool.setSellerClaimPolicy(address(claimPolicy));
        token.setTransferWhitelist(address(rewardsPool), true);

        vm.prank(seller1);
        rewardsPool.claim(seller1);

        assertEq(token.balanceOf(seller1), locked);
        assertEq(rewardsPool.lockedRewards(seller1), 0);
    }
}
