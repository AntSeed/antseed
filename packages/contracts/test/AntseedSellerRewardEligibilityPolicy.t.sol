// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";

import { IAntseedChannels } from "../interfaces/IAntseedChannels.sol";
import { AntseedSellerRewardEligibilityPolicy } from "../policies/AntseedSellerRewardEligibilityPolicy.sol";

contract MockEligibilityRegistry {
    address private _staking;
    address private _channels;
    bool public revertReads;

    function setContracts(address staking_, address channels_) external {
        _staking = staking_;
        _channels = channels_;
    }

    function setRevertReads(bool value) external {
        revertReads = value;
    }

    function staking() external view returns (address) {
        if (revertReads) revert("registry unavailable");
        return _staking;
    }

    function channels() external view returns (address) {
        if (revertReads) revert("registry unavailable");
        return _channels;
    }
}

contract MockEligibilityWashRegistry {
    mapping(address => bool) public p0;
    bool public revertReads;

    function setP0(address seller, bool value) external {
        p0[seller] = value;
    }

    function setRevertReads(bool value) external {
        revertReads = value;
    }

    function isSellerP0(address seller) external view returns (bool) {
        if (revertReads) revert("wash registry unavailable");
        return p0[seller];
    }
}

contract MockEligibilityStaking {
    mapping(address => uint256) public agentIds;
    bool public revertReads;

    function setAgentId(address seller, uint256 agentId) external {
        agentIds[seller] = agentId;
    }

    function setRevertReads(bool value) external {
        revertReads = value;
    }

    function getAgentId(address seller) external view returns (uint256) {
        if (revertReads) revert("staking unavailable");
        return agentIds[seller];
    }
}

contract MockEligibilityChannels {
    mapping(uint256 => IAntseedChannels.AgentStats) public stats;
    bool public revertReads;

    function setLastSettledAt(uint256 agentId, uint64 lastSettledAt) external {
        stats[agentId].lastSettledAt = lastSettledAt;
    }

    function setRevertReads(bool value) external {
        revertReads = value;
    }

    function getAgentStats(uint256 agentId) external view returns (IAntseedChannels.AgentStats memory) {
        if (revertReads) revert("channels unavailable");
        return stats[agentId];
    }
}

contract AntseedSellerRewardEligibilityPolicyTest is Test {
    address internal constant SELLER = address(0xA11CE);
    uint256 internal constant AGENT_ID = 42;
    uint256 internal constant LOCKED = 100 ether;

    MockEligibilityRegistry internal registry;
    MockEligibilityWashRegistry internal washRegistry;
    MockEligibilityStaking internal staking;
    MockEligibilityChannels internal channels;
    AntseedSellerRewardEligibilityPolicy internal policy;

    function setUp() public {
        vm.warp(100 days);
        registry = new MockEligibilityRegistry();
        washRegistry = new MockEligibilityWashRegistry();
        staking = new MockEligibilityStaking();
        channels = new MockEligibilityChannels();
        registry.setContracts(address(staking), address(channels));
        staking.setAgentId(SELLER, AGENT_ID);
        policy = new AntseedSellerRewardEligibilityPolicy(address(registry), address(washRegistry), new address[](0));
    }

    function testActiveSellerUsesSameEligibilityForBothRewardRoutes() public {
        channels.setLastSettledAt(AGENT_ID, uint64(block.timestamp - 14 days));

        assertTrue(policy.canClaimSellerUnlocked(SELLER));
        assertEq(policy.claimableSellerRewards(SELLER, LOCKED), LOCKED);
        (bool eligible, uint8 reasonMask, uint64 lastSettledAt) = policy.eligibility(SELLER);
        assertTrue(eligible);
        assertEq(reasonMask, 0);
        assertEq(lastSettledAt, block.timestamp - 14 days);
    }

    function testInactiveSnapshotRequiresMoreThanFourteenDaysAndIsPermanent() public {
        address[] memory inactiveSellers = new address[](1);
        inactiveSellers[0] = SELLER;
        channels.setLastSettledAt(AGENT_ID, uint64(block.timestamp - 14 days));
        vm.expectRevert(
            abi.encodeWithSelector(AntseedSellerRewardEligibilityPolicy.InvalidInactiveSeller.selector, SELLER)
        );
        new AntseedSellerRewardEligibilityPolicy(address(registry), address(washRegistry), inactiveSellers);

        uint64 submittedLastSettledAt = uint64(block.timestamp - 14 days - 1);
        channels.setLastSettledAt(AGENT_ID, submittedLastSettledAt);
        AntseedSellerRewardEligibilityPolicy snapshotPolicy =
            new AntseedSellerRewardEligibilityPolicy(address(registry), address(washRegistry), inactiveSellers);
        assertEq(snapshotPolicy.inactiveLastSettledAt(SELLER), submittedLastSettledAt);
        assertEq(snapshotPolicy.inactiveSellerCount(), 1);
        assertFalse(snapshotPolicy.canClaimSellerUnlocked(SELLER));
        assertEq(snapshotPolicy.claimableSellerRewards(SELLER, LOCKED), 0);

        channels.setLastSettledAt(AGENT_ID, uint64(block.timestamp));
        assertFalse(snapshotPolicy.canClaimSellerUnlocked(SELLER));
        assertEq(snapshotPolicy.claimableSellerRewards(SELLER, LOCKED), 0);
        (, uint8 reasonMask, uint64 policyLastSettledAt) = snapshotPolicy.eligibility(SELLER);
        assertEq(reasonMask, snapshotPolicy.REASON_INACTIVE());
        assertEq(policyLastSettledAt, submittedLastSettledAt);
    }

    function testP0SellerRemainsBlockedAfterRecentSettlement() public {
        channels.setLastSettledAt(AGENT_ID, uint64(block.timestamp));
        washRegistry.setP0(SELLER, true);

        assertFalse(policy.canClaimSellerUnlocked(SELLER));
        assertEq(policy.claimableSellerRewards(SELLER, LOCKED), 0);
        (, uint8 reasonMask, uint64 lastSettledAt) = policy.eligibility(SELLER);
        assertEq(reasonMask, policy.REASON_P0());
        assertEq(lastSettledAt, 0);
    }

    function testNoAgentAndNeverSettledSellersAreBlocked() public {
        staking.setAgentId(SELLER, 0);
        (, uint8 noAgentReason,) = policy.eligibility(SELLER);
        assertEq(noAgentReason, policy.REASON_NO_AGENT());

        staking.setAgentId(SELLER, AGENT_ID);
        (, uint8 neverSettledReason,) = policy.eligibility(SELLER);
        assertEq(neverSettledReason, policy.REASON_NEVER_SETTLED());
    }

    function testDependencyFailureFailsClosed() public {
        washRegistry.setRevertReads(true);
        vm.expectRevert("wash registry unavailable");
        policy.canClaimSellerUnlocked(SELLER);
        washRegistry.setRevertReads(false);

        registry.setRevertReads(true);
        vm.expectRevert("registry unavailable");
        policy.claimableSellerRewards(SELLER, LOCKED);
        registry.setRevertReads(false);

        staking.setRevertReads(true);
        vm.expectRevert("staking unavailable");
        policy.canClaimSellerUnlocked(SELLER);
        staking.setRevertReads(false);

        channels.setRevertReads(true);
        vm.expectRevert("channels unavailable");
        policy.canClaimSellerUnlocked(SELLER);
        vm.expectRevert("channels unavailable");
        policy.claimableSellerRewards(SELLER, LOCKED);
    }
}
