// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

import { ANTSToken } from "../core/ANTSToken.sol";
import { AntseedRegistry } from "../core/AntseedRegistry.sol";
import { AntseedPositionInit } from "../sellers/AntseedPositionInit.sol";
import { AntseedSellerPools } from "../sellers/AntseedSellerPools.sol";
import { AntseedSellerRegistry } from "../sellers/AntseedSellerRegistry.sol";
import { MockERC8004Registry } from "./mocks/MockERC8004Registry.sol";
import { IAntseedWashTradingStatus } from "../interfaces/IAntseedWashTradingStatus.sol";
import { AntseedStaking } from "../staking/AntseedStaking.sol";
import { AntseedSlashing } from "../staking/AntseedSlashing.sol";
import { IAntseedChannels } from "../interfaces/IAntseedChannels.sol";
import { MockUSDC } from "./mocks/MockUSDC.sol";

contract MockWashTradingStatusForInit is IAntseedWashTradingStatus {
    mapping(address => bool) public wash;
    bool public failReads;

    function setFailReads(bool value) external {
        failReads = value;
    }

    function set(address seller, bool value) external {
        wash[seller] = value;
    }

    function isProvenWashTrader(address seller) external view returns (bool) {
        require(!failReads, "wash status unavailable");
        return wash[seller];
    }
}

contract MockLegacySellerStaking {
    mapping(address => uint256) public sellerAgentId;
    mapping(address => bool) public stakedAboveMin;
    mapping(address => uint256) public firstStakedAt;

    function setAgent(address seller, uint256 agentId) external {
        sellerAgentId[seller] = agentId;
    }

    function setStakedAboveMin(address seller, bool value) external {
        stakedAboveMin[seller] = value;
        if (value && firstStakedAt[seller] == 0) firstStakedAt[seller] = block.timestamp;
    }

    function setFirstStakedAt(address seller, uint256 timestamp) external {
        firstStakedAt[seller] = timestamp;
    }

    function sellers(address seller) external view returns (uint256 stake, uint256 stakedAt) {
        return (stakedAboveMin[seller] ? 10_000_000 : 0, firstStakedAt[seller]);
    }

    function getAgentId(address seller) external view returns (uint256) {
        return sellerAgentId[seller];
    }

    function isStakedAboveMin(address seller) external view returns (bool) {
        return stakedAboveMin[seller];
    }
}

contract PositionInitLegacyChannels {
    function activeChannelCount(address) external pure returns (uint256) {
        return 0;
    }

    function getAgentStats(uint256) external pure returns (IAntseedChannels.AgentStats memory stats) {
        return stats;
    }
}

contract AntseedPositionInitTest is Test {
    uint256 constant EPOCH_DURATION = 1 weeks;
    uint256 constant INIT_AMOUNT = 1 ether;
    uint256 constant INIT_END_EPOCH = 105;

    ANTSToken token;
    AntseedRegistry registry;
    MockERC8004Registry identityRegistry;
    MockLegacySellerStaking legacyStaking;
    MockWashTradingStatusForInit washRegistry;
    AntseedSellerPools pools;
    AntseedSellerRegistry sellerRegistry;
    AntseedPositionInit positionInit;

    address seller = address(0x100);
    address otherSeller = address(0x200);
    address outsider = address(0x300);

    uint256 agentId;
    uint256 otherAgentId;
    uint256 genesis;

    function setUp() public {
        vm.warp(1_700_000_000);
        genesis = block.timestamp;
        registry = new AntseedRegistry();
        identityRegistry = new MockERC8004Registry();
        legacyStaking = new MockLegacySellerStaking();
        washRegistry = new MockWashTradingStatusForInit();
        token = new ANTSToken();
        token.setRegistry(address(registry));
        registry.setAntsToken(address(token));
        registry.setEmissions(address(this));
        registry.setIdentityRegistry(address(identityRegistry));

        pools = new AntseedSellerPools(address(token), address(this), address(identityRegistry), address(0));
        sellerRegistry = new AntseedSellerRegistry(address(identityRegistry), address(pools), address(legacyStaking));
        pools.setStakingSource(address(sellerRegistry));

        agentId = _registerLegacySeller(seller);
        otherAgentId = _registerLegacySeller(otherSeller);
        vm.warp(block.timestamp + 1);

        positionInit = new AntseedPositionInit(
            address(pools), address(legacyStaking), address(washRegistry), INIT_AMOUNT, INIT_END_EPOCH
        );

        token.setTransferWhitelist(address(pools), true);
        token.setTransferWhitelist(address(positionInit), true);
        token.mint(address(positionInit), 10 * INIT_AMOUNT);
    }

    function currentEpoch() external view returns (uint256) {
        if (block.timestamp <= genesis) return 0;
        return (block.timestamp - genesis) / EPOCH_DURATION;
    }

    function _registerLegacySeller(address account) internal returns (uint256 id) {
        vm.prank(account);
        id = identityRegistry.register();
        legacyStaking.setAgent(account, id);
        legacyStaking.setStakedAboveMin(account, true);
    }

    function test_initCreatesPositionOwnedBySeller() public {
        assertFalse(token.transfersEnabled());

        vm.prank(seller);
        uint256 positionId = positionInit.initPosition();

        assertEq(pools.ownerOf(positionId), seller);
        (, uint256 positionAgentId, uint256 amount,,, uint64 stakeEndEpoch,,) = pools.positions(positionId);
        assertEq(positionAgentId, agentId);
        assertEq(amount, INIT_AMOUNT);
        assertEq(stakeEndEpoch, INIT_END_EPOCH);
        assertTrue(positionInit.agentInitialized(agentId));
        assertTrue(positionInit.sellerInitialized(seller));
        assertEq(token.balanceOf(address(positionInit)), 9 * INIT_AMOUNT);
        assertEq(positionInit.remainingInits(), 9);
    }

    function test_positionPowerActivatesAtNextEpoch() public {
        vm.prank(seller);
        uint256 positionId = positionInit.initPosition();

        assertEq(pools.poolWeightAtEpoch(agentId, 0), 0);

        vm.warp(block.timestamp + EPOCH_DURATION);
        assertEq(pools.positionWeightAtEpoch(positionId, 1), INIT_AMOUNT * (INIT_END_EPOCH - 1));
        assertEq(pools.poolWeightAtEpoch(agentId, 1), INIT_AMOUNT * (INIT_END_EPOCH - 1));
        assertEq(pools.poolActiveStakeAtEpoch(agentId, 1), INIT_AMOUNT);
    }

    function test_latePositionNeverOutweighsEarlyPosition() public {
        vm.prank(seller);
        uint256 earlyPositionId = positionInit.initPosition();

        // Ten epochs later another seller claims; both positions share the
        // same end epoch, so from the late position's activation onward their
        // power is identical at every epoch.
        vm.warp(block.timestamp + 10 * EPOCH_DURATION);
        vm.prank(otherSeller);
        uint256 latePositionId = positionInit.initPosition();

        (,,,,, uint64 lateEndEpoch,,) = pools.positions(latePositionId);
        assertEq(lateEndEpoch, INIT_END_EPOCH);

        vm.warp(block.timestamp + EPOCH_DURATION);
        uint256 epoch = 11;
        uint256 expectedWeight = INIT_AMOUNT * (INIT_END_EPOCH - epoch);
        assertEq(pools.positionWeightAtEpoch(earlyPositionId, epoch), expectedWeight);
        assertEq(pools.positionWeightAtEpoch(latePositionId, epoch), expectedWeight);
    }

    function test_initsExpireAtEndEpoch() public {
        // Last claimable epoch: activation (currentEpoch + 1) must stay
        // below the shared end epoch.
        vm.warp(genesis + (INIT_END_EPOCH - 2) * EPOCH_DURATION);
        vm.prank(seller);
        uint256 positionId = positionInit.initPosition();
        (,,,, uint64 startEpoch, uint64 stakeEndEpoch,,) = pools.positions(positionId);
        assertEq(startEpoch, INIT_END_EPOCH - 1);
        assertEq(stakeEndEpoch, INIT_END_EPOCH);

        vm.warp(genesis + (INIT_END_EPOCH - 1) * EPOCH_DURATION);
        vm.prank(otherSeller);
        vm.expectRevert(AntseedPositionInit.InitExpired.selector);
        positionInit.initPosition();
    }

    function test_oneInitPerAgent() public {
        vm.prank(seller);
        positionInit.initPosition();

        vm.prank(seller);
        vm.expectRevert(AntseedPositionInit.AlreadyInitialized.selector);
        positionInit.initPosition();
    }

    function test_oneInitPerSellerAcrossAgentIds() public {
        vm.prank(seller);
        positionInit.initPosition();

        uint256 nextAgentId = _registerLegacySeller(seller);
        vm.prank(seller);
        vm.expectRevert(AntseedPositionInit.AlreadyInitialized.selector);
        positionInit.initPosition();

        assertFalse(positionInit.agentInitialized(nextAgentId));
        assertTrue(positionInit.sellerInitialized(seller));
        assertEq(positionInit.remainingInits(), 9);
    }

    function test_sameAgentCannotClaimThroughAnotherExistingSeller() public {
        vm.prank(seller);
        positionInit.initPosition();

        vm.prank(seller);
        identityRegistry.transferAgent(agentId, otherSeller);
        legacyStaking.setAgent(otherSeller, agentId);
        vm.prank(otherSeller);
        vm.expectRevert(AntseedPositionInit.AlreadyInitialized.selector);
        positionInit.initPosition();

        assertFalse(positionInit.sellerInitialized(otherSeller));
        assertEq(positionInit.remainingInits(), 9);
    }

    function test_previousAgentOwnerCannotConsumeEntitlement() public {
        vm.prank(seller);
        identityRegistry.transferAgent(agentId, otherSeller);
        legacyStaking.setAgent(otherSeller, agentId);

        vm.prank(seller);
        vm.expectRevert(AntseedPositionInit.NotLegacySeller.selector);
        positionInit.initPosition();
        assertFalse(positionInit.agentInitialized(agentId));
        assertFalse(positionInit.sellerInitialized(seller));

        vm.prank(otherSeller);
        uint256 positionId = positionInit.initPosition();
        assertEq(pools.ownerOf(positionId), otherSeller);
        assertTrue(positionInit.sellerInitialized(otherSeller));
    }

    function test_cutoffIsFixedAtDeployment() public {
        uint256 deployedAt = vm.getBlockTimestamp();
        assertEq(positionInit.eligibilityCutoff(), deployedAt);
        assertEq(legacyStaking.firstStakedAt(seller), deployedAt - 1);

        vm.warp(deployedAt + EPOCH_DURATION);
        assertEq(positionInit.eligibilityCutoff(), deployedAt);
        vm.prank(seller);
        positionInit.initPosition();
        assertTrue(positionInit.sellerInitialized(seller));
    }

    function testFuzz_firstStakeMustPrecedeDeployment(uint256 firstStakeTimestamp) public {
        uint256 cutoff = positionInit.eligibilityCutoff();
        firstStakeTimestamp = bound(firstStakeTimestamp, 0, cutoff + EPOCH_DURATION);
        legacyStaking.setFirstStakedAt(seller, firstStakeTimestamp);
        vm.warp(cutoff + EPOCH_DURATION);

        vm.prank(seller);
        if (firstStakeTimestamp == 0 || firstStakeTimestamp >= cutoff) {
            vm.expectRevert(AntseedPositionInit.NotLegacySeller.selector);
            positionInit.initPosition();
            assertFalse(positionInit.sellerInitialized(seller));
            assertFalse(positionInit.agentInitialized(agentId));
        } else {
            positionInit.initPosition();
            assertTrue(positionInit.sellerInitialized(seller));
            assertTrue(positionInit.agentInitialized(agentId));
        }
    }

    function test_missingFirstStakeTimestampReverts() public {
        legacyStaking.setFirstStakedAt(seller, 0);
        vm.prank(seller);
        vm.expectRevert(AntseedPositionInit.NotLegacySeller.selector);
        positionInit.initPosition();
    }

    function test_firstStakeAtDeploymentTimestampReverts() public {
        _registerLegacySeller(outsider);
        vm.warp(block.timestamp + 1);
        vm.prank(outsider);
        vm.expectRevert(AntseedPositionInit.NotLegacySeller.selector);
        positionInit.initPosition();
    }

    function test_firstStakeAfterDeploymentReverts() public {
        vm.warp(block.timestamp + 1);
        uint256 nextAgentId = _registerLegacySeller(outsider);
        vm.prank(outsider);
        vm.expectRevert(AntseedPositionInit.NotLegacySeller.selector);
        positionInit.initPosition();
        assertFalse(positionInit.agentInitialized(nextAgentId));
        assertEq(positionInit.remainingInits(), 10);
    }

    function _realLegacyFaucet() internal returns (MockUSDC usdc, AntseedStaking staking, AntseedPositionInit faucet) {
        usdc = new MockUSDC();
        staking = new AntseedStaking(address(usdc), address(registry));
        registry.setChannels(address(new PositionInitLegacyChannels()));
        registry.setStaking(address(sellerRegistry));
        staking.setSlashing(address(new AntseedSlashing(address(registry))));
        sellerRegistry.setLegacyStaking(address(staking));
        uint256 collateral = staking.MIN_SELLER_STAKE();
        usdc.mint(seller, collateral);
        vm.startPrank(seller);
        usdc.approve(address(staking), type(uint256).max);
        staking.stake(agentId, collateral);
        vm.stopPrank();

        vm.warp(block.timestamp + 1);
        faucet = new AntseedPositionInit(
            address(pools), address(staking), address(washRegistry), INIT_AMOUNT, INIT_END_EPOCH
        );
        token.setTransferWhitelist(address(faucet), true);
        token.mint(address(faucet), 10 * INIT_AMOUNT);
    }

    function test_realLegacyStakeCannotBeRecycledIntoAnotherGrant() public {
        (MockUSDC usdc, AntseedStaking staking, AntseedPositionInit faucet) = _realLegacyFaucet();
        uint256 collateral = staking.MIN_SELLER_STAKE();
        (, uint256 firstStakedAt) = staking.sellers(seller);

        vm.startPrank(seller);
        faucet.initPosition();
        staking.unstake();
        assertEq(usdc.balanceOf(seller), collateral);
        uint256 nextAgentId = identityRegistry.register();
        staking.stake(nextAgentId, collateral);
        vm.expectRevert(AntseedPositionInit.AlreadyInitialized.selector);
        faucet.initPosition();
        vm.stopPrank();

        (, uint256 restakedAt) = staking.sellers(seller);
        assertEq(restakedAt, firstStakedAt);
        assertFalse(faucet.agentInitialized(nextAgentId));
        assertEq(faucet.remainingInits(), 9);
    }

    function test_realLegacyStakeCannotBeRecycledThroughNewWallet() public {
        (MockUSDC usdc, AntseedStaking staking, AntseedPositionInit faucet) = _realLegacyFaucet();
        uint256 collateral = staking.MIN_SELLER_STAKE();
        vm.startPrank(seller);
        faucet.initPosition();
        staking.unstake();
        usdc.transfer(outsider, collateral);
        vm.stopPrank();

        vm.warp(block.timestamp + 1);
        vm.startPrank(outsider);
        uint256 nextAgentId = identityRegistry.register();
        usdc.approve(address(staking), collateral);
        staking.stake(nextAgentId, collateral);
        vm.expectRevert(AntseedPositionInit.NotLegacySeller.selector);
        faucet.initPosition();
        vm.stopPrank();

        assertFalse(faucet.agentInitialized(nextAgentId));
        assertEq(faucet.remainingInits(), 9);
    }

    function test_unknownSellerReverts() public {
        vm.prank(outsider);
        vm.expectRevert(AntseedPositionInit.NotLegacySeller.selector);
        positionInit.initPosition();
    }

    function test_sellerBelowLegacyMinStakeReverts() public {
        legacyStaking.setStakedAboveMin(seller, false);

        vm.prank(seller);
        vm.expectRevert(AntseedPositionInit.NotLegacySeller.selector);
        positionInit.initPosition();
    }

    function test_depletedPotBlocksInitsUntilRefunded() public {
        AntseedPositionInit smallInit = new AntseedPositionInit(
            address(pools), address(legacyStaking), address(washRegistry), INIT_AMOUNT, INIT_END_EPOCH
        );
        token.setTransferWhitelist(address(smallInit), true);
        token.mint(address(smallInit), INIT_AMOUNT);

        vm.prank(seller);
        smallInit.initPosition();
        assertEq(smallInit.remainingInits(), 0);

        vm.prank(otherSeller);
        vm.expectRevert(AntseedPositionInit.InitDepleted.selector);
        smallInit.initPosition();
        assertFalse(smallInit.sellerInitialized(otherSeller));
        assertFalse(smallInit.agentInitialized(otherAgentId));

        token.mint(address(smallInit), INIT_AMOUNT);
        vm.prank(otherSeller);
        smallInit.initPosition();
        assertTrue(smallInit.agentInitialized(otherAgentId));
    }

    function test_initRevertsWithoutTransferWhitelist() public {
        AntseedPositionInit unlisted = new AntseedPositionInit(
            address(pools), address(legacyStaking), address(washRegistry), INIT_AMOUNT, INIT_END_EPOCH
        );
        token.mint(address(unlisted), INIT_AMOUNT);

        vm.prank(seller);
        vm.expectRevert(ANTSToken.TransfersNotEnabled.selector);
        unlisted.initPosition();
        assertFalse(unlisted.sellerInitialized(seller));
        assertFalse(unlisted.agentInitialized(agentId));

        token.setTransferWhitelist(address(unlisted), true);
        vm.prank(seller);
        unlisted.initPosition();
        assertTrue(unlisted.sellerInitialized(seller));
        assertTrue(unlisted.agentInitialized(agentId));
    }

    function test_provenWashTraderCannotInit() public {
        washRegistry.set(seller, true);
        vm.prank(seller);
        vm.expectRevert(AntseedPositionInit.WashTrader.selector);
        positionInit.initPosition();
        assertFalse(positionInit.agentInitialized(agentId));
        assertFalse(positionInit.sellerInitialized(seller));
        assertEq(positionInit.remainingInits(), 10);

        // Honest sellers are unaffected.
        vm.prank(otherSeller);
        positionInit.initPosition();
        assertTrue(positionInit.agentInitialized(otherAgentId));
    }

    function test_washTraderClearedLaterCanInit() public {
        washRegistry.set(seller, true);
        vm.prank(seller);
        vm.expectRevert(AntseedPositionInit.WashTrader.selector);
        positionInit.initPosition();

        washRegistry.set(seller, false);
        vm.prank(seller);
        positionInit.initPosition();
        assertTrue(positionInit.agentInitialized(agentId));
    }

    function test_unavailableWashStatusCannotAllocatePosition() public {
        washRegistry.setFailReads(true);
        vm.prank(seller);
        vm.expectRevert(bytes("wash status unavailable"));
        positionInit.initPosition();
        assertFalse(positionInit.sellerInitialized(seller));
        assertFalse(positionInit.agentInitialized(agentId));
        assertEq(positionInit.remainingInits(), 10);
    }

    function test_constructorValidation() public {
        vm.expectRevert(AntseedPositionInit.InvalidAddress.selector);
        new AntseedPositionInit(address(pools), address(legacyStaking), address(0), INIT_AMOUNT, INIT_END_EPOCH);

        vm.expectRevert(AntseedPositionInit.InvalidAddress.selector);
        new AntseedPositionInit(address(0), address(legacyStaking), address(washRegistry), INIT_AMOUNT, INIT_END_EPOCH);

        vm.expectRevert(AntseedPositionInit.InvalidAddress.selector);
        new AntseedPositionInit(address(pools), address(0), address(washRegistry), INIT_AMOUNT, INIT_END_EPOCH);

        vm.expectRevert(AntseedPositionInit.InvalidValue.selector);
        new AntseedPositionInit(address(pools), address(legacyStaking), address(washRegistry), 0, INIT_END_EPOCH);

        // End epoch must be in the future relative to the pools' clock.
        vm.warp(genesis + 5 * EPOCH_DURATION);
        vm.expectRevert(AntseedPositionInit.InvalidValue.selector);
        new AntseedPositionInit(address(pools), address(legacyStaking), address(washRegistry), INIT_AMOUNT, 5);
    }
}
