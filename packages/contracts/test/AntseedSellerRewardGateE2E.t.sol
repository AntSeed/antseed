// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";

import { ANTSToken } from "../core/ANTSToken.sol";
import { AntseedRegistry } from "../core/AntseedRegistry.sol";
import { AntseedWashTradingRegistry } from "../integrity/AntseedWashTradingRegistry.sol";
import { IAntseedChannels } from "../interfaces/IAntseedChannels.sol";
import { AntseedEmissions } from "../legacy/AntseedEmissions.sol";
import { AntseedEmissionsV2 } from "../legacy/AntseedEmissionsV2.sol";
import { AntseedWashTradingRewardPolicy } from "../policies/AntseedWashTradingRewardPolicy.sol";
import { AntseedSellerRewardsPool } from "../rewards/AntseedSellerRewardsPool.sol";

contract RewardGateVerifierMock {
    function verifyProof(bytes32, bytes calldata, bytes calldata) external pure { }
}

contract RewardGateBlockhashStoreMock {
    mapping(uint256 blockNumber => bytes32 blockHash) public getBlockhash;

    function setCanonical(uint256 blockNumber, bytes32 blockHash) external {
        getBlockhash[blockNumber] = blockHash;
    }

    function store(uint256) external { }
    function storeVerifyHeader(uint256, bytes calldata) external { }
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
    AntseedWashTradingRewardPolicy internal washTradingRewardPolicy;
    RewardGateBlockhashStoreMock internal blockhashStore;
    RewardGateStakingMock internal staking;
    RewardGateChannelsMock internal channels;

    function setUp() public {
        vm.chainId(8_453);
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

        blockhashStore = new RewardGateBlockhashStoreMock();
        blockhashStore.setCanonical(44_471_575, bytes32(uint256(0x1234)));
        bytes memory initialJournal = _journal(address(0xD00D), 1, 10, bytes32(uint256(1)));
        bytes32 expectedBatchDigest = keccak256(
            abi.encode(
                keccak256("ANTSEED_AIP4_BACKFILL_V1"),
                uint64(8_453),
                bytes32(uint256(1)),
                bytes32(uint256(2)),
                address(blockhashStore),
                uint256(1)
            )
        );
        expectedBatchDigest =
            keccak256(abi.encode(expectedBatchDigest, bytes32(uint256(1)), sha256(initialJournal)));
        washRegistry = new AntseedWashTradingRegistry(
            address(new RewardGateVerifierMock()),
            address(blockhashStore),
            bytes32(uint256(1)),
            bytes32(uint256(2)),
            1,
            expectedBatchDigest
        );
        washTradingRewardPolicy = new AntseedWashTradingRewardPolicy(address(washRegistry));
        emissions.setSellerUnlockPolicy(address(washTradingRewardPolicy));
        rewardsPool.setSellerClaimPolicy(address(washTradingRewardPolicy));
        token.setTransferWhitelist(address(rewardsPool), true);
    }

    function test_historicalClaimsStayLockedUntilBackfillFinalization() public {
        channels.setLastSettledAt(AGENT_ID, uint64(block.timestamp));
        _accrue(SELLER, 100);
        _finalizeEpoch(5);

        vm.prank(SELLER);
        emissions.claimSellerEmissions(_epoch(4));
        assertEq(token.balanceOf(SELLER), 0);
        assertGt(rewardsPool.lockedRewards(SELLER), 0);

        vm.prank(SELLER);
        vm.expectRevert(AntseedSellerRewardsPool.NothingToClaim.selector);
        rewardsPool.claim(SELLER);

        _completeBackfill();
        vm.prank(SELLER);
        rewardsPool.claim(SELLER);
        assertGt(token.balanceOf(SELLER), 0);
        assertEq(rewardsPool.lockedRewards(SELLER), 0);
    }

    function test_unflaggedSellerUsesImmediateRewardRouteAfterBackfill() public {
        _completeBackfill();
        channels.setLastSettledAt(AGENT_ID, uint64(block.timestamp));
        _accrue(SELLER, 100);
        _finalizeEpoch(5);

        vm.prank(SELLER);
        emissions.claimSellerEmissions(_epoch(4));
        assertGt(token.balanceOf(SELLER), 0);
        assertEq(rewardsPool.lockedRewards(SELLER), 0);
    }

    function test_washTradingProofBlocksImmediateAndPoolRoutesPermanently() public {
        _completeBackfill();
        _submitWashTradingProof(SELLER);
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
        assertTrue(washRegistry.isSellerWashTradingFlagged(SELLER));
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

    function _completeBackfill() internal {
        bytes[] memory publicValues = new bytes[](1);
        publicValues[0] = _journal(address(0xD00D), 1, 10, bytes32(uint256(1)));
        bytes[] memory proofs = new bytes[](1);
        washRegistry.submitBatch(publicValues, proofs);
    }

    function _submitWashTradingProof(address seller) internal {
        washRegistry.submit(_journal(seller, 9000e6, 10000e6, keccak256(abi.encode(seller))), hex"");
    }

    function _journal(address seller, uint128 wash, uint128 settled, bytes32 claimId)
        internal
        pure
        returns (bytes memory)
    {
        AntseedWashTradingRegistry.BlockRef[] memory refs = new AntseedWashTradingRegistry.BlockRef[](1);
        refs[0] = AntseedWashTradingRegistry.BlockRef({ number: 44_471_575, blockHash: bytes32(uint256(0x1234)) });
        AntseedWashTradingRegistry.SubjectRecord[] memory subjects =
            new AntseedWashTradingRegistry.SubjectRecord[](1);
        subjects[0] = AntseedWashTradingRegistry.SubjectRecord(seller, wash, settled);
        return abi.encode(AntseedWashTradingRegistry.WashJournal({
            predicateId: 1, chainId: 8_453, periodStartBlock: 44_471_575, periodEndBlock: 49_936_172,
            claimId: claimId, subjects: subjects, blockRefs: refs
        }));
    }
}
