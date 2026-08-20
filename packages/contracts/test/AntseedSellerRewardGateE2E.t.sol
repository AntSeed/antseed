// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";

import { ANTSToken } from "../core/ANTSToken.sol";
import { AntseedRegistry } from "../core/AntseedRegistry.sol";
import { AntseedWashTradingRegistry } from "../integrity/AntseedWashTradingRegistry.sol";
import { IAntseedChannels } from "../interfaces/IAntseedChannels.sol";
import { AntseedEmissions } from "../legacy/AntseedEmissions.sol";
import { AntseedEmissionsV2 } from "../legacy/AntseedEmissionsV2.sol";
import { AntseedSellerRewardEligibilityPolicy } from "../policies/AntseedSellerRewardEligibilityPolicy.sol";
import { AntseedSellerRewardsPool } from "../rewards/AntseedSellerRewardsPool.sol";

contract RewardGateVerifierMock {
    function verify(bytes calldata, bytes32, bytes32) external pure { }
}

contract RewardGateOracleMock {
    function isCanonicalBlock(uint64, bytes32) external pure returns (bool) {
        return true;
    }
}

contract RewardGateStakingMock {
    mapping(address => uint256) public agentIds;

    function setAgentId(address seller, uint256 agentId) external {
        agentIds[seller] = agentId;
    }

    function getAgentId(address seller) external view returns (uint256) {
        return agentIds[seller];
    }
}

contract RewardGateChannelsMock {
    mapping(uint256 => IAntseedChannels.AgentStats) internal stats;

    function setLastSettledAt(uint256 agentId, uint64 lastSettledAt) external {
        stats[agentId].lastSettledAt = lastSettledAt;
    }

    function getAgentStats(uint256 agentId) external view returns (IAntseedChannels.AgentStats memory) {
        return stats[agentId];
    }
}

contract SellerRewardGateE2ETest is Test {
    uint256 internal constant INITIAL_EMISSION = 1_000 ether;
    uint256 internal constant EPOCH_DURATION = 1 weeks;
    uint256 internal constant AGENT_ID = 42;
    address internal constant SELLER = address(0xA11CE);

    ANTSToken internal token;
    AntseedRegistry internal protocolRegistry;
    AntseedEmissions internal legacy;
    AntseedEmissionsV2 internal emissions;
    AntseedSellerRewardsPool internal rewardsPool;
    AntseedWashTradingRegistry internal washRegistry;
    AntseedSellerRewardEligibilityPolicy internal policy;
    RewardGateStakingMock internal staking;
    RewardGateChannelsMock internal channels;

    function setUp() public {
        vm.warp(1_700_000_000);
        token = new ANTSToken();
        protocolRegistry = new AntseedRegistry();
        protocolRegistry.setChannels(address(this));
        protocolRegistry.setAntsToken(address(token));
        protocolRegistry.setProtocolReserve(address(0xBEEF));
        protocolRegistry.setTeamWallet(address(0xCAFE));

        legacy = new AntseedEmissions(address(protocolRegistry), INITIAL_EMISSION, EPOCH_DURATION);
        protocolRegistry.setEmissions(address(legacy));
        token.setRegistry(address(protocolRegistry));

        vm.warp(legacy.genesis() + EPOCH_DURATION * 4 + 1);
        rewardsPool = new AntseedSellerRewardsPool(address(protocolRegistry));
        emissions = new AntseedEmissionsV2(address(protocolRegistry), address(legacy), address(rewardsPool));
        protocolRegistry.setEmissions(address(emissions));

        staking = new RewardGateStakingMock();
        channels = new RewardGateChannelsMock();
        staking.setAgentId(SELLER, AGENT_ID);
        protocolRegistry.setStaking(address(staking));

        washRegistry = new AntseedWashTradingRegistry(
            address(new RewardGateVerifierMock()),
            address(new RewardGateOracleMock()),
            bytes32(uint256(1)),
            bytes32(uint256(2))
        );
        policy =
            new AntseedSellerRewardEligibilityPolicy(address(protocolRegistry), address(washRegistry), new address[](0));
        emissions.setSellerUnlockPolicy(address(policy));
        rewardsPool.setSellerClaimPolicy(address(policy));
        token.setTransferWhitelist(address(rewardsPool), true);
    }

    function test_activeImmediateRouteAndSubmittedInactiveRouteUseSamePermanentGate() public {
        channels.setLastSettledAt(AGENT_ID, uint64(block.timestamp));
        _accrue(SELLER, 100);
        _finalizeEpoch(5);

        vm.prank(SELLER);
        emissions.claimSellerEmissions(_epoch(4));
        uint256 immediate = token.balanceOf(SELLER);
        assertGt(immediate, 0);
        assertEq(rewardsPool.lockedRewards(SELLER), 0);

        channels.setLastSettledAt(AGENT_ID, uint64(block.timestamp - 14 days - 1));
        address[] memory inactiveSellers = new address[](1);
        inactiveSellers[0] = SELLER;
        policy =
            new AntseedSellerRewardEligibilityPolicy(address(protocolRegistry), address(washRegistry), inactiveSellers);
        emissions.setSellerUnlockPolicy(address(policy));
        rewardsPool.setSellerClaimPolicy(address(policy));
        _accrue(SELLER, 100);
        _finalizeEpoch(6);
        vm.prank(SELLER);
        emissions.claimSellerEmissions(_epoch(5));
        uint256 locked = rewardsPool.lockedRewards(SELLER);
        assertGt(locked, 0);

        channels.setLastSettledAt(AGENT_ID, uint64(block.timestamp));
        vm.prank(SELLER);
        vm.expectRevert(AntseedSellerRewardsPool.NothingToClaim.selector);
        rewardsPool.claim(SELLER);
        assertEq(rewardsPool.lockedRewards(SELLER), locked);
        assertEq(token.balanceOf(SELLER), immediate);
    }

    function test_p0ProofBlocksImmediateAndPoolRoutesPermanently() public {
        _submitP0(SELLER);
        channels.setLastSettledAt(AGENT_ID, uint64(block.timestamp));
        _accrue(SELLER, 100);
        _finalizeEpoch(5);

        vm.prank(SELLER);
        emissions.claimSellerEmissions(_epoch(4));
        assertEq(token.balanceOf(SELLER), 0);
        assertGt(rewardsPool.lockedRewards(SELLER), 0);

        channels.setLastSettledAt(AGENT_ID, uint64(block.timestamp));
        vm.prank(SELLER);
        vm.expectRevert(AntseedSellerRewardsPool.NothingToClaim.selector);
        rewardsPool.claim(SELLER);
        assertTrue(washRegistry.isSellerP0(SELLER));
    }

    function _accrue(address seller, uint256 points) internal {
        protocolRegistry.setChannels(address(this));
        emissions.accrueSellerPoints(seller, points);
        protocolRegistry.setChannels(address(channels));
    }

    function _finalizeEpoch(uint256 epoch) internal {
        vm.warp(legacy.genesis() + EPOCH_DURATION * epoch + 1);
    }

    function _epoch(uint256 epoch) internal pure returns (uint256[] memory epochs) {
        epochs = new uint256[](1);
        epochs[0] = epoch;
    }

    function _submitP0(address seller) internal {
        AntseedWashTradingRegistry.BlockRef[] memory refs = new AntseedWashTradingRegistry.BlockRef[](1);
        refs[0] = AntseedWashTradingRegistry.BlockRef({ number: 44_471_575, blockHash: bytes32(uint256(0x1234)) });
        bytes32 cohortHash = keccak256("seller-p0-cohort");
        AntseedWashTradingRegistry.ClosedCycleJournal memory journal = AntseedWashTradingRegistry.ClosedCycleJournal({
            predicateVersion: 3,
            claimId: keccak256(
                abi.encode(block.chainid, uint8(1), uint64(44_471_575), uint64(49_936_173), seller, seller, cohortHash)
            ),
            periodStartBlock: 44_471_575,
            periodEndBlockExclusive: 49_936_173,
            seller: seller,
            funder: seller,
            cohortHash: cohortHash,
            cohortCount: 3,
            qualifiedVolumeRaw: 1_000_000_000,
            closureKind: 3,
            closurePathCount: 3,
            blockRefs: refs
        });
        washRegistry.submitClosedCycleProof(hex"", abi.encode(journal));
    }
}
