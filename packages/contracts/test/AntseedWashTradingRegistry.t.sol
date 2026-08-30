// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

import { AntseedWashTradingRegistry } from "../integrity/AntseedWashTradingRegistry.sol";
import { AntseedWashTradingEpochPolicy } from "../policies/AntseedWashTradingEpochPolicy.sol";
import { IAntseedWashTradingRegistry } from "../interfaces/IAntseedWashTradingRegistry.sol";
import { IBlockhashStore } from "../interfaces/IBlockhashStore.sol";
import { ISP1Verifier } from "../interfaces/ISP1Verifier.sol";

contract MockSP1Verifier is ISP1Verifier {
    bytes32 public expectedVKey;
    bytes32 public expectedValuesHash;
    bytes32 public expectedProofHash;

    function expect(bytes32 vKey, bytes memory values, bytes memory proof) external {
        expectedVKey = vKey;
        expectedValuesHash = keccak256(values);
        expectedProofHash = keccak256(proof);
    }

    function verifyProof(bytes32 vKey, bytes calldata values, bytes calldata proof) external view {
        require(
            vKey == expectedVKey && keccak256(values) == expectedValuesHash && keccak256(proof) == expectedProofHash
        );
    }
}

contract MockBlockhashStore is IBlockhashStore {
    mapping(uint256 => bytes32) public hashes;

    function set(uint256 number, bytes32 value) external {
        hashes[number] = value;
    }

    function getBlockhash(uint256 number) external view returns (bytes32) {
        return hashes[number];
    }

    function store(uint256) external { }

    function storeVerifyHeader(uint256, bytes calldata) external { }
}

contract MockEpochClock {
    uint256 public currentEpoch;

    function set(uint256 epoch) external {
        currentEpoch = epoch;
    }
}

contract MockSellerRegistry {
    mapping(address => uint256) public ids;

    function set(address seller, uint256 agentId) external {
        ids[seller] = agentId;
    }

    function getAgentId(address seller) external view returns (uint256) {
        return ids[seller];
    }
}

contract AntseedWashTradingRegistryTest is Test {
    bytes32 internal constant AGGREGATOR_ID = keccak256("aggregator-v1");
    bytes32 internal constant AGGREGATOR_VKEY = bytes32(uint256(11));
    bytes32 internal constant CHILD_ID = keccak256("closed-loop-v3");
    bytes32 internal constant CHILD_VKEY = bytes32(uint256(22));
    bytes32 internal constant SOURCE_ID = keccak256("channels-v1");
    address internal constant SELLER = address(0xA11CE);
    uint256 internal constant AGENT_ID = 42;

    MockSP1Verifier internal verifier;
    MockBlockhashStore internal blockhashStore;
    MockEpochClock internal clock;
    MockSellerRegistry internal sellers;
    AntseedWashTradingRegistry internal registry;
    AntseedWashTradingEpochPolicy internal policy;

    function setUp() public {
        verifier = new MockSP1Verifier();
        blockhashStore = new MockBlockhashStore();
        clock = new MockEpochClock();
        sellers = new MockSellerRegistry();
        clock.set(20);
        sellers.set(SELLER, AGENT_ID);
        registry =
            new AntseedWashTradingRegistry(address(this), address(verifier), address(blockhashStore), address(clock));
        registry.registerAggregatorProgram(AGGREGATOR_ID, AGGREGATOR_VKEY);
        registry.registerChildProgram(CHILD_ID, CHILD_VKEY, SOURCE_ID);
        policy = new AntseedWashTradingEpochPolicy(address(this), address(registry), address(sellers), address(clock));
    }

    function _journal(bytes32 claimId, uint64 offenseEpoch, uint128 total, uint128 wash)
        internal
        pure
        returns (AntseedWashTradingRegistry.AggregateJournal memory journal)
    {
        AntseedWashTradingRegistry.Finding[] memory findings = new AntseedWashTradingRegistry.Finding[](1);
        findings[0] = AntseedWashTradingRegistry.Finding({
            claimId: claimId,
            childProgramId: CHILD_ID,
            childProgramVKey: CHILD_VKEY,
            agentId: AGENT_ID,
            seller: SELLER,
            sourceId: SOURCE_ID,
            periodStartBlock: 100,
            periodEndBlock: 199,
            offenseEpoch: offenseEpoch,
            totalVolume: total,
            provenWashVolume: wash
        });
        AntseedWashTradingRegistry.BlockRef[] memory refs = new AntseedWashTradingRegistry.BlockRef[](2);
        refs[0] = AntseedWashTradingRegistry.BlockRef(100, bytes32(uint256(1000)));
        refs[1] = AntseedWashTradingRegistry.BlockRef(199, bytes32(uint256(1990)));
        journal = AntseedWashTradingRegistry.AggregateJournal(1, 8453, findings, refs);
    }

    function _submit(AntseedWashTradingRegistry.AggregateJournal memory journal) internal {
        bytes memory values = abi.encode(journal);
        bytes memory proof = hex"1234";
        for (uint256 i; i < journal.blockRefs.length; ++i) {
            blockhashStore.set(journal.blockRefs[i].number, journal.blockRefs[i].blockHash);
        }
        verifier.expect(AGGREGATOR_VKEY, values, proof);
        registry.submitAggregate(AGGREGATOR_ID, values, proof);
    }

    function test_recordsNeutralFactsAndSellerOnlyPenalty() public {
        _submit(_journal(keccak256("claim-1"), 15, 1_000, 300));
        assertTrue(registry.hasOffense(AGENT_ID));
        assertEq(registry.latestOffenseEpoch(AGENT_ID), 15);
        assertEq(registry.latestOffenseAcceptedEpoch(AGENT_ID), 20);
        IAntseedWashTradingRegistry.PeriodSummary memory summary = registry.periodSummary(AGENT_ID, SOURCE_ID, 100, 199);
        assertEq(summary.totalVolume, 1_000);
        assertEq(summary.maxProvenWashVolume, 300);
        assertEq(summary.findingCount, 1);
        (uint256 sellerPoints, uint256 buyerPoints) = policy.points(bytes32(0), address(0xB0B), SELLER, 1_000);
        assertEq(sellerPoints, 0);
        assertEq(buyerPoints, 1_000);
    }

    function test_penaltyCoversRemainderPlusEightFullEpochs() public {
        _submit(_journal(keccak256("claim-1"), 15, 1_000, 300));
        clock.set(28);
        (uint256 atEnd,) = policy.points(bytes32(0), address(0), SELLER, 1);
        assertEq(atEnd, 0);
        clock.set(29);
        (uint256 resumed,) = policy.points(bytes32(0), address(0), SELLER, 1);
        assertEq(resumed, 1);
    }

    function test_newerOffenseRenewsButOlderDoesNot() public {
        _submit(_journal(keccak256("claim-1"), 15, 1_000, 300));
        clock.set(23);
        _submit(_journal(keccak256("claim-2"), 14, 1_000, 400));
        assertEq(registry.latestOffenseAcceptedEpoch(AGENT_ID), 20);
        _submit(_journal(keccak256("claim-3"), 16, 1_000, 500));
        assertEq(registry.latestOffenseAcceptedEpoch(AGENT_ID), 23);
    }

    function test_periodWashVolumeUsesMaximumNotSum() public {
        _submit(_journal(keccak256("claim-1"), 15, 1_000, 300));
        _submit(_journal(keccak256("claim-2"), 15, 1_000, 450));
        IAntseedWashTradingRegistry.PeriodSummary memory summary = registry.periodSummary(AGENT_ID, SOURCE_ID, 100, 199);
        assertEq(summary.totalVolume, 1_000);
        assertEq(summary.maxProvenWashVolume, 450);
        assertEq(summary.findingCount, 2);
    }

    function test_sameAggregateIsIdempotent() public {
        AntseedWashTradingRegistry.AggregateJournal memory journal = _journal(keccak256("claim-1"), 15, 1_000, 300);
        _submit(journal);
        _submit(journal);
        IAntseedWashTradingRegistry.PeriodSummary memory summary = registry.periodSummary(AGENT_ID, SOURCE_ID, 100, 199);
        assertEq(summary.findingCount, 1);
    }

    function test_sameFindingIsIdempotentAcrossDifferentAggregates() public {
        AntseedWashTradingRegistry.AggregateJournal memory journal = _journal(keccak256("claim-1"), 15, 1_000, 300);
        _submit(journal);
        AntseedWashTradingRegistry.BlockRef[] memory refs = new AntseedWashTradingRegistry.BlockRef[](3);
        refs[0] = journal.blockRefs[0];
        refs[1] = journal.blockRefs[1];
        refs[2] = AntseedWashTradingRegistry.BlockRef(200, bytes32(uint256(2000)));
        journal.blockRefs = refs;
        _submit(journal);
        IAntseedWashTradingRegistry.PeriodSummary memory summary = registry.periodSummary(AGENT_ID, SOURCE_ID, 100, 199);
        assertEq(summary.findingCount, 1);
    }

    function test_durationChangesAreProspective() public {
        _submit(_journal(keccak256("claim-1"), 15, 1_000, 300));
        policy.setPenaltyEpochs(2);
        assertEq(policy.penaltyEpochsAt(20), 8);
        assertEq(policy.penaltyEpochsAt(21), 2);
        clock.set(21);
        _submit(_journal(keccak256("claim-2"), 16, 1_000, 400));
        clock.set(23);
        (uint256 blocked,) = policy.points(bytes32(0), address(0), SELLER, 1);
        assertEq(blocked, 0);
        clock.set(24);
        (uint256 resumed,) = policy.points(bytes32(0), address(0), SELLER, 1);
        assertEq(resumed, 1);
    }

    function test_rejectsNonCanonicalBlock() public {
        AntseedWashTradingRegistry.AggregateJournal memory journal = _journal(keccak256("claim-1"), 15, 1_000, 300);
        bytes memory values = abi.encode(journal);
        bytes memory proof = hex"1234";
        verifier.expect(AGGREGATOR_VKEY, values, proof);
        vm.expectRevert();
        registry.submitAggregate(AGGREGATOR_ID, values, proof);
    }

    function test_disabledProgramsRejectFutureSubmissions() public {
        registry.disableChildProgram(CHILD_ID);
        AntseedWashTradingRegistry.AggregateJournal memory journal = _journal(keccak256("claim-1"), 15, 1_000, 300);
        bytes memory values = abi.encode(journal);
        bytes memory proof = hex"1234";
        for (uint256 i; i < journal.blockRefs.length; ++i) {
            blockhashStore.set(journal.blockRefs[i].number, journal.blockRefs[i].blockHash);
        }
        verifier.expect(AGGREGATOR_VKEY, values, proof);
        vm.expectRevert(abi.encodeWithSelector(AntseedWashTradingRegistry.UnknownOrInactiveChild.selector, CHILD_ID));
        registry.submitAggregate(AGGREGATOR_ID, values, proof);
    }
}
