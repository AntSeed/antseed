// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

import { ANTSToken } from "../core/ANTSToken.sol";
import { AntseedEmissions } from "../legacy/AntseedEmissions.sol";
import { AntseedUsageRewards } from "../emissions/AntseedUsageRewards.sol";
import { AntseedEmissionsGate } from "../emissions/AntseedEmissionsGate.sol";
import { AntseedEmissionsV2 } from "../legacy/AntseedEmissionsV2.sol";
import { AntseedSellerPools } from "../sellers/AntseedSellerPools.sol";
import { AntseedSellerPoolsRewards } from "../emissions/AntseedSellerPoolsRewards.sol";
import { AntseedUsageAccounting } from "../emissions/AntseedUsageAccounting.sol";
import { AntseedRegistry } from "../core/AntseedRegistry.sol";
import { IAntseedUsageAccounting } from "../interfaces/IAntseedUsageAccounting.sol";
import { IAntseedPointsPolicy } from "../interfaces/IAntseedPointsPolicy.sol";
import { AntseedSellerRewardsPool } from "../rewards/AntseedSellerRewardsPool.sol";
import { MockERC8004Registry } from "./mocks/MockERC8004Registry.sol";

contract MockDepositsForEmissionsGate {
    mapping(address => address) private _operators;

    function setOperator(address buyer, address operator) external {
        _operators[buyer] = operator;
    }

    function getOperator(address buyer) external view returns (address) {
        return _operators[buyer];
    }
}

contract MockUsagePointsPolicy is IAntseedPointsPolicy {
    mapping(address => uint256) public sellerWeightBps;
    uint256 public buyerWeightBps = 10_000;

    function setSellerWeightBps(address seller, uint256 weightBps) external {
        sellerWeightBps[seller] = weightBps;
    }

    function setBuyerWeightBps(uint256 weightBps) external {
        buyerWeightBps = weightBps;
    }

    function points(bytes32, address, address seller, uint256 rawPoints)
        external
        view
        returns (uint256 sellerPoints, uint256 buyerPoints)
    {
        sellerPoints = (rawPoints * sellerWeightBps[seller]) / 10_000;
        buyerPoints = (rawPoints * buyerWeightBps) / 10_000;
    }
}

contract MockAllowAllSellerUnlockPolicy {
    function canClaimSellerUnlocked(address) external pure returns (bool) {
        return true;
    }
}

contract MockSellerAgentLookup {
    mapping(address => uint256) public agentIdBySeller;

    function setAgent(address seller, uint256 agentId) external {
        agentIdBySeller[seller] = agentId;
    }

    function getAgentId(address seller) external view returns (uint256) {
        return agentIdBySeller[seller];
    }
}

contract AntseedEmissionsGateTest is Test {
    struct StressRun {
        uint256 firstPositionId;
        uint256 washPositionId;
        uint256 expectedTotalWeightedPoints;
        uint256 firstWeightedPoints;
        uint256 washWeightedPoints;
        uint256 firstClaimable;
        uint256 washClaimable;
    }

    ANTSToken token;
    AntseedRegistry realRegistry;
    MockDepositsForEmissionsGate deposits;
    AntseedEmissions legacyV1;
    AntseedEmissionsV2 legacyV2;
    AntseedEmissionsGate gate;
    AntseedSellerPools sellerPools;
    AntseedUsageRewards usageRewards;
    AntseedSellerPoolsRewards sellerPoolsRewards;
    AntseedUsageAccounting usageAccounting;
    MockSellerAgentLookup sellerAgentLookup;
    MockERC8004Registry identityRegistry;

    address seller = address(0x10);
    address buyer = address(0x20);
    address operator = address(0x30);
    address otherSeller = address(0x40);
    address staker = address(0x50);
    address reserveDest = address(0x70);
    address teamWallet = address(0x80);
    address verificationWallet = address(0x90);

    address constant KNOWN_ANTS_TOKEN = 0xa87EE81b2C0Bc659307ca2D9ffdC38514DD85263;
    uint256 constant GATE_GENESIS = 1_775_728_461;
    uint256 constant GATE_EPOCH_DURATION = 7 days;
    uint256 constant INITIAL_EMISSION = 1_000 ether;
    uint256 constant EPOCH_DURATION = 1 weeks;
    uint32 constant SELLER_POOLS_SHARE_BPS = 40_000;
    uint32 constant USAGE_SHARE_BPS = 20_000;
    uint32 constant TEAM_SHARE_BPS = 15_000;
    uint32 constant RESERVE_SHARE_BPS = 15_000;
    uint32 constant VERIFICATION_SHARE_BPS = 10_000;
    bytes32 constant TEAM_MINTER_ID = keccak256("antseed.emissions.team.v1");
    bytes32 constant RESERVE_MINTER_ID = keccak256("antseed.emissions.reserve.v1");
    bytes32 constant VERIFICATION_MINTER_ID = keccak256("antseed.emissions.verification.v1");
    bytes32 constant SELLER_POOLS_MINTER_ID = keccak256("antseed.emissions.seller-pools.v1");
    bytes32 constant USAGE_MINTER_ID = keccak256("antseed.emissions.usage.v1");
    bytes32 constant CUSTOM_MINTER_ID = keccak256("antseed.emissions.custom.v1");
    bytes32 constant LOCKED_MINTER_ID = keccak256("antseed.emissions.locked.v1");

    function setUp() public {
        vm.warp(1_700_000_000);

        deployCodeTo("ANTSToken.sol:ANTSToken", KNOWN_ANTS_TOKEN);
        token = ANTSToken(KNOWN_ANTS_TOKEN);
        realRegistry = new AntseedRegistry();
        deposits = new MockDepositsForEmissionsGate();

        realRegistry.setChannels(address(this));
        realRegistry.setDeposits(address(deposits));
        realRegistry.setAntsToken(address(token));
        realRegistry.setProtocolReserve(reserveDest);
        realRegistry.setTeamWallet(teamWallet);
        identityRegistry = new MockERC8004Registry();
        realRegistry.setIdentityRegistry(address(identityRegistry));
        sellerAgentLookup = new MockSellerAgentLookup();
        realRegistry.setStaking(address(sellerAgentLookup));
        realRegistry.setEmissions(address(this));
        token.setRegistry(address(realRegistry));
        token.enableTransfers();
        token.mint(staker, 1_000 ether);

        legacyV1 = new AntseedEmissions(address(realRegistry), INITIAL_EMISSION, EPOCH_DURATION);
        realRegistry.setEmissions(address(legacyV1));
        legacyV1.accrueSellerPoints(seller, 50);
        legacyV1.accrueBuyerPoints(buyer, 50);

        vm.warp(legacyV1.genesis() + EPOCH_DURATION * 2 + 1);
        AntseedSellerRewardsPool v2RewardsPool = new AntseedSellerRewardsPool(address(realRegistry));
        legacyV2 = new AntseedEmissionsV2(address(realRegistry), address(legacyV1), address(v2RewardsPool));
        realRegistry.setEmissions(address(legacyV2));

        deposits.setOperator(buyer, operator);
        legacyV2.accrueSellerPoints(seller, 100);
        legacyV2.accrueBuyerPoints(buyer, 100);
    }

    function _deployGate(uint256 warpEpoch) internal {
        vm.warp(GATE_GENESIS + GATE_EPOCH_DURATION * (warpEpoch - 1) + 1);
        gate = new AntseedEmissionsGate(address(realRegistry), TEAM_SHARE_BPS, RESERVE_SHARE_BPS);
        _warpGateEpoch(warpEpoch);
        _setVerificationMinter(verificationWallet);
        token.setRegistry(address(gate));

        usageAccounting = new AntseedUsageAccounting(address(0), address(this), address(gate));
        realRegistry.setEmissions(address(usageAccounting));
    }

    function _warpGateEpoch(uint256 epoch) internal {
        vm.warp(gate.genesis() + gate.epochDuration() * epoch + 1);
    }

    function _shareBudget(uint32 shareBps, uint256 epoch) internal view returns (uint256) {
        return (gate.getEpochEmission(epoch) * shareBps) / 100_000;
    }

    function _setVerificationMinter(address verification) internal {
        gate.setMinter(VERIFICATION_MINTER_ID, verification, VERIFICATION_SHARE_BPS, true);
    }

    function _setEmissionMinters(address sellerPoolsMinter, address usageMinter) internal {
        _setSellerPoolsMinter(sellerPoolsMinter);
        _setUsageMinter(usageMinter);
    }

    function _setSellerPoolsMinter(address minter) internal {
        gate.setMinter(SELLER_POOLS_MINTER_ID, minter, SELLER_POOLS_SHARE_BPS, true);
    }

    function _setUsageMinter(address minter) internal {
        gate.setMinter(USAGE_MINTER_ID, minter, USAGE_SHARE_BPS, true);
    }

    function _configuredMinter(bytes32 id) internal view returns (address minter) {
        (minter,,) = gate.minters(id);
    }

    function _claim(bytes32 id, address caller, uint256 epoch) internal {
        uint256 amount = gate.minterEpochBudget(id, epoch) - gate.minterEpochMinted(id, epoch);
        vm.prank(caller);
        gate.claim(epoch, caller, amount);
    }

    function _epochList(uint256 epoch) internal pure returns (uint256[] memory epochs) {
        epochs = new uint256[](1);
        epochs[0] = epoch;
    }

    function _agentId(address seller_) internal pure returns (uint256) {
        return uint160(seller_);
    }

    function _createSellerPool(AntseedSellerPools pools_, address seller_, uint16, bytes32)
        internal
        returns (address poolSeller)
    {
        deal(address(token), seller_, token.balanceOf(seller_) + 1 ether);
        _stakeAgentPool(pools_, seller_, 1 ether, 4);
        poolSeller = seller_;
    }

    function _stakeAgentPool(AntseedSellerPools pools_, address seller_, uint256 amount, uint256 stakeEpochs)
        internal
        returns (uint256 positionId)
    {
        sellerAgentLookup.setAgent(seller_, _agentId(seller_));
        identityRegistry.setOwner(_agentId(seller_), seller_);
        vm.startPrank(seller_);
        token.approve(address(pools_), amount);
        positionId = pools_.stake(_agentId(seller_), amount, stakeEpochs);
        vm.stopPrank();
    }

    function test_legacyEpochSellerPoolsBucketCanMintBeforeLegacyEpochsAreDisabled() public {
        _deployGate(4);

        _setSellerPoolsMinter(address(this));
        gate.claim(2, buyer, 10 ether);

        assertEq(token.balanceOf(buyer), 10 ether);
        assertEq(gate.epochMinted(2), 10 ether);
    }

    function test_disableLegacyEpochMintsBlocksEpochsBeforeEffectiveEpochOnly() public {
        _deployGate(5);

        _setSellerPoolsMinter(address(this));

        gate.disableLegacyEpochMints();
        vm.expectRevert(AntseedEmissionsGate.LegacyEpochMintingDisabled.selector);
        gate.claim(2, buyer, 1 ether);

        _warpGateEpoch(6);
        gate.claim(5, buyer, 1 ether);
        assertEq(token.balanceOf(buyer), 1 ether);
    }

    function test_legacyV2HasNoPendingEmissionsForPostCutoverUsageEpoch() public {
        _deployGate(4);

        _warpGateEpoch(5);
        AntseedUsageAccounting(realRegistry.emissions()).accrueSellerPoints(seller, 1_000);
        AntseedUsageAccounting(realRegistry.emissions()).accrueBuyerPoints(buyer, 1_000);

        assertEq(usageAccounting.totalSellerPointsByEpoch(5), 0);
        assertEq(usageAccounting.totalBuyerPointsByEpoch(5), 0);
        assertEq(legacyV2.epochTotalSellerPoints(5), 0);
        assertEq(legacyV2.epochTotalBuyerPoints(5), 0);
        assertEq(legacyV2.userSellerPoints(seller, 5), 0);
        assertEq(legacyV2.userBuyerPoints(buyer, 5), 0);

        (uint256 sellerPendingSeller, uint256 sellerPendingBuyer) = legacyV2.pendingEmissions(seller, _epochList(5));
        (uint256 buyerPendingSeller, uint256 buyerPendingBuyer) = legacyV2.pendingEmissions(buyer, _epochList(5));
        assertEq(sellerPendingSeller, 0);
        assertEq(sellerPendingBuyer, 0);
        assertEq(buyerPendingSeller, 0);
        assertEq(buyerPendingBuyer, 0);
    }

    function test_legacyV2CanMintPreCutoverClaimsThroughGateRegistryFacade() public {
        _deployGate(4);
        legacyV2.setRegistry(address(gate));
        legacyV2.setSellerUnlockPolicy(address(new MockAllowAllSellerUnlockPolicy()));

        uint256[] memory epochs = _epochList(2);
        (uint256 sellerPending,) = legacyV2.pendingEmissions(seller, epochs);
        assertGt(sellerPending, 0);

        vm.prank(seller);
        legacyV2.claimSellerEmissions(epochs);
        assertEq(token.balanceOf(seller), sellerPending);
        assertEq(gate.minterEpochMinted(gate.LEGACY_EMISSIONS_MINTER_ID(), gate.effectiveEpoch() - 1), sellerPending);
        assertEq(gate.epochMinted(gate.effectiveEpoch() - 1), sellerPending);

        vm.prank(address(legacyV2));
        vm.expectRevert(AntseedEmissionsGate.NotEmissionMinter.selector);
        gate.claim(2, buyer, 1 ether);

        vm.expectRevert(AntseedEmissionsGate.NotLegacyEmissionsMinter.selector);
        gate.mint(buyer, 1 ether);
    }

    function test_sellerPoolsRewardsUsePostMigrationBucketAndPools() public {
        _deployGate(4);

        sellerPools = new AntseedSellerPools(address(realRegistry), 0, 0, 0);
        usageAccounting.setSellerPools(address(sellerPools));
        sellerPoolsRewards =
            new AntseedSellerPoolsRewards(address(gate), address(sellerPools), address(usageAccounting));
        sellerPools.setRewardStaker(address(sellerPoolsRewards), true);
        _setSellerPoolsMinter(address(sellerPoolsRewards));

        address poolSeller = _createSellerPool(sellerPools, seller, 5_000, keccak256("terms"));

        vm.startPrank(staker);
        token.approve(address(sellerPools), 100 ether);
        uint256 positionId = sellerPools.stake(_agentId(poolSeller), 100 ether, 4);
        vm.stopPrank();

        _warpGateEpoch(5);
        usageAccounting.accrueSellerPoints(seller, 100);
        usageAccounting.accrueBuyerPoints(buyer, 100);

        _warpGateEpoch(6);
        uint256 expectedStakerClaim = (sellerPoolsRewards.stakerEpochBudget(5) * 400 ether) / 404 ether;
        (uint256 grossReward, uint256 claimableReward, uint256 burnedReward) =
            sellerPoolsRewards.pendingStakerReward(positionId, 5);
        assertEq(grossReward, expectedStakerClaim);
        assertEq(claimableReward, expectedStakerClaim);
        assertEq(burnedReward, 0);

        sellerPoolsRewards.indexPoolRewards(_agentId(poolSeller), 10);
        vm.prank(staker);
        sellerPoolsRewards.claimStakerRewards(positionId, staker);
        assertEq(token.balanceOf(staker), 900 ether + expectedStakerClaim);
    }

    function test_lantsTransferCarriesUnclaimedStakerRewards() public {
        _deployGate(4);

        sellerPools = new AntseedSellerPools(address(realRegistry), 0, 0, 0);
        usageAccounting.setSellerPools(address(sellerPools));
        sellerPoolsRewards =
            new AntseedSellerPoolsRewards(address(gate), address(sellerPools), address(usageAccounting));
        _setSellerPoolsMinter(address(sellerPoolsRewards));

        address poolSeller = _createSellerPool(sellerPools, seller, 5_000, keccak256("terms"));

        vm.startPrank(staker);
        token.approve(address(sellerPools), 100 ether);
        uint256 positionId = sellerPools.stake(_agentId(poolSeller), 100 ether, 4);
        sellerPools.transferFrom(staker, operator, positionId);
        vm.stopPrank();

        _warpGateEpoch(5);
        usageAccounting.accrueSellerPoints(seller, 100);
        usageAccounting.accrueBuyerPoints(buyer, 100);

        _warpGateEpoch(6);
        uint256 expectedStakerClaim = (sellerPoolsRewards.stakerEpochBudget(5) * 400 ether) / 404 ether;

        sellerPoolsRewards.indexPoolRewards(_agentId(poolSeller), 10);
        vm.prank(staker);
        vm.expectRevert(AntseedSellerPoolsRewards.NotPositionOwner.selector);
        sellerPoolsRewards.claimStakerRewards(positionId, staker);

        vm.prank(operator);
        sellerPoolsRewards.claimStakerRewards(positionId, operator);
        assertEq(token.balanceOf(operator), expectedStakerClaim);
    }

    function test_burnedLantsPositionKeepsPastRewardClaimRightsAfterWithdraw() public {
        _deployGate(4);

        sellerPools = new AntseedSellerPools(address(realRegistry), 0, 0, 0);
        usageAccounting.setSellerPools(address(sellerPools));
        sellerPoolsRewards =
            new AntseedSellerPoolsRewards(address(gate), address(sellerPools), address(usageAccounting));
        _setSellerPoolsMinter(address(sellerPoolsRewards));

        address poolSeller = _createSellerPool(sellerPools, seller, 5_000, keccak256("terms"));

        vm.startPrank(staker);
        token.approve(address(sellerPools), 100 ether);
        uint256 positionId = sellerPools.stake(_agentId(poolSeller), 100 ether, 4);
        vm.stopPrank();

        _warpGateEpoch(5);
        usageAccounting.accrueSellerPoints(seller, 100);
        usageAccounting.accrueBuyerPoints(buyer, 100);

        _warpGateEpoch(6);
        uint256 expectedStakerClaim = (sellerPoolsRewards.stakerEpochBudget(5) * 400 ether) / 404 ether;

        vm.prank(staker);
        sellerPools.withdrawStake(positionId);

        sellerPoolsRewards.indexPoolRewards(_agentId(poolSeller), 10);
        vm.prank(staker);
        sellerPoolsRewards.claimStakerRewards(positionId, staker);
        assertEq(token.balanceOf(staker), 900 ether + 75 ether + expectedStakerClaim);
    }

    function test_burnedLantsPositionKeepsPastRewardClaimRightsAfterMove() public {
        _deployGate(4);

        sellerPools = new AntseedSellerPools(address(realRegistry), 0, 0, 0);
        usageAccounting.setSellerPools(address(sellerPools));
        sellerPoolsRewards =
            new AntseedSellerPoolsRewards(address(gate), address(sellerPools), address(usageAccounting));
        _setSellerPoolsMinter(address(sellerPoolsRewards));

        address poolSeller = _createSellerPool(sellerPools, seller, 5_000, keccak256("terms"));
        sellerAgentLookup.setAgent(otherSeller, _agentId(otherSeller));
        identityRegistry.setOwner(_agentId(otherSeller), otherSeller);

        vm.startPrank(staker);
        token.approve(address(sellerPools), 100 ether);
        uint256 positionId = sellerPools.stake(_agentId(poolSeller), 100 ether, 4);
        vm.stopPrank();

        _warpGateEpoch(5);
        usageAccounting.accrueSellerPoints(seller, 100);
        usageAccounting.accrueBuyerPoints(buyer, 100);

        _warpGateEpoch(6);
        uint256 expectedStakerClaim = (sellerPoolsRewards.stakerEpochBudget(5) * 400 ether) / 404 ether;

        vm.prank(staker);
        sellerPools.moveStake(positionId, _agentId(otherSeller));

        sellerPoolsRewards.indexPoolRewards(_agentId(poolSeller), 10);
        vm.prank(staker);
        sellerPoolsRewards.claimStakerRewards(positionId, staker);
        assertEq(token.balanceOf(staker), 900 ether + expectedStakerClaim);
    }

    function test_sellerPoolMaxLockKeepsPowerAtMaxUntilDisabled() public {
        _deployGate(4);

        sellerPools = new AntseedSellerPools(address(realRegistry), 0, 0, 0);
        uint256 agentId = _agentId(seller);
        sellerAgentLookup.setAgent(seller, agentId);
        identityRegistry.setOwner(agentId, seller);

        vm.startPrank(staker);
        token.approve(address(sellerPools), 100 ether);
        uint256 positionId = sellerPools.stake(agentId, 100 ether, 4);
        vm.stopPrank();

        _warpGateEpoch(5);
        assertEq(sellerPools.positionWeightAtEpoch(positionId, 5), 400 ether);

        vm.prank(staker);
        sellerPools.enableMaxLock(positionId);

        assertEq(sellerPools.positionWeightAtEpoch(positionId, 5), 400 ether);
        assertEq(sellerPools.positionMaxLockPowerAtEpoch(positionId, 6), 10_400 ether);
        assertEq(sellerPools.positionWeightAtEpoch(positionId, 6), 10_400 ether);
        assertEq(sellerPools.positionWeightAtEpoch(positionId, 20), 10_400 ether);
        assertEq(sellerPools.poolWeightAtEpoch(agentId, 6), 10_400 ether);
        assertEq(sellerPools.poolActiveStakeAtEpoch(agentId, 6), 100 ether);
        assertEq(sellerPools.totalPowerWeightAtEpoch(6), 10_400 ether);

        _warpGateEpoch(7);
        vm.prank(staker);
        sellerPools.disableMaxLock(positionId);

        assertEq(sellerPools.positionWeightAtEpoch(positionId, 7), 10_400 ether);
        assertEq(sellerPools.positionMaxLockPowerAtEpoch(positionId, 8), 0);
        assertEq(sellerPools.positionWeightAtEpoch(positionId, 8), 10_400 ether);
        assertEq(sellerPools.positionWeightAtEpoch(positionId, 9), 10_300 ether);
        assertEq(sellerPools.poolWeightAtEpoch(agentId, 9), 10_300 ether);
    }

    function test_sellerPoolsRewardsUseMaxLockPowerForEpochShare() public {
        _deployGate(4);

        sellerPools = new AntseedSellerPools(address(realRegistry), 0, 0, 0);
        usageAccounting.setSellerPools(address(sellerPools));
        sellerPoolsRewards =
            new AntseedSellerPoolsRewards(address(gate), address(sellerPools), address(usageAccounting));
        _setSellerPoolsMinter(address(sellerPoolsRewards));

        uint256 agentId = _agentId(seller);
        sellerAgentLookup.setAgent(seller, agentId);
        identityRegistry.setOwner(agentId, seller);

        vm.startPrank(staker);
        token.approve(address(sellerPools), 200 ether);
        uint256 maxLockedPositionId = sellerPools.stake(agentId, 100 ether, 4);
        uint256 normalPositionId = sellerPools.stake(agentId, 100 ether, 4);
        vm.stopPrank();

        _warpGateEpoch(5);
        vm.prank(staker);
        sellerPools.enableMaxLock(maxLockedPositionId);

        _warpGateEpoch(6);
        usageAccounting.accrueSellerPoints(seller, 100);
        usageAccounting.accrueBuyerPoints(buyer, 100);

        _warpGateEpoch(7);
        uint256 expectedBudget = sellerPoolsRewards.stakerEpochBudget(6);
        uint256 maxLockPower = 10_400 ether;
        uint256 normalPower = 300 ether;
        (uint256 maxLockedGross,,) = sellerPoolsRewards.pendingStakerReward(maxLockedPositionId, 6);
        (uint256 normalGross,,) = sellerPoolsRewards.pendingStakerReward(normalPositionId, 6);

        assertEq(maxLockedGross, (expectedBudget * maxLockPower) / (maxLockPower + normalPower));
        assertEq(normalGross, (expectedBudget * normalPower) / (maxLockPower + normalPower));
    }

    function test_sellerPoolsRewardsIndexedClaimUsesCursor() public {
        _deployGate(4);

        sellerPools = new AntseedSellerPools(address(realRegistry), 0, 0, 0);
        usageAccounting.setSellerPools(address(sellerPools));
        sellerPoolsRewards =
            new AntseedSellerPoolsRewards(address(gate), address(sellerPools), address(usageAccounting));
        _setSellerPoolsMinter(address(sellerPoolsRewards));

        address poolSeller = _createSellerPool(sellerPools, seller, 5_000, keccak256("terms"));

        vm.startPrank(staker);
        token.approve(address(sellerPools), 100 ether);
        uint256 positionId = sellerPools.stake(_agentId(poolSeller), 100 ether, 4);
        vm.stopPrank();

        _warpGateEpoch(5);
        usageAccounting.accrueSellerPoints(seller, 100);
        usageAccounting.accrueBuyerPoints(buyer, 100);

        _warpGateEpoch(6);
        uint256 expectedClaim = (sellerPoolsRewards.stakerEpochBudget(5) * 400 ether) / 404 ether;

        sellerPoolsRewards.indexPoolRewards(_agentId(poolSeller), 10);
        assertEq(sellerPoolsRewards.poolRewardIndexNextEpoch(_agentId(poolSeller)), 6);
        assertEq(sellerPoolsRewards.pendingIndexedStakerReward(positionId), expectedClaim);

        vm.prank(staker);
        sellerPoolsRewards.claimStakerRewards(positionId, staker);

        assertEq(token.balanceOf(staker), 900 ether + expectedClaim);
        assertEq(sellerPoolsRewards.positionClaimCursor(positionId), 6);

        vm.expectRevert(AntseedSellerPoolsRewards.NothingToClaim.selector);
        vm.prank(staker);
        sellerPoolsRewards.claimStakerRewards(positionId, staker);
    }

    function test_sellerPoolsRewardsIndexedClaimUsesExtendedLockSegments() public {
        _deployGate(4);

        sellerPools = new AntseedSellerPools(address(realRegistry), 0, 0, 0);
        usageAccounting.setSellerPools(address(sellerPools));
        sellerPoolsRewards =
            new AntseedSellerPoolsRewards(address(gate), address(sellerPools), address(usageAccounting));
        _setSellerPoolsMinter(address(sellerPoolsRewards));

        uint256 agentId = _agentId(seller);
        sellerAgentLookup.setAgent(seller, agentId);
        identityRegistry.setOwner(agentId, seller);

        vm.startPrank(staker);
        token.approve(address(sellerPools), 200 ether);
        uint256 extendedPositionId = sellerPools.stake(agentId, 100 ether, 4);
        uint256 normalPositionId = sellerPools.stake(agentId, 100 ether, 4);
        vm.stopPrank();

        _warpGateEpoch(5);
        usageAccounting.accrueSellerPoints(seller, 100);
        usageAccounting.accrueBuyerPoints(buyer, 100);

        vm.prank(staker);
        sellerPools.extendLock(extendedPositionId, 3);

        _warpGateEpoch(6);
        usageAccounting.accrueSellerPoints(seller, 100);
        usageAccounting.accrueBuyerPoints(buyer, 100);

        _warpGateEpoch(7);
        sellerPoolsRewards.indexPoolRewards(agentId, 10);

        uint256 epoch5Budget = sellerPoolsRewards.stakerEpochBudget(5);
        uint256 epoch6Budget = sellerPoolsRewards.stakerEpochBudget(6);
        uint256 expectedClaim = (epoch5Budget * 400 ether) / 800 ether + (epoch6Budget * 600 ether) / 900 ether;

        assertEq(sellerPoolsRewards.pendingIndexedStakerReward(extendedPositionId), expectedClaim);

        vm.prank(staker);
        sellerPoolsRewards.claimStakerRewards(extendedPositionId, staker);

        assertEq(token.balanceOf(staker), 800 ether + expectedClaim);
        assertEq(sellerPoolsRewards.positionClaimCursor(extendedPositionId), 7);

        (uint256 normalEpoch5Gross,,) = sellerPoolsRewards.pendingStakerReward(normalPositionId, 5);
        (uint256 normalEpoch6Gross,,) = sellerPoolsRewards.pendingStakerReward(normalPositionId, 6);
        assertEq(normalEpoch5Gross, (epoch5Budget * 400 ether) / 800 ether);
        assertEq(normalEpoch6Gross, (epoch6Budget * 300 ether) / 900 ether);
    }

    function test_sellerPoolsRewardsDoNotClaimWithoutWeightedPoints() public {
        _deployGate(5);

        sellerPools = new AntseedSellerPools(address(realRegistry), 0, 0, 0);
        usageAccounting.setSellerPools(address(sellerPools));
        sellerPoolsRewards =
            new AntseedSellerPoolsRewards(address(gate), address(sellerPools), address(usageAccounting));
        _setSellerPoolsMinter(address(sellerPoolsRewards));

        _createSellerPool(sellerPools, seller, 5_000, keccak256("terms"));
        uint256 positionId = sellerPools.nextPositionId() - 1;

        vm.expectRevert(AntseedSellerPoolsRewards.NothingToClaim.selector);
        vm.prank(seller);
        sellerPoolsRewards.claimStakerRewards(positionId, seller);
    }

    function test_gateFixedCurveAndAdminValidation() public {
        _deployGate(4);
        assertEq(gate.antsToken(), address(gate));
        assertEq(gate.deposits(), address(deposits));
        assertEq(_configuredMinter(gate.LEGACY_EMISSIONS_MINTER_ID()), address(legacyV2));
        assertEq(gate.controllerMinterIds(address(legacyV2)), gate.LEGACY_EMISSIONS_MINTER_ID());
        assertEq(_configuredMinter(TEAM_MINTER_ID), teamWallet);
        assertEq(_configuredMinter(RESERVE_MINTER_ID), reserveDest);
        assertEq(gate.genesis(), 1_775_728_461);
        assertEq(gate.epochDuration(), 7 days);
        assertEq(gate.halvingInterval(), 104);
        assertEq(gate.initialEmission(), 5_000_000 ether);
        assertEq(gate.effectiveEpoch(), 4);
        assertEq(gate.currentEmissionRate(), gate.initialEmission() / gate.epochDuration());
        assertEq(gate.SHARE_DENOMINATOR(), 100_000);
        _setEmissionMinters(address(this), address(0xBEEF));
        assertEq(gate.minterEpochBudget(SELLER_POOLS_MINTER_ID, 4), _shareBudget(SELLER_POOLS_SHARE_BPS, 4));
        assertEq(gate.minterEpochBudget(USAGE_MINTER_ID, 4), _shareBudget(USAGE_SHARE_BPS, 4));
        assertEq(gate.minterEpochBudget(TEAM_MINTER_ID, 4), _shareBudget(15_000, 4));
        assertEq(gate.minterEpochBudget(RESERVE_MINTER_ID, 4), _shareBudget(15_000, 4));
        assertEq(gate.minterEpochBudget(VERIFICATION_MINTER_ID, 4), _shareBudget(VERIFICATION_SHARE_BPS, 4));

        vm.expectRevert(AntseedEmissionsGate.InvalidAddress.selector);
        _setVerificationMinter(address(0));

        vm.expectRevert(AntseedEmissionsGate.InvalidAddress.selector);
        _setSellerPoolsMinter(address(0));

        vm.expectRevert(AntseedEmissionsGate.InvalidMinterId.selector);
        gate.setMinter(bytes32(0), address(this), 1, true);

        vm.expectRevert(AntseedEmissionsGate.InvalidMinterId.selector);
        gate.removeMinter(bytes32(0));

        bytes32 legacyMinterId = gate.LEGACY_EMISSIONS_MINTER_ID();

        vm.expectRevert(AntseedEmissionsGate.MinterNotEditable.selector);
        gate.setMinter(legacyMinterId, address(this), 1, true);

        address newLegacyMinter = address(0xACE);
        gate.setMinterController(legacyMinterId, newLegacyMinter);
        assertEq(_configuredMinter(legacyMinterId), newLegacyMinter);
        assertEq(gate.controllerMinterIds(address(legacyV2)), bytes32(0));
        assertEq(gate.controllerMinterIds(newLegacyMinter), legacyMinterId);

        vm.expectRevert(AntseedEmissionsGate.MinterNotEditable.selector);
        gate.removeMinter(legacyMinterId);

        vm.expectRevert(AntseedEmissionsGate.MinterNotEditable.selector);
        gate.setMinter(TEAM_MINTER_ID, address(0xB0B), TEAM_SHARE_BPS, true);

        vm.expectRevert(AntseedEmissionsGate.MinterNotEditable.selector);
        gate.removeMinter(RESERVE_MINTER_ID);

        address newTeamWallet = address(0xB0B);
        gate.setMinterController(TEAM_MINTER_ID, newTeamWallet);
        assertEq(_configuredMinter(TEAM_MINTER_ID), newTeamWallet);
        assertEq(gate.minterEpochBudget(TEAM_MINTER_ID, 4), _shareBudget(15_000, 4));
        assertEq(gate.controllerMinterIds(teamWallet), bytes32(0));
        assertEq(gate.controllerMinterIds(newTeamWallet), TEAM_MINTER_ID);

        _setSellerPoolsMinter(address(this));
        assertEq(_configuredMinter(SELLER_POOLS_MINTER_ID), address(this));
        assertEq(gate.controllerMinterIds(address(this)), SELLER_POOLS_MINTER_ID);

        vm.expectRevert(AntseedEmissionsGate.InvalidMinterId.selector);
        gate.setMinter(CUSTOM_MINTER_ID, address(this), 1, true);

        address newMinter = address(0xCAFE);
        gate.removeMinter(SELLER_POOLS_MINTER_ID);
        _setSellerPoolsMinter(newMinter);
        assertEq(_configuredMinter(SELLER_POOLS_MINTER_ID), newMinter);

        assertEq(_configuredMinter(TEAM_MINTER_ID), newTeamWallet);
        assertEq(_configuredMinter(RESERVE_MINTER_ID), reserveDest);
        assertEq(_configuredMinter(VERIFICATION_MINTER_ID), verificationWallet);
    }

    function test_gateCanRenounceEmissionAdminControl() public {
        _deployGate(4);
        _setEmissionMinters(address(this), address(0xBEEF));
        assertEq(gate.minterEpochBudget(SELLER_POOLS_MINTER_ID, 4), _shareBudget(SELLER_POOLS_SHARE_BPS, 4));

        // Renouncing the gate is blocked while the legacy-epoch mint window is
        // still open; it must be closed first.
        vm.expectRevert(AntseedEmissionsGate.LegacyEpochMintsStillEnabled.selector);
        gate.renounceOwnership();

        gate.disableLegacyEpochMints();
        gate.renounceOwnership();
        assertEq(gate.owner(), address(0));
        assertEq(gate.minterEpochBudget(SELLER_POOLS_MINTER_ID, 4), _shareBudget(SELLER_POOLS_SHARE_BPS, 4));
        assertEq(gate.currentEmissionRate(), gate.initialEmission() / gate.epochDuration());

        vm.expectRevert();
        _setSellerPoolsMinter(address(this));

        _warpGateEpoch(5);
        gate.claim(4, address(this), 1 ether);
        assertEq(token.balanceOf(address(this)), 1 ether);
    }

    function test_gatePairsLegacySellerBuyerAccruals() public {
        _deployGate(5);

        usageAccounting.accrueSellerPoints(seller, 123);
        (address pendingSeller, uint256 pendingDelta) = usageAccounting.pendingSellerAccrual();
        assertEq(pendingSeller, seller);
        assertEq(pendingDelta, 123);

        usageAccounting.accrueBuyerPoints(buyer, 123);
        (pendingSeller, pendingDelta) = usageAccounting.pendingSellerAccrual();
        assertEq(pendingSeller, address(0));
        assertEq(pendingDelta, 0);

        assertEq(usageAccounting.totalSellerPointsByEpoch(5), 0);
        assertEq(usageAccounting.totalBuyerPointsByEpoch(5), 0);
        assertEq(usageAccounting.sellerPointsByEpoch(5, seller), 0);
        assertEq(usageAccounting.buyerPointsByEpoch(5, buyer), 0);
    }

    function test_gateAccrualValidationAndFutureChannelIdPath() public {
        _deployGate(5);

        vm.prank(seller);
        vm.expectRevert(IAntseedUsageAccounting.NotUsageRecorder.selector);
        usageAccounting.accrueSellerPoints(seller, 1);

        vm.expectRevert(IAntseedUsageAccounting.InvalidAddress.selector);
        usageAccounting.accrueSellerPoints(address(0), 1);

        vm.expectRevert(IAntseedUsageAccounting.InvalidValue.selector);
        usageAccounting.accrueSellerPoints(seller, 0);

        usageAccounting.accrueSellerPoints(seller, 10);
        vm.expectRevert(IAntseedUsageAccounting.PendingSellerAccrualExists.selector);
        usageAccounting.accrueSellerPoints(seller, 10);

        vm.expectRevert(IAntseedUsageAccounting.AccrualDeltaMismatch.selector);
        usageAccounting.accrueBuyerPoints(buyer, 9);

        usageAccounting.clearPendingSellerAccrual();
        vm.expectRevert(IAntseedUsageAccounting.NoPendingSellerAccrual.selector);
        usageAccounting.accrueBuyerPoints(buyer, 10);

        usageAccounting.accruePoints(bytes32(0), buyer, seller, 1);
        assertEq(usageAccounting.totalBuyerPointsByEpoch(5), 0);
        assertEq(usageAccounting.totalSellerPointsByEpoch(5), 0);

        bytes32 channelId = keccak256("ignored-channel-id");
        usageAccounting.accruePoints(channelId, buyer, seller, 77);
        assertEq(usageAccounting.totalBuyerPointsByEpoch(5), 0);
        assertEq(usageAccounting.totalSellerPointsByEpoch(5), 0);
    }

    function test_usageAccountingTracksBuyerAgentRatiosByEpoch() public {
        _deployGate(4);

        sellerPools = new AntseedSellerPools(address(realRegistry), 0, 0, 0);
        usageAccounting.setSellerPools(address(sellerPools));
        _createSellerPool(sellerPools, seller, 5_000, keccak256("seller"));
        _createSellerPool(sellerPools, otherSeller, 5_000, keccak256("other-seller"));

        address secondBuyer = address(0x21);
        uint256 sellerAgentId = _agentId(seller);
        uint256 otherAgentId = _agentId(otherSeller);

        _warpGateEpoch(5);
        usageAccounting.accruePoints(keccak256("buyer-seller-1"), buyer, seller, 10);
        usageAccounting.accruePoints(keccak256("buyer-seller-2"), buyer, seller, 20);
        usageAccounting.accruePoints(keccak256("buyer-other-seller"), buyer, otherSeller, 30);
        usageAccounting.accruePoints(keccak256("second-buyer-seller"), secondBuyer, seller, 40);

        IAntseedUsageAccounting.BuyerUsage memory buyerUsage = usageAccounting.buyerEpochUsage(5, buyer);
        assertEq(buyerUsage.points, 60);
        assertEq(buyerUsage.weightedPoints, usageAccounting.weightedBuyerPointsByEpoch(5, buyer));

        IAntseedUsageAccounting.BuyerUsage memory buyerSellerUsage =
            usageAccounting.buyerAgentEpochUsage(5, buyer, sellerAgentId);
        assertEq(buyerSellerUsage.points, 30);
        assertEq((buyerSellerUsage.points * 10_000) / buyerUsage.points, 5_000);

        IAntseedUsageAccounting.BuyerUsage memory buyerTotalUsage = usageAccounting.buyerUsageTotal(buyer);
        assertEq(buyerTotalUsage.points, 60);

        IAntseedUsageAccounting.BuyerUsage memory buyerSellerTotalUsage =
            usageAccounting.buyerAgentUsageTotal(buyer, sellerAgentId);
        assertEq(buyerSellerTotalUsage.points, 30);
        assertEq((buyerSellerTotalUsage.points * 10_000) / buyerTotalUsage.points, 5_000);

        IAntseedUsageAccounting.BuyerUsage memory buyerOtherSellerUsage =
            usageAccounting.buyerAgentEpochUsage(5, buyer, otherAgentId);
        assertEq(buyerOtherSellerUsage.points, 30);
        assertEq((buyerOtherSellerUsage.points * 10_000) / buyerUsage.points, 5_000);

        IAntseedUsageAccounting.SellerUsage memory sellerAgentUsage = usageAccounting.agentEpochUsage(5, sellerAgentId);
        assertEq(sellerAgentUsage.points, 70);
        assertEq(sellerAgentUsage.poolPoints, 70);
        assertEq(sellerAgentUsage.weightedPoints, usageAccounting.weightedPoolPointsByEpoch(5, sellerAgentId));
        assertEq(usageAccounting.sellerAgentIdByEpoch(5, seller), sellerAgentId);

        IAntseedUsageAccounting.UsageTotals memory epochUsage = usageAccounting.epochUsage(5);
        assertEq(epochUsage.buyers.points, 100);
        assertEq(epochUsage.sellers.points, 100);
        assertEq(epochUsage.sellers.poolPoints, 100);

        IAntseedUsageAccounting.UsageTotals memory totalUsage = usageAccounting.totalUsage();
        assertEq(totalUsage.buyers.points, 100);
        assertEq(totalUsage.sellers.points, 100);
        assertEq(totalUsage.sellers.poolPoints, 100);
    }

    function test_usageAccountingRequiresMinimumAccountedPoolPower() public {
        _deployGate(4);

        sellerPools = new AntseedSellerPools(address(realRegistry), 0, 0, 0);
        usageAccounting.setSellerPools(address(sellerPools));
        _createSellerPool(sellerPools, seller, 5_000, keccak256("seller"));

        uint256 agentId = _agentId(seller);

        _warpGateEpoch(5);
        uint256 poolPower = sellerPools.poolPowerWeightAtEpoch(agentId, 5);
        assertGt(poolPower, 0);
        assertEq(usageAccounting.minimumAccountedPoolPower(), 1);

        usageAccounting.setMinimumAccountedPoolPower(poolPower + 1);
        usageAccounting.accruePoints(keccak256("below-minimum"), buyer, seller, 10);

        assertEq(usageAccounting.buyerPointsByEpoch(5, buyer), 0);
        assertEq(usageAccounting.sellerPointsByEpoch(5, seller), 0);
        assertEq(usageAccounting.weightedBuyerPointsByEpoch(5, buyer), 0);
        assertEq(usageAccounting.weightedPoolPointsByEpoch(5, agentId), 0);
        assertEq(usageAccounting.totalWeightedPoolPointsByEpoch(5), 0);

        usageAccounting.setMinimumAccountedPoolPower(poolPower);
        usageAccounting.accruePoints(keccak256("at-minimum"), buyer, seller, 10);

        assertEq(usageAccounting.buyerPointsByEpoch(5, buyer), 10);
        assertEq(usageAccounting.sellerPointsByEpoch(5, seller), 10);
        assertEq(usageAccounting.weightedBuyerPointsByEpoch(5, buyer), 10 * poolPower);
        assertEq(usageAccounting.weightedPoolPointsByEpoch(5, agentId), 10 * poolPower);
        assertEq(usageAccounting.totalWeightedPoolPointsByEpoch(5), 10 * poolPower);

        vm.expectRevert(IAntseedUsageAccounting.InvalidValue.selector);
        usageAccounting.setMinimumAccountedPoolPower(0);
    }

    function test_usageAccountingGasSnapshotsRecordUsageCases() public {
        _deployGate(4);

        sellerPools = new AntseedSellerPools(address(realRegistry), 0, 0, 0);
        usageAccounting.setSellerPools(address(sellerPools));
        _createSellerPool(sellerPools, seller, 5_000, keccak256("seller"));
        _createSellerPool(sellerPools, otherSeller, 5_000, keccak256("other-seller"));

        address secondBuyer = address(0x21);

        _warpGateEpoch(5);
        usageAccounting.accruePoints(keccak256("warm-pair"), buyer, seller, 10);

        vm.startSnapshotGas("usage-accounting", "record-repeated-same-buyer-agent");
        usageAccounting.accruePoints(keccak256("repeat-pair"), buyer, seller, 10);
        uint256 repeatedGas = vm.stopSnapshotGas();

        vm.startSnapshotGas("usage-accounting", "record-new-buyer-existing-agent");
        usageAccounting.accruePoints(keccak256("new-buyer"), secondBuyer, seller, 10);
        uint256 newBuyerGas = vm.stopSnapshotGas();

        vm.startSnapshotGas("usage-accounting", "record-new-agent-in-epoch");
        usageAccounting.accruePoints(keccak256("new-agent"), buyer, otherSeller, 10);
        uint256 newAgentGas = vm.stopSnapshotGas();

        assertGt(repeatedGas, 0);
        assertGt(newBuyerGas, repeatedGas);
        assertGt(newAgentGas, repeatedGas);
    }

    function test_sellerPoolsRewardsRecordsWeightedPoolPoints() public {
        _deployGate(4);

        sellerPools = new AntseedSellerPools(address(realRegistry), 0, 0, 0);
        usageAccounting.setSellerPools(address(sellerPools));
        sellerPoolsRewards =
            new AntseedSellerPoolsRewards(address(gate), address(sellerPools), address(usageAccounting));
        sellerPools.setRewardStaker(address(sellerPoolsRewards), true);
        _setSellerPoolsMinter(address(sellerPoolsRewards));

        address poolSeller = _createSellerPool(sellerPools, seller, 5_000, keccak256("terms"));
        _warpGateEpoch(5);
        usageAccounting.accrueSellerPoints(seller, 10);
        usageAccounting.accrueBuyerPoints(buyer, 10);
        assertEq(usageAccounting.sellerPointsByEpoch(5, seller), 10);
        assertGt(usageAccounting.weightedPoolPointsByEpoch(5, poolSeller), 0);

        _warpGateEpoch(6);
        uint256 positionId = sellerPools.nextPositionId() - 1;
        (uint256 grossReward, uint256 claimableReward, uint256 burnedReward) =
            sellerPoolsRewards.pendingStakerReward(positionId, 5);
        assertEq(grossReward, sellerPoolsRewards.stakerEpochBudget(5));
        assertEq(claimableReward, sellerPoolsRewards.stakerEpochBudget(5));
        assertEq(burnedReward, 0);

        assertEq(token.balanceOf(seller), 0);
    }

    function test_pointsPolicyCanZeroOrScaleSellerPoolPoints() public {
        _deployGate(4);

        sellerPools = new AntseedSellerPools(address(realRegistry), 0, 0, 0);
        usageAccounting.setSellerPools(address(sellerPools));
        address poolSeller = _createSellerPool(sellerPools, seller, 5_000, keccak256("terms"));

        MockUsagePointsPolicy policy = new MockUsagePointsPolicy();
        usageAccounting.setPointsPolicy(address(policy));

        _warpGateEpoch(5);
        usageAccounting.accruePoints(keccak256("unverified"), buyer, seller, 10);
        assertEq(usageAccounting.sellerPointsByEpoch(5, seller), 0);
        assertEq(usageAccounting.poolPointsByEpoch(5, poolSeller), 0);
        assertEq(usageAccounting.weightedSellerPointsByEpoch(5, seller), 0);
        assertEq(usageAccounting.weightedPoolPointsByEpoch(5, poolSeller), 0);

        policy.setSellerWeightBps(seller, 5_000);
        uint256 poolPower = sellerPools.poolPowerWeightAtEpoch(poolSeller, 5);
        usageAccounting.accruePoints(keccak256("verified-half"), buyer, seller, 10);
        assertEq(usageAccounting.sellerPointsByEpoch(5, seller), 5);
        assertEq(usageAccounting.buyerPointsByEpoch(5, buyer), 20);
        assertEq(usageAccounting.poolPointsByEpoch(5, poolSeller), 5);
        assertEq(usageAccounting.weightedSellerPointsByEpoch(5, seller), poolPower * 5);
        assertEq(usageAccounting.totalWeightedSellerPointsByEpoch(5), poolPower * 5);
        assertEq(usageAccounting.weightedPoolPointsByEpoch(5, poolSeller), poolPower * 5);
    }

    function test_poolWeightedPointsAreSavedUncapped() public {
        _deployGate(4);

        sellerPools = new AntseedSellerPools(address(realRegistry), 0, 0, 0);
        usageAccounting.setSellerPools(address(sellerPools));

        uint256 honestStake = 1_000_000 ether;
        uint256 washStake = 100 ether;
        deal(address(token), seller, honestStake);
        deal(address(token), otherSeller, washStake);

        vm.startPrank(seller);
        token.approve(address(sellerPools), honestStake);
        sellerAgentLookup.setAgent(seller, _agentId(seller));
        identityRegistry.setOwner(_agentId(seller), seller);
        sellerPools.stake(_agentId(seller), honestStake, 52);
        vm.stopPrank();

        vm.startPrank(otherSeller);
        token.approve(address(sellerPools), washStake);
        sellerAgentLookup.setAgent(otherSeller, _agentId(otherSeller));
        identityRegistry.setOwner(_agentId(otherSeller), otherSeller);
        sellerPools.stake(_agentId(otherSeller), washStake, 52);
        vm.stopPrank();

        address honestSeller = seller;
        address washSeller = otherSeller;

        _warpGateEpoch(5);
        usageAccounting.accruePoints(keccak256("honest"), buyer, seller, 1_000);
        usageAccounting.accruePoints(keccak256("wash"), address(0x21), otherSeller, 1_000_000);

        uint256 honestPower = sellerPools.poolPowerWeightAtEpoch(honestSeller, 5);
        uint256 washPower = sellerPools.poolPowerWeightAtEpoch(washSeller, 5);

        assertEq(usageAccounting.weightedPoolPointsByEpoch(5, washSeller), 1_000_000 * washPower);
        assertEq(usageAccounting.weightedPoolPointsByEpoch(5, honestSeller), 1_000 * honestPower);
        assertEq(usageAccounting.weightedPoolPointsByEpoch(5, washSeller), 1_000_000 * washPower);
        assertEq(usageAccounting.totalWeightedPoolPointsByEpoch(5), (1_000 * honestPower) + (1_000_000 * washPower));
    }

    function test_stakerDynamicBudgetDistributesHighVolumeReward() public {
        _deployGate(4);

        sellerPools = new AntseedSellerPools(address(realRegistry), 10_000, 2_000, 500);
        usageAccounting.setSellerPools(address(sellerPools));
        sellerPoolsRewards =
            new AntseedSellerPoolsRewards(address(gate), address(sellerPools), address(usageAccounting));
        sellerPools.setRewardStaker(address(sellerPoolsRewards), true);
        _setSellerPoolsMinter(address(sellerPoolsRewards));

        deal(address(token), seller, 1_000_000 ether);
        deal(address(token), otherSeller, 100 ether);

        vm.startPrank(seller);
        token.approve(address(sellerPools), 1_000_000 ether);
        sellerAgentLookup.setAgent(seller, _agentId(seller));
        identityRegistry.setOwner(_agentId(seller), seller);
        uint256 honestPositionId = sellerPools.stake(_agentId(seller), 1_000_000 ether, 52);
        vm.stopPrank();

        vm.startPrank(otherSeller);
        token.approve(address(sellerPools), 100 ether);
        sellerAgentLookup.setAgent(otherSeller, _agentId(otherSeller));
        identityRegistry.setOwner(_agentId(otherSeller), otherSeller);
        uint256 washPositionId = sellerPools.stake(_agentId(otherSeller), 100 ether, 52);
        vm.stopPrank();

        address honestSeller = seller;
        address washSeller = otherSeller;

        _warpGateEpoch(5);
        usageAccounting.accruePoints(keccak256("honest"), buyer, seller, 1_000);
        usageAccounting.accruePoints(keccak256("wash"), address(0x21), otherSeller, 1_000_000);

        uint256 honestPoints = usageAccounting.weightedPoolPointsByEpoch(5, honestSeller);
        uint256 washPoints = usageAccounting.weightedPoolPointsByEpoch(5, washSeller);
        uint256 totalPoints = usageAccounting.totalWeightedPoolPointsByEpoch(5);

        _warpGateEpoch(6);
        uint256 stakerBudget = sellerPoolsRewards.stakerEpochBudget(5);
        uint256 expectedHonestReward = (stakerBudget * honestPoints) / totalPoints;
        uint256 expectedWashReward = (stakerBudget * washPoints) / totalPoints;
        (uint256 honestGross, uint256 honestClaimable, uint256 honestBurned) =
            sellerPoolsRewards.pendingStakerReward(honestPositionId, 5);
        (uint256 washGross, uint256 washClaimable, uint256 washBurned) =
            sellerPoolsRewards.pendingStakerReward(washPositionId, 5);
        assertEq(honestGross, expectedHonestReward);
        assertEq(washGross, expectedWashReward);
        assertEq(honestClaimable, honestGross);
        assertEq(washClaimable, washGross);
        assertEq(honestBurned, 0);
        assertEq(washBurned, 0);
    }

    function test_stakerRemainderRoutesThroughGateBurnCapToReserve() public {
        _deployGate(4);

        sellerPools = new AntseedSellerPools(address(realRegistry), 10_000, 2_000, 500);
        usageAccounting.setSellerPools(address(sellerPools));
        sellerPoolsRewards =
            new AntseedSellerPoolsRewards(address(gate), address(sellerPools), address(usageAccounting));
        sellerPools.setRewardStaker(address(sellerPoolsRewards), true);
        _setSellerPoolsMinter(address(sellerPoolsRewards));

        deal(address(token), otherSeller, 100 ether);
        uint256 positionId = _stakeAgentPool(sellerPools, otherSeller, 100 ether, 52);

        _warpGateEpoch(5);
        usageAccounting.accruePoints(keccak256("wash"), buyer, otherSeller, 1_000_000_000);

        _warpGateEpoch(6);
        uint256 maxBudget = gate.controllerEpochBudget(address(sellerPoolsRewards), 5);
        uint256 allocatedBudget = sellerPoolsRewards.stakerEpochBudget(5);
        uint256 unallocated = maxBudget - allocatedBudget;
        uint256 burnCap = gate.getEpochEmission(5) * gate.BURN_CAP_BPS() / gate.SHARE_DENOMINATOR();

        sellerPoolsRewards.indexPoolRewards(_agentId(otherSeller), 10);
        sellerPoolsRewards.settleEpochRemainder(5);
        uint256 indexedClaimableReward = sellerPoolsRewards.pendingIndexedStakerReward(positionId);
        vm.prank(otherSeller);
        sellerPoolsRewards.claimStakerRewards(positionId, otherSeller);

        assertEq(token.balanceOf(otherSeller), indexedClaimableReward);
        assertEq(token.balanceOf(gate.DEAD_ADDRESS()), unallocated < burnCap ? unallocated : burnCap);
        assertEq(token.balanceOf(reserveDest), unallocated > burnCap ? unallocated - burnCap : 0);
        assertEq(gate.epochBurnedAmount(5), unallocated < burnCap ? unallocated : burnCap);
        (bool settled, uint256 settledGross, uint256 settledClaimable, uint256 settledBurned, uint256 settledReserved) =
            sellerPoolsRewards.poolEpochEmissions(5, _agentId(otherSeller));
        assertTrue(settled);
        assertApproxEqAbs(settledGross, indexedClaimableReward, 1);
        assertApproxEqAbs(settledClaimable, indexedClaimableReward, 1);
        assertEq(settledBurned, 0);
        assertEq(settledReserved, 0);
    }

    function test_stressWashTradingBuyerRewardRemainsCappedAfterStakerApyCapRemoval() public {
        address washBuyer = address(0x9999);
        StressRun memory run;

        _deployGate(4);

        sellerPools = new AntseedSellerPools(address(realRegistry), 10_000, 2_000, 500);
        usageAccounting.setSellerPools(address(sellerPools));
        sellerPoolsRewards =
            new AntseedSellerPoolsRewards(address(gate), address(sellerPools), address(usageAccounting));
        usageRewards = new AntseedUsageRewards(address(gate), address(realRegistry), address(usageAccounting));
        sellerPools.setRewardStaker(address(sellerPoolsRewards), true);
        _setSellerPoolsMinter(address(sellerPoolsRewards));
        _setUsageMinter(address(usageRewards));

        deal(address(token), seller, 1_000_000 ether);
        deal(address(token), otherSeller, 100 ether);

        vm.startPrank(seller);
        token.approve(address(sellerPools), 1_000_000 ether);
        sellerAgentLookup.setAgent(seller, _agentId(seller));
        identityRegistry.setOwner(_agentId(seller), seller);
        run.firstPositionId = sellerPools.stake(_agentId(seller), 1_000_000 ether, 52);
        vm.stopPrank();

        vm.startPrank(otherSeller);
        token.approve(address(sellerPools), 100 ether);
        sellerAgentLookup.setAgent(otherSeller, _agentId(otherSeller));
        identityRegistry.setOwner(_agentId(otherSeller), otherSeller);
        run.washPositionId = sellerPools.stake(_agentId(otherSeller), 100 ether, 52);
        vm.stopPrank();

        {
            uint256 honestBuyerCount = 1_000;
            uint256 honestBuyerVolume = 1_000;
            uint256 honestTotalVolume = honestBuyerCount * honestBuyerVolume;
            uint256 washVolume = 100_000_000_000;

            _warpGateEpoch(5);
            for (uint256 i = 0; i < honestBuyerCount; i++) {
                address honestBuyer = address(uint160(0x20000 + i));
                usageAccounting.accruePoints(
                    keccak256(abi.encodePacked("honest", i)), honestBuyer, seller, honestBuyerVolume
                );
            }
            usageAccounting.accruePoints(keccak256("wash"), washBuyer, otherSeller, washVolume);

            uint256 honestAgentId = _agentId(seller);
            uint256 washAgentId = _agentId(otherSeller);
            uint256 honestPower = sellerPools.poolPowerWeightAtEpoch(honestAgentId, 5);
            uint256 washPower = sellerPools.poolPowerWeightAtEpoch(washAgentId, 5);
            run.firstWeightedPoints = honestTotalVolume * honestPower;
            run.washWeightedPoints = washVolume * washPower;
            run.expectedTotalWeightedPoints = run.firstWeightedPoints + run.washWeightedPoints;

            assertEq(usageAccounting.agentPoolPointsByEpoch(5, honestAgentId), honestTotalVolume);
            assertEq(usageAccounting.agentPoolPointsByEpoch(5, washAgentId), washVolume);
            assertEq(usageAccounting.weightedPoolPointsByEpoch(5, washAgentId), washVolume * washPower);
            assertEq(usageAccounting.weightedPoolPointsByEpoch(5, honestAgentId), run.firstWeightedPoints);
            assertEq(usageAccounting.weightedPoolPointsByEpoch(5, washAgentId), run.washWeightedPoints);
            assertEq(usageAccounting.totalWeightedPoolPointsByEpoch(5), run.expectedTotalWeightedPoints);

            assertEq(usageAccounting.weightedBuyerPointsByEpoch(5, washBuyer), run.washWeightedPoints);
            assertEq(usageAccounting.totalWeightedBuyerPointsByEpoch(5), run.expectedTotalWeightedPoints);
        }

        _warpGateEpoch(6);
        {
            uint256 sellerPoolsBudget = sellerPoolsRewards.stakerEpochBudget(5);
            (uint256 honestGross, uint256 honestClaimable, uint256 honestBurned) =
                sellerPoolsRewards.pendingStakerReward(run.firstPositionId, 5);
            (uint256 washGross, uint256 washClaimable, uint256 washBurned) =
                sellerPoolsRewards.pendingStakerReward(run.washPositionId, 5);
            run.firstClaimable = honestClaimable;
            run.washClaimable = washClaimable;
            assertEq(honestGross, (sellerPoolsBudget * run.firstWeightedPoints) / run.expectedTotalWeightedPoints);
            assertEq(washGross, (sellerPoolsBudget * run.washWeightedPoints) / run.expectedTotalWeightedPoints);
            assertEq(washClaimable, washGross);
            assertEq(honestClaimable, honestGross);
            assertEq(washBurned, 0);
            assertEq(honestBurned, 0);
        }

        {
            uint256 buyerSideBudget = usageRewards.buyerEpochBudget(5);
            uint256 expectedWashBuyerReward =
                (buyerSideBudget * run.washWeightedPoints) / run.expectedTotalWeightedPoints;
            uint256 washBuyerCap =
                (buyerSideBudget * usageRewards.MAX_REWARD_SHARE_BPS()) / usageRewards.BPS_DENOMINATOR();
            uint256 cappedWashBuyerReward =
                expectedWashBuyerReward < washBuyerCap ? expectedWashBuyerReward : washBuyerCap;
            assertEq(usageRewards.pendingBuyerReward(washBuyer, 5), cappedWashBuyerReward);
            assertLt(usageRewards.pendingBuyerReward(washBuyer, 5), expectedWashBuyerReward);
        }

        assertGt(run.washWeightedPoints, run.firstWeightedPoints);
        assertGt(run.washClaimable, run.firstClaimable);
        assertLe(run.washClaimable, sellerPoolsRewards.stakerEpochBudget(5));
    }

    function test_stressThousandAgentsAndBuyersClaimFromSavedTotals() public {
        uint256 agentCount = 1_000;
        uint256 honestVolume = 1_000;
        uint256 washVolume = 1_000_000_000;
        address firstSeller = address(uint160(0x30000));
        address firstBuyer = address(uint160(0x40000));
        address washSeller = address(uint160(0x30000 + agentCount - 1));
        address washBuyer = address(uint160(0x40000 + agentCount - 1));
        StressRun memory run;

        _deployGate(4);

        sellerPools = new AntseedSellerPools(address(realRegistry), 10_000, 2_000, 500);
        usageAccounting.setSellerPools(address(sellerPools));
        sellerPoolsRewards =
            new AntseedSellerPoolsRewards(address(gate), address(sellerPools), address(usageAccounting));
        usageRewards = new AntseedUsageRewards(address(gate), address(realRegistry), address(usageAccounting));
        sellerPools.setRewardStaker(address(sellerPoolsRewards), true);
        _setSellerPoolsMinter(address(sellerPoolsRewards));
        _setUsageMinter(address(usageRewards));

        vm.pauseGasMetering();
        for (uint256 i = 0; i < agentCount; i++) {
            address seller_ = address(uint160(0x30000 + i));
            uint256 stakeAmount = seller_ == washSeller ? 100 ether : 1_000 ether;
            deal(address(token), seller_, stakeAmount);
            uint256 positionId = _stakeAgentPool(sellerPools, seller_, stakeAmount, 52);
            if (seller_ == firstSeller) run.firstPositionId = positionId;
            if (seller_ == washSeller) run.washPositionId = positionId;
        }
        vm.resumeGasMetering();

        _warpGateEpoch(5);
        for (uint256 i = 0; i < agentCount; i++) {
            address seller_ = address(uint160(0x30000 + i));
            address buyer_ = address(uint160(0x40000 + i));
            uint256 volume = seller_ == washSeller ? washVolume : honestVolume;

            usageAccounting.accruePoints(keccak256(abi.encodePacked("stress", i)), buyer_, seller_, volume);

            uint256 weightedPoints = volume * sellerPools.poolPowerWeightAtEpoch(_agentId(seller_), 5);
            run.expectedTotalWeightedPoints += weightedPoints;
            if (seller_ == firstSeller) run.firstWeightedPoints = weightedPoints;
            if (seller_ == washSeller) run.washWeightedPoints = weightedPoints;
        }

        uint256 firstAgentId = _agentId(firstSeller);
        uint256 washAgentId = _agentId(washSeller);
        assertEq(usageAccounting.totalWeightedPoolPointsByEpoch(5), run.expectedTotalWeightedPoints);
        assertEq(usageAccounting.totalWeightedBuyerPointsByEpoch(5), run.expectedTotalWeightedPoints);
        assertEq(usageAccounting.weightedPoolPointsByEpoch(5, firstAgentId), run.firstWeightedPoints);
        assertEq(usageAccounting.weightedPoolPointsByEpoch(5, washAgentId), run.washWeightedPoints);
        assertEq(usageAccounting.weightedBuyerPointsByEpoch(5, firstBuyer), run.firstWeightedPoints);
        assertEq(usageAccounting.weightedBuyerPointsByEpoch(5, washBuyer), run.washWeightedPoints);

        _warpGateEpoch(6);
        {
            uint256 sellerPoolsBudget = sellerPoolsRewards.stakerEpochBudget(5);
            uint256 expectedFirstGross = (sellerPoolsBudget * run.firstWeightedPoints) / run.expectedTotalWeightedPoints;
            uint256 expectedWashGross = (sellerPoolsBudget * run.washWeightedPoints) / run.expectedTotalWeightedPoints;

            (uint256 firstGross, uint256 firstClaimable, uint256 firstBurned) =
                sellerPoolsRewards.pendingStakerReward(run.firstPositionId, 5);
            (uint256 washGross, uint256 washClaimable, uint256 washBurned) =
                sellerPoolsRewards.pendingStakerReward(run.washPositionId, 5);
            run.firstClaimable = firstClaimable;
            run.washClaimable = washClaimable;
            assertEq(firstGross, expectedFirstGross);
            assertEq(washGross, expectedWashGross);
            assertEq(firstClaimable, firstGross);
            assertEq(washClaimable, washGross);
            assertEq(firstBurned, 0);
            assertEq(washBurned, 0);
        }

        sellerPoolsRewards.indexPoolRewards(firstAgentId, 10);
        run.firstClaimable = sellerPoolsRewards.pendingIndexedStakerReward(run.firstPositionId);
        vm.prank(firstSeller);
        sellerPoolsRewards.claimStakerRewards(run.firstPositionId, firstSeller);
        sellerPoolsRewards.indexPoolRewards(washAgentId, 10);
        run.washClaimable = sellerPoolsRewards.pendingIndexedStakerReward(run.washPositionId);
        vm.prank(washSeller);
        sellerPoolsRewards.claimStakerRewards(run.washPositionId, washSeller);
        assertEq(token.balanceOf(firstSeller), run.firstClaimable);
        assertEq(token.balanceOf(washSeller), run.washClaimable);
        assertEq(token.balanceOf(gate.DEAD_ADDRESS()), 0);
        assertEq(gate.epochBurnedAmount(5), 0);

        {
            uint256 buyerSideBudget = usageRewards.buyerEpochBudget(5);
            uint256 washBuyerGross = (buyerSideBudget * run.washWeightedPoints) / run.expectedTotalWeightedPoints;
            uint256 washBuyerCap =
                (buyerSideBudget * usageRewards.MAX_REWARD_SHARE_BPS()) / usageRewards.BPS_DENOMINATOR();
            uint256 washBuyerClaimable = washBuyerGross < washBuyerCap ? washBuyerGross : washBuyerCap;
            assertEq(usageRewards.pendingBuyerReward(washBuyer, 5), washBuyerClaimable);

            address washOperator = address(0x50000);
            deposits.setOperator(washBuyer, washOperator);
            vm.prank(washOperator);
            usageRewards.claimBuyerReward(washBuyer, 5);
            assertEq(token.balanceOf(washBuyer), 0);
            assertEq(token.balanceOf(washOperator), washBuyerClaimable);
        }
    }

    function test_stakeCreatedDuringEpochDoesNotEarnUntilNextEpoch() public {
        _deployGate(4);

        sellerPools = new AntseedSellerPools(address(realRegistry), 0, 0, 0);
        usageAccounting.setSellerPools(address(sellerPools));
        address poolSeller = _createSellerPool(sellerPools, seller, 5_000, keccak256("terms"));

        usageAccounting.accruePoints(keccak256("same-epoch"), buyer, seller, 10);
        assertEq(usageAccounting.sellerPointsByEpoch(4, seller), 0);
        assertEq(usageAccounting.buyerPointsByEpoch(4, buyer), 0);
        assertEq(usageAccounting.poolPointsByEpoch(4, poolSeller), 0);
        assertEq(usageAccounting.weightedPoolPointsByEpoch(4, poolSeller), 0);

        _warpGateEpoch(5);
        usageAccounting.accruePoints(keccak256("next-epoch"), buyer, seller, 10);
        assertGt(usageAccounting.weightedPoolPointsByEpoch(5, poolSeller), 0);
    }

    function test_buyerRewardsRequirePoolWeightedBuyerPoints() public {
        address secondBuyer = address(0x21);
        _deployGate(4);

        sellerPools = new AntseedSellerPools(address(realRegistry), 0, 0, 0);
        usageAccounting.setSellerPools(address(sellerPools));
        _createSellerPool(sellerPools, seller, 5_000, keccak256("terms"));

        MockUsagePointsPolicy policy = new MockUsagePointsPolicy();
        policy.setSellerWeightBps(seller, 0);
        policy.setBuyerWeightBps(0);
        usageAccounting.setPointsPolicy(address(policy));

        usageRewards = new AntseedUsageRewards(address(gate), address(realRegistry), address(usageAccounting));
        _setUsageMinter(address(usageRewards));

        _warpGateEpoch(5);
        usageAccounting.accruePoints(keccak256("buyer-one"), buyer, seller, 10);
        usageAccounting.accruePoints(keccak256("buyer-two"), secondBuyer, seller, 30);

        assertEq(usageAccounting.sellerPointsByEpoch(5, seller), 0);
        assertEq(usageAccounting.buyerPointsByEpoch(5, buyer), 0);
        assertEq(usageAccounting.buyerPointsByEpoch(5, secondBuyer), 0);
        assertEq(usageAccounting.totalBuyerPointsByEpoch(5), 0);
        assertEq(usageAccounting.weightedBuyerPointsByEpoch(5, buyer), 0);
        assertEq(usageAccounting.totalWeightedBuyerPointsByEpoch(5), 0);

        _warpGateEpoch(6);
        assertEq(usageRewards.pendingBuyerReward(buyer, 5), 0);
        assertEq(usageRewards.pendingBuyerReward(secondBuyer, 5), 0);
    }

    function test_usageDynamicBudgetsFollowSameEpochVolume() public {
        _deployGate(3);

        sellerPools = new AntseedSellerPools(address(realRegistry), 0, 0, 0);
        usageAccounting.setSellerPools(address(sellerPools));
        usageRewards = new AntseedUsageRewards(address(gate), address(realRegistry), address(usageAccounting));
        usageRewards.setDynamicUsageConfig(5_000, 10_000, 5_000, 10_000, 1_000);
        _setUsageMinter(address(usageRewards));

        _createSellerPool(sellerPools, seller, 5_000, keccak256("terms"));

        _warpGateEpoch(4);
        assertEq(usageRewards.buyerEpochBudget(4), 0);
        assertEq(usageRewards.sellerEpochBudget(4), 0);
        assertEq(usageRewards.allocatedEpochBudget(4), 0);

        usageAccounting.accruePoints(keccak256("same-epoch-volume"), buyer, seller, 1_000);

        uint256 expectedSideBudget = _shareBudget(7_500, 4);
        assertEq(usageRewards.buyerEpochBudget(4), expectedSideBudget);
        assertEq(usageRewards.sellerEpochBudget(4), expectedSideBudget);
        assertEq(usageRewards.allocatedEpochBudget(4), expectedSideBudget * 2);
        assertLt(usageRewards.allocatedEpochBudget(4), gate.controllerEpochBudget(address(usageRewards), 4));
    }

    function test_usageDynamicBudgetsScaleDownToGateBucket() public {
        _deployGate(3);

        sellerPools = new AntseedSellerPools(address(realRegistry), 0, 0, 0);
        usageAccounting.setSellerPools(address(sellerPools));
        usageRewards = new AntseedUsageRewards(address(gate), address(realRegistry), address(usageAccounting));
        usageRewards.setDynamicUsageConfig(5_000, 10_000, 5_000, 10_000, 1_000);
        _setUsageMinter(address(usageRewards));
        gate.setMinter(USAGE_MINTER_ID, address(usageRewards), 10_000, true);

        _createSellerPool(sellerPools, seller, 5_000, keccak256("terms"));

        _warpGateEpoch(4);
        usageAccounting.accruePoints(keccak256("same-epoch-volume"), buyer, seller, 1_000);

        uint256 maxBudget = gate.controllerEpochBudget(address(usageRewards), 4);
        assertEq(usageRewards.allocatedEpochBudget(4), maxBudget);
        assertEq(usageRewards.buyerEpochBudget(4), maxBudget / 2);
        assertEq(usageRewards.sellerEpochBudget(4), maxBudget - maxBudget / 2);
    }

    function test_usageRemainderRoutesThroughGlobalBurnCap() public {
        _deployGate(3);

        sellerPools = new AntseedSellerPools(address(realRegistry), 0, 0, 0);
        usageAccounting.setSellerPools(address(sellerPools));
        usageRewards = new AntseedUsageRewards(address(gate), address(realRegistry), address(usageAccounting));
        usageRewards.setDynamicUsageConfig(5_000, 10_000, 5_000, 10_000, 1_000);
        _setUsageMinter(address(usageRewards));

        _createSellerPool(sellerPools, seller, 5_000, keccak256("terms"));
        _warpGateEpoch(4);
        usageAccounting.accruePoints(keccak256("same-epoch-volume"), buyer, seller, 1_000);

        _warpGateEpoch(5);
        uint256 maxBudget = gate.controllerEpochBudget(address(usageRewards), 4);
        uint256 allocatedBudget = usageRewards.allocatedEpochBudget(4);
        uint256 unallocated = maxBudget - allocatedBudget;

        (uint256 burnedAmount, uint256 reserveAmount) = usageRewards.settleEpochRemainder(4);
        assertEq(burnedAmount, unallocated);
        assertEq(reserveAmount, 0);
        assertEq(token.balanceOf(gate.DEAD_ADDRESS()), burnedAmount);
        assertEq(gate.epochBurnedAmount(4), burnedAmount);

        vm.expectRevert(AntseedUsageRewards.AlreadyClaimed.selector);
        usageRewards.settleEpochRemainder(4);
    }

    function test_usageRewardsUsePoolWeightedShareAndOperatorRecipient() public {
        address secondBuyer = address(0x21);
        _deployGate(3);

        sellerPools = new AntseedSellerPools(address(realRegistry), 0, 0, 0);
        usageAccounting.setSellerPools(address(sellerPools));

        usageRewards = new AntseedUsageRewards(address(gate), address(realRegistry), address(usageAccounting));
        _setUsageMinter(address(usageRewards));

        deal(address(token), seller, 100 ether);
        deal(address(token), otherSeller, 10 ether);

        vm.startPrank(seller);
        token.approve(address(sellerPools), 100 ether);
        sellerAgentLookup.setAgent(seller, _agentId(seller));
        identityRegistry.setOwner(_agentId(seller), seller);
        sellerPools.stake(_agentId(seller), 100 ether, 4);
        vm.stopPrank();

        vm.startPrank(otherSeller);
        token.approve(address(sellerPools), 10 ether);
        sellerAgentLookup.setAgent(otherSeller, _agentId(otherSeller));
        identityRegistry.setOwner(_agentId(otherSeller), otherSeller);
        sellerPools.stake(_agentId(otherSeller), 10 ether, 4);
        vm.stopPrank();

        _warpGateEpoch(4);
        usageAccounting.accruePoints(keccak256("high-power"), buyer, seller, 100);
        usageAccounting.accruePoints(keccak256("low-power"), secondBuyer, otherSeller, 100);

        uint256 highPower = sellerPools.poolPowerWeightAtEpoch(seller, 4);
        uint256 lowPower = sellerPools.poolPowerWeightAtEpoch(otherSeller, 4);
        uint256 buyerWeightedPoints = 100 * highPower;
        uint256 secondBuyerWeightedPoints = 100 * lowPower;
        uint256 totalWeightedPoints = buyerWeightedPoints + secondBuyerWeightedPoints;

        assertEq(usageAccounting.weightedBuyerPointsByEpoch(4, buyer), buyerWeightedPoints);
        assertEq(usageAccounting.weightedBuyerPointsByEpoch(4, secondBuyer), secondBuyerWeightedPoints);
        assertEq(usageAccounting.totalWeightedBuyerPointsByEpoch(4), totalWeightedPoints);

        _warpGateEpoch(5);

        uint256 buyerSideBudget = usageRewards.buyerEpochBudget(4);
        uint256 grossBuyerReward = (buyerSideBudget * buyerWeightedPoints) / totalWeightedPoints;
        uint256 grossSecondBuyerReward = (buyerSideBudget * secondBuyerWeightedPoints) / totalWeightedPoints;
        uint256 buyerReward = usageRewards.pendingBuyerReward(buyer, 4);
        uint256 secondBuyerReward = usageRewards.pendingBuyerReward(secondBuyer, 4);
        uint256 buyerCap = (buyerSideBudget * usageRewards.MAX_REWARD_SHARE_BPS()) / usageRewards.BPS_DENOMINATOR();
        assertEq(buyerReward, buyerCap);
        assertEq(secondBuyerReward, grossSecondBuyerReward < buyerCap ? grossSecondBuyerReward : buyerCap);

        vm.expectRevert(AntseedUsageRewards.NotRewardRecipient.selector);
        usageRewards.claimBuyerReward(buyer, 4);

        vm.prank(operator);
        usageRewards.claimBuyerReward(buyer, 4);
        assertEq(token.balanceOf(operator), buyerReward);
        assertEq(token.balanceOf(reserveDest), grossBuyerReward - buyerReward);

        // A buyer without a resolvable Deposits operator can never be paid
        // directly: the claim reverts (and stays claimable) until an operator
        // is registered.
        vm.expectRevert(AntseedUsageRewards.RewardRecipientUnavailable.selector);
        usageRewards.claimBuyerReward(secondBuyer, 4);
        assertEq(token.balanceOf(secondBuyer), 0);

        address secondOperator = address(0x22);
        deposits.setOperator(secondBuyer, secondOperator);
        vm.expectRevert(AntseedUsageRewards.NotRewardRecipient.selector);
        usageRewards.claimBuyerReward(secondBuyer, 4);

        vm.prank(secondOperator);
        usageRewards.claimBuyerReward(secondBuyer, 4);
        assertEq(token.balanceOf(secondBuyer), 0);
        assertEq(token.balanceOf(secondOperator), secondBuyerReward);
        assertEq(
            token.balanceOf(reserveDest),
            (grossBuyerReward - buyerReward) + (grossSecondBuyerReward - secondBuyerReward)
        );

        vm.expectRevert(AntseedUsageRewards.AlreadyClaimed.selector);
        usageRewards.claimBuyerReward(buyer, 4);
    }

    function test_buyerRewardsCanStakeAsBuyerThroughOperatorViaStakeFor() public {
        _deployGate(4);

        sellerPools = new AntseedSellerPools(address(realRegistry), 0, 0, 0);
        usageAccounting.setSellerPools(address(sellerPools));
        usageRewards = new AntseedUsageRewards(address(gate), address(realRegistry), address(usageAccounting));
        usageRewards.setSellerPools(address(sellerPools));
        _setUsageMinter(address(usageRewards));

        _createSellerPool(sellerPools, seller, 5_000, keccak256("terms"));

        uint256 buyerStakeAgentId = _agentId(buyer);
        uint256 otherStakeAgentId = _agentId(otherSeller);
        identityRegistry.setOwner(buyerStakeAgentId, buyer);
        sellerAgentLookup.setAgent(otherSeller, otherStakeAgentId);
        identityRegistry.setOwner(otherStakeAgentId, otherSeller);

        _warpGateEpoch(5);
        usageAccounting.accruePoints(keccak256("buyer-stake-direct"), buyer, seller, 100);

        uint256 grossReward = usageRewards.buyerEpochBudget(5);
        uint256 expectedReward = (grossReward * usageRewards.MAX_REWARD_SHARE_BPS()) / usageRewards.BPS_DENOMINATOR();
        _warpGateEpoch(6);

        vm.prank(buyer);
        vm.expectRevert(AntseedUsageRewards.NotRewardRecipient.selector);
        usageRewards.stakeBuyerReward(buyer, 5, buyerStakeAgentId, 4);

        vm.prank(operator);
        uint256 newPositionId = usageRewards.stakeBuyerReward(buyer, 5, otherStakeAgentId, 4);

        (address owner, uint256 positionAgentId, uint256 amount, uint256 weightAmount, uint64 startEpoch,,,) =
            sellerPools.positions(newPositionId);
        assertEq(owner, operator);
        assertEq(sellerPools.ownerOf(newPositionId), operator);
        assertEq(positionAgentId, otherStakeAgentId);
        assertEq(amount, expectedReward);
        assertEq(weightAmount, expectedReward);
        assertEq(startEpoch, 7);
        assertEq(token.balanceOf(buyer), 0);
        assertEq(token.balanceOf(address(usageRewards)), 0);
        assertEq(token.balanceOf(operator), 0);
        assertEq(token.balanceOf(reserveDest), grossReward - expectedReward);
        assertEq(sellerPools.stakerAgentActiveStake(buyer, buyerStakeAgentId), 0);
        assertEq(sellerPools.stakerAgentActiveStake(operator, otherStakeAgentId), expectedReward);
        assertTrue(usageRewards.buyerEpochClaimed(buyer, 5));

        vm.expectRevert(AntseedUsageRewards.AlreadyClaimed.selector);
        usageRewards.claimBuyerReward(buyer, 5);
    }

    function test_usageRewardsValidationAndPause() public {
        _deployGate(4);

        vm.expectRevert(AntseedUsageRewards.InvalidAddress.selector);
        new AntseedUsageRewards(address(0), address(realRegistry), address(usageAccounting));

        vm.expectRevert(AntseedUsageRewards.InvalidAddress.selector);
        new AntseedUsageRewards(address(gate), address(0), address(usageAccounting));

        vm.expectRevert(AntseedUsageRewards.InvalidAddress.selector);
        new AntseedUsageRewards(address(gate), address(realRegistry), address(0));

        usageRewards = new AntseedUsageRewards(address(gate), address(realRegistry), address(usageAccounting));
        _setUsageMinter(address(usageRewards));
        assertEq(usageRewards.volumeShareTarget(), 1_000_000e6);

        vm.expectRevert(AntseedUsageRewards.InvalidAddress.selector);
        usageRewards.claimBuyerReward(address(0), 4);

        vm.expectRevert(AntseedUsageRewards.NothingToClaim.selector);
        usageRewards.claimBuyerReward(buyer, 4);

        usageRewards.pause();
        assertTrue(usageRewards.paused());
        vm.expectRevert();
        usageRewards.claimBuyerReward(buyer, 4);
        usageRewards.unpause();
        assertFalse(usageRewards.paused());
    }

    function test_sellerOperatorRewardsPaySellerDirectly() public {
        _deployGate(4);

        sellerPools = new AntseedSellerPools(address(realRegistry), 0, 0, 0);
        usageAccounting.setSellerPools(address(sellerPools));
        usageRewards = new AntseedUsageRewards(address(gate), address(realRegistry), address(usageAccounting));
        _setUsageMinter(address(usageRewards));

        _createSellerPool(sellerPools, seller, 5_000, keccak256("terms"));

        _warpGateEpoch(5);
        usageAccounting.accruePoints(keccak256("seller-direct"), buyer, seller, 100);

        uint256 grossReward = usageRewards.sellerEpochBudget(5);
        uint256 expectedReward = (grossReward * usageRewards.MAX_REWARD_SHARE_BPS()) / usageRewards.BPS_DENOMINATOR();
        uint256 agentId = _agentId(seller);
        _warpGateEpoch(6);
        assertEq(usageRewards.pendingAgentReward(agentId, 5), expectedReward);

        vm.expectRevert(AntseedUsageRewards.NotRewardRecipient.selector);
        usageRewards.claimAgentReward(agentId, 5);

        vm.prank(seller);
        usageRewards.claimAgentReward(agentId, 5);
        assertEq(token.balanceOf(seller), expectedReward);
        assertEq(token.balanceOf(reserveDest), grossReward - expectedReward);

        vm.expectRevert(AntseedUsageRewards.AlreadyClaimed.selector);
        usageRewards.claimAgentReward(agentId, 5);
    }

    function test_sellerOperatorRewardsCanStakeInsteadOfClaimingViaStakeFor() public {
        _deployGate(4);

        sellerPools = new AntseedSellerPools(address(realRegistry), 0, 0, 0);
        usageAccounting.setSellerPools(address(sellerPools));
        usageRewards = new AntseedUsageRewards(address(gate), address(realRegistry), address(usageAccounting));
        usageRewards.setSellerPools(address(sellerPools));
        _setUsageMinter(address(usageRewards));

        _createSellerPool(sellerPools, seller, 5_000, keccak256("terms"));

        _warpGateEpoch(5);
        usageAccounting.accruePoints(keccak256("seller-stake-direct"), buyer, seller, 100);

        uint256 grossReward = usageRewards.sellerEpochBudget(5);
        uint256 expectedReward = (grossReward * usageRewards.MAX_REWARD_SHARE_BPS()) / usageRewards.BPS_DENOMINATOR();
        uint256 rewardAgentId = _agentId(seller);
        _warpGateEpoch(6);

        vm.prank(otherSeller);
        vm.expectRevert(AntseedUsageRewards.NotRewardRecipient.selector);
        usageRewards.stakeAgentReward(rewardAgentId, 5, 4);

        vm.prank(seller);
        uint256 newPositionId = usageRewards.stakeAgentReward(rewardAgentId, 5, 4);

        (address owner, uint256 positionAgentId, uint256 amount, uint256 weightAmount, uint64 startEpoch,,,) =
            sellerPools.positions(newPositionId);
        assertEq(owner, seller);
        assertEq(sellerPools.ownerOf(newPositionId), seller);
        assertEq(positionAgentId, rewardAgentId);
        assertEq(amount, expectedReward);
        assertEq(weightAmount, expectedReward);
        assertEq(startEpoch, 7);
        assertEq(token.balanceOf(seller), 0);
        assertEq(token.balanceOf(address(usageRewards)), 0);
        assertEq(token.balanceOf(reserveDest), grossReward - expectedReward);
        assertEq(sellerPools.stakerAgentActiveStake(seller, rewardAgentId), 1 ether + expectedReward);
        assertTrue(usageRewards.agentEpochClaimed(rewardAgentId, 5));

        vm.prank(seller);
        vm.expectRevert(AntseedUsageRewards.AlreadyClaimed.selector);
        usageRewards.claimAgentReward(rewardAgentId, 5);
    }

    function test_sellerOperatorRewardsPayCurrentAgentOwner() public {
        address newOwner = address(0x1111);
        _deployGate(4);

        sellerPools = new AntseedSellerPools(address(realRegistry), 0, 0, 0);
        usageAccounting.setSellerPools(address(sellerPools));
        usageRewards = new AntseedUsageRewards(address(gate), address(realRegistry), address(usageAccounting));
        _setUsageMinter(address(usageRewards));

        _createSellerPool(sellerPools, seller, 5_000, keccak256("terms"));

        _warpGateEpoch(5);
        usageAccounting.accruePoints(keccak256("seller-direct-sold-agent"), buyer, seller, 100);

        uint256 agentId = _agentId(seller);
        vm.prank(seller);
        identityRegistry.transferAgent(agentId, newOwner);

        uint256 grossReward = usageRewards.sellerEpochBudget(5);
        uint256 expectedReward = (grossReward * usageRewards.MAX_REWARD_SHARE_BPS()) / usageRewards.BPS_DENOMINATOR();
        _warpGateEpoch(6);
        assertEq(usageRewards.rewardRecipient(agentId), newOwner);
        assertEq(usageRewards.pendingAgentReward(agentId, 5), expectedReward);

        vm.expectRevert(AntseedUsageRewards.NotRewardRecipient.selector);
        usageRewards.claimAgentReward(agentId, 5);

        vm.prank(newOwner);
        usageRewards.claimAgentReward(agentId, 5);
        assertEq(token.balanceOf(newOwner), expectedReward);
        assertEq(token.balanceOf(seller), 0);
        assertEq(token.balanceOf(reserveDest), grossReward - expectedReward);
    }

    function test_sellerOperatorRewardsAreSeparateFromPoolRewards() public {
        _deployGate(4);

        sellerPools = new AntseedSellerPools(address(realRegistry), 0, 0, 0);
        usageAccounting.setSellerPools(address(sellerPools));
        usageRewards = new AntseedUsageRewards(address(gate), address(realRegistry), address(usageAccounting));
        sellerPoolsRewards =
            new AntseedSellerPoolsRewards(address(gate), address(sellerPools), address(usageAccounting));
        sellerPools.setRewardStaker(address(sellerPoolsRewards), true);
        _setUsageMinter(address(usageRewards));
        _setSellerPoolsMinter(address(sellerPoolsRewards));

        _createSellerPool(sellerPools, seller, 5_000, keccak256("terms"));
        uint256 positionId = sellerPools.nextPositionId() - 1;

        _warpGateEpoch(5);
        usageAccounting.accruePoints(keccak256("seller-direct-and-pool"), buyer, seller, 100);

        _warpGateEpoch(6);
        vm.prank(seller);
        usageRewards.claimAgentReward(_agentId(seller), 5);
        sellerPoolsRewards.indexPoolRewards(_agentId(seller), 10);
        vm.prank(seller);
        sellerPoolsRewards.claimStakerRewards(positionId, seller);

        uint256 expectedOperatorReward =
            (usageRewards.sellerEpochBudget(5) * usageRewards.MAX_REWARD_SHARE_BPS()) / usageRewards.BPS_DENOMINATOR();
        assertEq(token.balanceOf(seller), expectedOperatorReward + sellerPoolsRewards.stakerEpochBudget(5));
        assertEq(token.balanceOf(reserveDest), usageRewards.sellerEpochBudget(5) - expectedOperatorReward);
    }

    function test_gateMintValidationAndPause() public {
        _deployGate(4);
        _setSellerPoolsMinter(address(this));

        vm.expectRevert(AntseedEmissionsGate.InvalidAddress.selector);
        gate.claim(4, address(0), 1 ether);

        vm.expectRevert(AntseedEmissionsGate.InvalidValue.selector);
        gate.claim(4, address(this), 0);

        vm.expectRevert(AntseedEmissionsGate.EpochNotFinalized.selector);
        gate.claim(5, address(this), 1 ether);

        _warpGateEpoch(5);
        vm.prank(seller);
        vm.expectRevert(AntseedEmissionsGate.NotEmissionMinter.selector);
        gate.claim(4, seller, 1 ether);

        uint256 bucketBudget = _shareBudget(SELLER_POOLS_SHARE_BPS, 4);
        vm.expectRevert(AntseedEmissionsGate.BucketBudgetExceeded.selector);
        gate.claim(4, address(this), bucketBudget + 1);

        gate.claim(4, address(this), 1 ether);
    }

    function test_gateRemainderUsesGlobalBurnCapAndRejectsOverBucketClaims() public {
        _deployGate(4);
        _setSellerPoolsMinter(address(this));

        _warpGateEpoch(5);
        uint256 budget = gate.controllerEpochBudget(address(this), 4);
        uint256 burnCap = _shareBudget(uint32(gate.BURN_CAP_BPS()), 4);

        vm.expectRevert(AntseedEmissionsGate.InvalidAddress.selector);
        gate.claimRemainder(4, address(0xBEEF), 1);

        (uint256 burnedAmount, uint256 reserveAmount) = gate.claimRemainder(4, reserveDest, budget);

        assertEq(burnedAmount, burnCap);
        assertEq(reserveAmount, budget - burnCap);
        assertEq(token.balanceOf(gate.DEAD_ADDRESS()), burnCap);
        assertEq(token.balanceOf(reserveDest), budget - burnCap);
        assertEq(gate.epochBurnedAmount(4), burnCap);
        assertEq(gate.minterEpochMinted(SELLER_POOLS_MINTER_ID, 4), budget);

        vm.expectRevert(AntseedEmissionsGate.BucketBudgetExceeded.selector);
        gate.claimRemainder(4, reserveDest, 1);
    }

    function test_fixedBucketSharesSumToPostMigrationEpochBudget() public {
        _deployGate(5);
        _setEmissionMinters(address(this), address(0xBEEF));

        uint256 totalBudget = gate.minterEpochBudget(SELLER_POOLS_MINTER_ID, 5)
            + gate.minterEpochBudget(USAGE_MINTER_ID, 5) + gate.minterEpochBudget(TEAM_MINTER_ID, 5)
            + gate.minterEpochBudget(RESERVE_MINTER_ID, 5) + gate.minterEpochBudget(VERIFICATION_MINTER_ID, 5);
        assertEq(totalBudget, gate.getEpochEmission(5));

        assertEq(gate.minterEpochBudget(USAGE_MINTER_ID, 5), _shareBudget(USAGE_SHARE_BPS, 5));
    }

    function test_gateCapsTotalBucketMintsByEpochEmission() public {
        vm.warp(GATE_GENESIS + GATE_EPOCH_DURATION * 4 + 1);
        gate = new AntseedEmissionsGate(address(realRegistry), TEAM_SHARE_BPS, RESERVE_SHARE_BPS);
        _warpGateEpoch(5);
        _setVerificationMinter(verificationWallet);
        address usageMinter = address(0xBEEF);
        _setEmissionMinters(address(this), usageMinter);
        token.setRegistry(address(gate));

        uint256 epochEmission = gate.getEpochEmission(4);
        uint256 sellerPoolsBudget = _shareBudget(SELLER_POOLS_SHARE_BPS, 4);
        uint256 usageBudget = _shareBudget(USAGE_SHARE_BPS, 4);
        gate.claim(4, address(this), sellerPoolsBudget);
        vm.prank(usageMinter);
        gate.claim(4, address(this), usageBudget);
        _claim(TEAM_MINTER_ID, teamWallet, 4);
        _claim(RESERVE_MINTER_ID, reserveDest, 4);
        _claim(VERIFICATION_MINTER_ID, verificationWallet, 4);
        assertEq(gate.epochMinted(4), epochEmission);

        vm.prank(usageMinter);
        vm.expectRevert(AntseedEmissionsGate.BucketBudgetExceeded.selector);
        gate.claim(4, address(this), 1);
    }

    function test_ownerCanUpdateUsageMinterDirectly() public {
        _deployGate(4);

        _setUsageMinter(address(this));
        assertEq(_configuredMinter(USAGE_MINTER_ID), address(this));
        assertEq(gate.minterEpochBudget(USAGE_MINTER_ID, 4), _shareBudget(USAGE_SHARE_BPS, 4));
        assertEq(gate.minterEpochBudget(USAGE_MINTER_ID, 7), _shareBudget(USAGE_SHARE_BPS, 7));

        _warpGateEpoch(5);
        gate.claim(4, address(this), _shareBudget(USAGE_SHARE_BPS, 4));
        assertEq(token.balanceOf(address(this)), _shareBudget(USAGE_SHARE_BPS, 4));

        address newMinter = address(0xBEEF);
        gate.setMinter(USAGE_MINTER_ID, newMinter, USAGE_SHARE_BPS, true);
        assertEq(_configuredMinter(USAGE_MINTER_ID), newMinter);
        assertEq(gate.minterEpochMinted(USAGE_MINTER_ID, 4), _shareBudget(USAGE_SHARE_BPS, 4));
        assertEq(gate.controllerMinterIds(address(this)), bytes32(0));
        assertEq(gate.controllerMinterIds(newMinter), USAGE_MINTER_ID);

        _warpGateEpoch(6);
        uint256 epoch5Budget = _shareBudget(USAGE_SHARE_BPS, 5);
        vm.expectRevert(AntseedEmissionsGate.NotEmissionMinter.selector);
        gate.claim(5, address(this), epoch5Budget);

        vm.prank(newMinter);
        gate.claim(5, newMinter, epoch5Budget);
        assertEq(token.balanceOf(newMinter), epoch5Budget);
    }

    function test_ownerCanUpdateControllerMinterShare() public {
        _deployGate(4);

        _setSellerPoolsMinter(address(this));
        assertEq(gate.totalMinterShareBps(), 80_000);

        gate.setMinter(SELLER_POOLS_MINTER_ID, address(this), 10_000, true);
        assertEq(gate.totalMinterShareBps(), 50_000);
        assertEq(gate.minterEpochBudget(SELLER_POOLS_MINTER_ID, 4), _shareBudget(SELLER_POOLS_SHARE_BPS, 4));
        assertEq(gate.minterEpochBudget(SELLER_POOLS_MINTER_ID, 5), _shareBudget(10_000, 5));
    }

    function test_ownerCanConfigureCustomMinterShare() public {
        _deployGate(4);

        address customMinter = address(0xCAFE);
        gate.setMinter(CUSTOM_MINTER_ID, customMinter, 7_000, true);

        (address configuredMinter, uint32 shareBps, bool editable) = gate.minters(CUSTOM_MINTER_ID);
        assertEq(configuredMinter, customMinter);
        assertEq(shareBps, 7_000);
        assertTrue(editable);
        assertEq(gate.totalMinterShareBps(), 47_000);
        assertEq(gate.minterEpochBudget(CUSTOM_MINTER_ID, 4), _shareBudget(7_000, 4));

        _warpGateEpoch(5);
        uint256 budget = _shareBudget(7_000, 4);
        vm.prank(customMinter);
        gate.claim(4, customMinter, budget);
        assertEq(gate.minterEpochMinted(CUSTOM_MINTER_ID, 4), budget);
        assertEq(token.balanceOf(customMinter), budget);

        vm.prank(customMinter);
        vm.expectRevert(AntseedEmissionsGate.BucketBudgetExceeded.selector);
        gate.claim(4, customMinter, 1);

        gate.removeMinter(CUSTOM_MINTER_ID);
        assertEq(gate.totalMinterShareBps(), 40_000);
        assertEq(gate.minterEpochBudget(CUSTOM_MINTER_ID, 4), 0);

        vm.prank(customMinter);
        vm.expectRevert(AntseedEmissionsGate.NotEmissionMinter.selector);
        gate.claim(4, customMinter, 1);
    }

    function test_ownerCanChangeNamedMinterShare() public {
        _deployGate(4);

        _setSellerPoolsMinter(address(this));
        gate.setMinter(SELLER_POOLS_MINTER_ID, address(this), 30_000, true);

        assertEq(gate.totalMinterShareBps(), 70_000);
        assertEq(gate.minterEpochBudget(SELLER_POOLS_MINTER_ID, 4), _shareBudget(SELLER_POOLS_SHARE_BPS, 4));
        assertEq(gate.minterEpochBudget(SELLER_POOLS_MINTER_ID, 5), _shareBudget(30_000, 5));

        _warpGateEpoch(5);
        uint256 budget = _shareBudget(SELLER_POOLS_SHARE_BPS, 4);
        gate.claim(4, address(this), budget);
        assertEq(gate.minterEpochMinted(SELLER_POOLS_MINTER_ID, 4), budget);
    }

    function test_shareEditsDoNotRewriteFinalizedEpochBudgets() public {
        _deployGate(4);

        _setSellerPoolsMinter(address(this));
        assertEq(gate.minterEpochBudget(SELLER_POOLS_MINTER_ID, 4), _shareBudget(SELLER_POOLS_SHARE_BPS, 4));

        _warpGateEpoch(5);
        gate.setMinter(SELLER_POOLS_MINTER_ID, address(this), 30_000, true);

        assertEq(gate.totalMinterShareBps(), 70_000);
        assertEq(gate.minterEpochBudget(SELLER_POOLS_MINTER_ID, 4), _shareBudget(SELLER_POOLS_SHARE_BPS, 4));
        assertEq(gate.minterEpochBudget(SELLER_POOLS_MINTER_ID, 5), _shareBudget(SELLER_POOLS_SHARE_BPS, 5));
        assertEq(gate.minterEpochBudget(SELLER_POOLS_MINTER_ID, 6), _shareBudget(30_000, 6));

        uint256 epoch4Budget = _shareBudget(SELLER_POOLS_SHARE_BPS, 4);
        gate.claim(4, address(this), epoch4Budget);
        assertEq(gate.minterEpochMinted(SELLER_POOLS_MINTER_ID, 4), epoch4Budget);

        vm.expectRevert(AntseedEmissionsGate.BucketBudgetExceeded.selector);
        gate.claim(4, address(this), 1);

        _warpGateEpoch(6);
        uint256 epoch5Budget = _shareBudget(SELLER_POOLS_SHARE_BPS, 5);
        gate.claim(5, address(this), epoch5Budget);
        assertEq(gate.minterEpochMinted(SELLER_POOLS_MINTER_ID, 5), epoch5Budget);

        _warpGateEpoch(7);
        uint256 epoch6Budget = _shareBudget(30_000, 6);
        gate.claim(6, address(this), epoch6Budget);
        assertEq(gate.minterEpochMinted(SELLER_POOLS_MINTER_ID, 6), epoch6Budget);
    }

    function test_lockedMinterCannotBeEditedOrRemoved() public {
        _deployGate(4);

        address lockedMinter = address(0xCAFE);
        gate.setMinter(LOCKED_MINTER_ID, lockedMinter, 7_000, false);

        vm.expectRevert(AntseedEmissionsGate.MinterNotEditable.selector);
        gate.setMinter(LOCKED_MINTER_ID, lockedMinter, 6_000, true);

        vm.expectRevert(AntseedEmissionsGate.MinterNotEditable.selector);
        gate.removeMinter(LOCKED_MINTER_ID);

        address newLockedMinter = address(0xBEEF);
        gate.setMinterController(LOCKED_MINTER_ID, newLockedMinter);
        assertEq(_configuredMinter(LOCKED_MINTER_ID), newLockedMinter);
        assertEq(gate.minterEpochBudget(LOCKED_MINTER_ID, 4), _shareBudget(7_000, 4));
        assertEq(gate.controllerMinterIds(lockedMinter), bytes32(0));
        assertEq(gate.controllerMinterIds(newLockedMinter), LOCKED_MINTER_ID);

        _warpGateEpoch(5);
        uint256 budget = _shareBudget(7_000, 4);
        vm.prank(newLockedMinter);
        gate.claim(4, newLockedMinter, budget);
        assertEq(token.balanceOf(newLockedMinter), budget);
    }

    function test_gateRejectsOverAllocatedMinterShares() public {
        _deployGate(4);

        _setEmissionMinters(address(this), address(0xBEEF));
        assertEq(gate.totalMinterShareBps(), 100_000);

        vm.expectRevert(AntseedEmissionsGate.InvalidValue.selector);
        gate.setMinter(CUSTOM_MINTER_ID, address(0xCAFE), 1, true);

        vm.expectRevert(AntseedEmissionsGate.InvalidValue.selector);
        gate.setMinter(SELLER_POOLS_MINTER_ID, address(this), 45_001, true);
    }

    function test_teamAndReserveBucketsAreFixedRecipientClaims() public {
        _deployGate(5);

        uint256 teamBudget = _shareBudget(15_000, 4);
        uint256 reserveBudget = _shareBudget(15_000, 4);

        _claim(TEAM_MINTER_ID, teamWallet, 4);
        assertEq(token.balanceOf(teamWallet), teamBudget);

        _claim(RESERVE_MINTER_ID, reserveDest, 4);
        assertEq(token.balanceOf(reserveDest), reserveBudget);

        vm.expectRevert(AntseedEmissionsGate.InvalidValue.selector);
        vm.prank(teamWallet);
        gate.claim(4, teamWallet, 0);
    }

    function test_registryBackedBucketSharesAreLockedButControllersCanMove() public {
        _deployGate(4);

        address newTeamWallet = address(0xB0B);
        address newReserveWallet = address(0xB0C);
        address newVerificationWallet = address(0xB0D);

        vm.expectRevert(AntseedEmissionsGate.MinterNotEditable.selector);
        gate.setMinter(TEAM_MINTER_ID, newTeamWallet, TEAM_SHARE_BPS, true);

        vm.expectRevert(AntseedEmissionsGate.MinterNotEditable.selector);
        gate.setMinter(RESERVE_MINTER_ID, newReserveWallet, RESERVE_SHARE_BPS, true);

        gate.setMinterController(TEAM_MINTER_ID, newTeamWallet);
        gate.setMinterController(RESERVE_MINTER_ID, newReserveWallet);

        _setVerificationMinter(newVerificationWallet);

        assertEq(_configuredMinter(TEAM_MINTER_ID), newTeamWallet);
        assertEq(_configuredMinter(RESERVE_MINTER_ID), newReserveWallet);
        assertEq(_configuredMinter(VERIFICATION_MINTER_ID), newVerificationWallet);
        assertEq(gate.minterEpochBudget(TEAM_MINTER_ID, 4), _shareBudget(15_000, 4));
        assertEq(gate.minterEpochBudget(RESERVE_MINTER_ID, 4), _shareBudget(15_000, 4));
        assertEq(gate.controllerMinterIds(teamWallet), bytes32(0));
        assertEq(gate.controllerMinterIds(reserveDest), bytes32(0));
        assertEq(gate.controllerMinterIds(newTeamWallet), TEAM_MINTER_ID);
        assertEq(gate.controllerMinterIds(newReserveWallet), RESERVE_MINTER_ID);
        assertEq(gate.controllerMinterIds(verificationWallet), bytes32(0));
        assertEq(gate.controllerMinterIds(newVerificationWallet), VERIFICATION_MINTER_ID);

        _warpGateEpoch(5);
        _claim(TEAM_MINTER_ID, newTeamWallet, 4);
        _claim(RESERVE_MINTER_ID, newReserveWallet, 4);
        uint256 verificationBudgetEpoch4 = _shareBudget(VERIFICATION_SHARE_BPS, 4);
        _claim(VERIFICATION_MINTER_ID, newVerificationWallet, 4);
        assertEq(token.balanceOf(newVerificationWallet), verificationBudgetEpoch4);
        assertEq(token.balanceOf(newTeamWallet), _shareBudget(15_000, 4));
        assertEq(token.balanceOf(newReserveWallet), _shareBudget(15_000, 4));
    }

    function test_verificationBucketFitsDefaultSplitAndPaysItsWallet() public {
        _deployGate(5);

        uint256 verificationBudget = _shareBudget(VERIFICATION_SHARE_BPS, 4);

        _claim(VERIFICATION_MINTER_ID, verificationWallet, 4);
        assertEq(token.balanceOf(verificationWallet), verificationBudget);

        vm.expectRevert(AntseedEmissionsGate.InvalidValue.selector);
        vm.prank(verificationWallet);
        gate.claim(4, verificationWallet, 0);
    }

    function test_sellerPoolsRewardsDistributionValidation() public {
        _deployGate(4);

        sellerPools = new AntseedSellerPools(address(realRegistry), 0, 0, 0);
        usageAccounting.setSellerPools(address(sellerPools));
        sellerPoolsRewards =
            new AntseedSellerPoolsRewards(address(gate), address(sellerPools), address(usageAccounting));
        sellerPools.setRewardStaker(address(sellerPoolsRewards), true);
        _setSellerPoolsMinter(address(sellerPoolsRewards));

        _createSellerPool(sellerPools, seller, 5_000, keccak256("terms"));
        uint256 positionId = sellerPools.nextPositionId() - 1;
        _warpGateEpoch(5);
        usageAccounting.accrueSellerPoints(seller, 10);
        usageAccounting.accrueBuyerPoints(buyer, 10);

        _warpGateEpoch(6);
        sellerPoolsRewards.indexPoolRewards(_agentId(seller), 10);
        vm.prank(seller);
        sellerPoolsRewards.claimStakerRewards(positionId, seller);
        assertEq(token.balanceOf(seller), sellerPoolsRewards.stakerEpochBudget(5));

        vm.expectRevert(AntseedSellerPoolsRewards.NothingToClaim.selector);
        vm.prank(seller);
        sellerPoolsRewards.claimStakerRewards(positionId, seller);

        vm.expectRevert(AntseedSellerPoolsRewards.InvalidValue.selector);
        sellerPoolsRewards.pendingStakerReward(0, 5);
    }

    function test_stakerDynamicBudgetFollowsActiveStakeSmoothly() public {
        _deployGate(3);

        sellerPools = new AntseedSellerPools(address(realRegistry), 0, 0, 0);
        usageAccounting.setSellerPools(address(sellerPools));
        sellerPoolsRewards =
            new AntseedSellerPoolsRewards(address(gate), address(sellerPools), address(usageAccounting));
        sellerPoolsRewards.setDynamicStakerConfig(2_000, 40_000, 1 ether);
        _setSellerPoolsMinter(address(sellerPoolsRewards));

        assertEq(sellerPoolsRewards.stakerEpochBudget(4), 0);

        _createSellerPool(sellerPools, seller, 5_000, keccak256("terms"));
        _warpGateEpoch(4);

        assertEq(sellerPools.totalActiveStakeAtEpoch(4), 1 ether);
        assertEq(sellerPoolsRewards.stakerEpochBudget(4), _shareBudget(21_000, 4));
        assertLt(sellerPoolsRewards.stakerEpochBudget(4), gate.controllerEpochBudget(address(sellerPoolsRewards), 4));
    }

    function test_stakerDynamicBudgetTargetsAmountAndClampsAfterHalving() public {
        _deployGate(102);

        sellerPools = new AntseedSellerPools(address(realRegistry), 0, 0, 0);
        usageAccounting.setSellerPools(address(sellerPools));
        sellerPoolsRewards =
            new AntseedSellerPoolsRewards(address(gate), address(sellerPools), address(usageAccounting));
        _setSellerPoolsMinter(address(sellerPoolsRewards));

        uint256 stakeAmount = 500_000_000 ether;
        deal(address(token), seller, stakeAmount);
        _stakeAgentPool(sellerPools, seller, stakeAmount, 52);

        uint256 shareBpsAtStake = sellerPoolsRewards.stakerMinShareBps()
            + (uint256(sellerPoolsRewards.stakerMaxShareBps() - sellerPoolsRewards.stakerMinShareBps()) * stakeAmount)
                / (stakeAmount + sellerPoolsRewards.stakeShareTarget());
        uint256 desiredBudget = (gate.getEpochEmission(103) * shareBpsAtStake) / gate.SHARE_DENOMINATOR();
        uint256 postHalvingDesiredBudget = (gate.getEpochEmission(104) * shareBpsAtStake) / gate.SHARE_DENOMINATOR();

        assertEq(sellerPools.totalActiveStakeAtEpoch(103), stakeAmount);
        assertEq(sellerPoolsRewards.stakerEpochBudget(103), desiredBudget);
        assertLt(desiredBudget, gate.controllerEpochBudget(address(sellerPoolsRewards), 103));

        uint256 postHalvingMaxBudget = gate.controllerEpochBudget(address(sellerPoolsRewards), 104);
        assertLt(postHalvingDesiredBudget, postHalvingMaxBudget);
        assertEq(sellerPoolsRewards.stakerEpochBudget(104), postHalvingDesiredBudget);
    }

    function test_sellerPoolsRewardsBatchClaimUsesPositionLogic() public {
        _deployGate(4);

        sellerPools = new AntseedSellerPools(address(realRegistry), 0, 0, 0);
        usageAccounting.setSellerPools(address(sellerPools));
        sellerPoolsRewards =
            new AntseedSellerPoolsRewards(address(gate), address(sellerPools), address(usageAccounting));
        _setSellerPoolsMinter(address(sellerPoolsRewards));

        address poolSeller = _createSellerPool(sellerPools, seller, 5_000, keccak256("terms"));
        sellerAgentLookup.setAgent(otherSeller, _agentId(otherSeller));
        identityRegistry.setOwner(_agentId(otherSeller), otherSeller);

        vm.startPrank(staker);
        token.approve(address(sellerPools), 175 ether);
        uint256 firstPositionId = sellerPools.stake(_agentId(poolSeller), 100 ether, 4);
        uint256 secondPositionId = sellerPools.stake(_agentId(poolSeller), 50 ether, 3);
        uint256 noRewardPositionId = sellerPools.stake(_agentId(otherSeller), 25 ether, 4);
        vm.stopPrank();

        _warpGateEpoch(5);
        usageAccounting.accrueSellerPoints(seller, 100);
        usageAccounting.accrueBuyerPoints(buyer, 100);

        _warpGateEpoch(6);
        uint256[] memory positionIds = new uint256[](3);
        positionIds[0] = firstPositionId;
        positionIds[1] = secondPositionId;
        positionIds[2] = noRewardPositionId;

        (uint256 firstGross,,) = sellerPoolsRewards.pendingStakerReward(firstPositionId, 5);
        (uint256 secondGross,,) = sellerPoolsRewards.pendingStakerReward(secondPositionId, 5);

        sellerPoolsRewards.indexPoolRewards(_agentId(poolSeller), 10);
        vm.prank(staker);
        sellerPoolsRewards.claimStakerRewardsBatch(positionIds, staker);

        assertEq(token.balanceOf(staker), 825 ether + firstGross + secondGross);
        assertEq(sellerPoolsRewards.positionClaimCursor(firstPositionId), 6);
        assertEq(sellerPoolsRewards.positionClaimCursor(secondPositionId), 6);
        assertEq(sellerPoolsRewards.positionClaimCursor(noRewardPositionId), 0);

        vm.expectRevert(AntseedSellerPoolsRewards.NothingToClaim.selector);
        vm.prank(staker);
        sellerPoolsRewards.claimStakerRewardsBatch(positionIds, staker);
    }

    function test_sellerPoolsRewardsBatchRestakeUsesPositionLogicAndCreatesSeparatePositions() public {
        _deployGate(4);

        sellerPools = new AntseedSellerPools(address(realRegistry), 0, 0, 0);
        usageAccounting.setSellerPools(address(sellerPools));
        sellerPoolsRewards =
            new AntseedSellerPoolsRewards(address(gate), address(sellerPools), address(usageAccounting));
        sellerPools.setRewardStaker(address(sellerPoolsRewards), true);
        _setSellerPoolsMinter(address(sellerPoolsRewards));

        address poolSeller = _createSellerPool(sellerPools, seller, 5_000, keccak256("terms"));
        sellerAgentLookup.setAgent(otherSeller, _agentId(otherSeller));
        identityRegistry.setOwner(_agentId(otherSeller), otherSeller);

        vm.startPrank(staker);
        token.approve(address(sellerPools), 175 ether);
        uint256 firstPositionId = sellerPools.stake(_agentId(poolSeller), 100 ether, 4);
        uint256 secondPositionId = sellerPools.stake(_agentId(poolSeller), 50 ether, 3);
        uint256 noRewardPositionId = sellerPools.stake(_agentId(otherSeller), 25 ether, 4);
        vm.stopPrank();

        _warpGateEpoch(5);
        usageAccounting.accrueSellerPoints(seller, 100);
        usageAccounting.accrueBuyerPoints(buyer, 100);

        _warpGateEpoch(6);
        uint256[] memory positionIds = new uint256[](3);
        positionIds[0] = firstPositionId;
        positionIds[1] = secondPositionId;
        positionIds[2] = noRewardPositionId;

        (uint256 firstGross,,) = sellerPoolsRewards.pendingStakerReward(firstPositionId, 5);
        (uint256 secondGross,,) = sellerPoolsRewards.pendingStakerReward(secondPositionId, 5);

        sellerPoolsRewards.indexPoolRewards(_agentId(poolSeller), 10);
        vm.prank(staker);
        uint256[] memory newPositionIds = sellerPoolsRewards.restakeStakerRewardsBatch(positionIds, 2);

        assertEq(newPositionIds.length, 3);
        assertNotEq(newPositionIds[0], newPositionIds[1]);
        assertEq(newPositionIds[2], 0);
        assertEq(token.balanceOf(staker), 825 ether);
        assertEq(sellerPools.stakerPositionCount(staker), 5);

        (,, uint256 amount, uint256 weightAmount, uint64 startEpoch, uint64 stakeEndEpoch,,) =
            sellerPools.positions(newPositionIds[0]);
        uint256 expectedBonusBps = (uint256(500) * 2) / 104;
        uint256 expectedFirstWeightAmount = (firstGross * (10_000 + expectedBonusBps)) / 10_000;
        assertEq(amount, firstGross);
        assertEq(weightAmount, expectedFirstWeightAmount);
        assertEq(startEpoch, 7);
        assertEq(stakeEndEpoch, 9);

        (,, amount, weightAmount, startEpoch, stakeEndEpoch,,) = sellerPools.positions(newPositionIds[1]);
        uint256 expectedSecondWeightAmount = (secondGross * (10_000 + expectedBonusBps)) / 10_000;
        assertEq(amount, secondGross);
        assertEq(weightAmount, expectedSecondWeightAmount);
        assertEq(startEpoch, 7);
        assertEq(stakeEndEpoch, 9);
    }

    function test_sellerPoolsRewardsAdminAndPause() public {
        _deployGate(5);
        sellerPools = new AntseedSellerPools(address(realRegistry), 0, 0, 0);
        sellerPoolsRewards =
            new AntseedSellerPoolsRewards(address(gate), address(sellerPools), address(usageAccounting));

        vm.expectRevert(AntseedSellerPoolsRewards.InvalidAddress.selector);
        new AntseedSellerPoolsRewards(address(0), address(sellerPools), address(usageAccounting));

        vm.expectRevert(AntseedSellerPoolsRewards.InvalidAddress.selector);
        new AntseedSellerPoolsRewards(address(gate), address(0), address(usageAccounting));

        vm.expectRevert(AntseedSellerPoolsRewards.InvalidAddress.selector);
        new AntseedSellerPoolsRewards(address(gate), address(sellerPools), address(0));

        _setSellerPoolsMinter(address(sellerPoolsRewards));
        sellerPoolsRewards.pause();
        assertTrue(sellerPoolsRewards.paused());
        vm.expectRevert();
        sellerPoolsRewards.claimStakerRewards(1, seller);
        sellerPoolsRewards.unpause();
        assertFalse(sellerPoolsRewards.paused());
    }

    function test_gateEffectiveEpochIsCurrentEpochPlusOneAtDeployment() public {
        vm.warp(GATE_GENESIS + GATE_EPOCH_DURATION * 10 + 1);
        AntseedEmissionsGate deployedGate =
            new AntseedEmissionsGate(address(realRegistry), TEAM_SHARE_BPS, RESERVE_SHARE_BPS);
        assertEq(deployedGate.currentEpoch(), 10);
        assertEq(deployedGate.effectiveEpoch(), 11);
    }
}
