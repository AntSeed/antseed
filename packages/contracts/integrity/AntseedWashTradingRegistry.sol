// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

import { IAntseedEmissions } from "../interfaces/IAntseedEmissions.sol";
import { IAntseedWashTradingRegistry } from "../interfaces/IAntseedWashTradingRegistry.sol";
import { IBlockhashStore } from "../interfaces/IBlockhashStore.sol";
import { ISP1Verifier } from "../interfaces/ISP1Verifier.sol";

contract AntseedWashTradingRegistry is IAntseedWashTradingRegistry, Ownable2Step, Pausable {
    uint32 public constant SCHEMA_VERSION = 1;
    uint64 public constant BASE_CHAIN_ID = 8_453;

    struct BlockRef {
        uint64 number;
        bytes32 blockHash;
    }

    struct Finding {
        bytes32 claimId;
        bytes32 childProgramId;
        bytes32 childProgramVKey;
        uint256 agentId;
        address seller;
        bytes32 sourceId;
        uint64 periodStartBlock;
        uint64 periodEndBlock;
        uint64 offenseEpoch;
        uint128 totalVolume;
        uint128 provenWashVolume;
    }

    struct AggregateJournal {
        uint32 schemaVersion;
        uint64 chainId;
        Finding[] findings;
        BlockRef[] blockRefs;
    }

    struct ChildProgram {
        bytes32 vKey;
        bytes32 sourceId;
        bool active;
        bool exists;
    }

    struct AggregatorProgram {
        bytes32 vKey;
        bool active;
        bool exists;
    }

    ISP1Verifier public immutable verifier;
    IBlockhashStore public immutable blockhashStore;
    IAntseedEmissions public immutable epochClock;

    mapping(bytes32 => ChildProgram) public childPrograms;
    mapping(bytes32 => AggregatorProgram) public aggregatorPrograms;
    mapping(bytes32 => bytes32) public claimDigests;
    mapping(bytes32 => PeriodSummary) private _periodSummaries;
    mapping(uint256 => uint64) public latestOffenseEpoch;
    mapping(uint256 => uint64) public latestOffenseAcceptedEpoch;
    mapping(uint256 => bool) public hasOffense;

    event ChildProgramRegistered(bytes32 indexed programId, bytes32 indexed vKey, bytes32 indexed sourceId);
    event ChildProgramDisabled(bytes32 indexed programId);
    event AggregatorProgramRegistered(bytes32 indexed programId, bytes32 indexed vKey);
    event AggregatorProgramDisabled(bytes32 indexed programId);
    event FindingAccepted(
        bytes32 indexed claimId,
        uint256 indexed agentId,
        bytes32 indexed sourceId,
        bytes32 childProgramId,
        address seller,
        uint64 periodStartBlock,
        uint64 periodEndBlock,
        uint64 offenseEpoch,
        uint128 totalVolume,
        uint128 provenWashVolume,
        address submitter
    );
    event AggregateAccepted(
        bytes32 indexed aggregatorId,
        bytes32 indexed publicValuesDigest,
        uint256 findingCount,
        uint256 blockRefCount,
        address submitter
    );

    error ZeroAddress();
    error InvalidProgram();
    error ProgramAlreadyRegistered(bytes32 programId);
    error UnknownOrInactiveAggregator(bytes32 programId);
    error UnknownOrInactiveChild(bytes32 programId);
    error WrongChildProgramVKey(bytes32 programId);
    error WrongSource(bytes32 programId);
    error InvalidSchema(uint32 schemaVersion);
    error WrongChain(uint64 chainId);
    error EmptyAggregate();
    error InvalidFinding(bytes32 claimId);
    error FindingsNotSorted();
    error BlockRefsNotSorted();
    error BlockNotCanonical(uint64 number, bytes32 claimed, bytes32 canonical);
    error ConflictingClaim(bytes32 claimId);
    error ConflictingPeriodTotal(bytes32 summaryKey, uint128 stored, uint128 submitted);

    constructor(address initialOwner, address verifier_, address blockhashStore_, address epochClock_)
        Ownable(initialOwner)
    {
        if (
            initialOwner == address(0) || verifier_ == address(0) || blockhashStore_ == address(0)
                || epochClock_ == address(0)
        ) revert ZeroAddress();
        verifier = ISP1Verifier(verifier_);
        blockhashStore = IBlockhashStore(blockhashStore_);
        epochClock = IAntseedEmissions(epochClock_);
    }

    function registerChildProgram(bytes32 programId, bytes32 vKey, bytes32 sourceId) external onlyOwner {
        if (programId == bytes32(0) || vKey == bytes32(0) || sourceId == bytes32(0)) revert InvalidProgram();
        if (childPrograms[programId].exists) revert ProgramAlreadyRegistered(programId);
        childPrograms[programId] = ChildProgram(vKey, sourceId, true, true);
        emit ChildProgramRegistered(programId, vKey, sourceId);
    }

    function disableChildProgram(bytes32 programId) external onlyOwner {
        ChildProgram storage program = childPrograms[programId];
        if (!program.exists || !program.active) revert InvalidProgram();
        program.active = false;
        emit ChildProgramDisabled(programId);
    }

    function registerAggregatorProgram(bytes32 programId, bytes32 vKey) external onlyOwner {
        if (programId == bytes32(0) || vKey == bytes32(0)) revert InvalidProgram();
        if (aggregatorPrograms[programId].exists) revert ProgramAlreadyRegistered(programId);
        aggregatorPrograms[programId] = AggregatorProgram(vKey, true, true);
        emit AggregatorProgramRegistered(programId, vKey);
    }

    function disableAggregatorProgram(bytes32 programId) external onlyOwner {
        AggregatorProgram storage program = aggregatorPrograms[programId];
        if (!program.exists || !program.active) revert InvalidProgram();
        program.active = false;
        emit AggregatorProgramDisabled(programId);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function submitAggregate(bytes32 aggregatorId, bytes calldata publicValues, bytes calldata proofBytes)
        external
        whenNotPaused
    {
        AggregatorProgram memory aggregator = aggregatorPrograms[aggregatorId];
        if (!aggregator.exists || !aggregator.active) revert UnknownOrInactiveAggregator(aggregatorId);
        verifier.verifyProof(aggregator.vKey, publicValues, proofBytes);
        AggregateJournal memory journal = abi.decode(publicValues, (AggregateJournal));
        if (journal.schemaVersion != SCHEMA_VERSION) revert InvalidSchema(journal.schemaVersion);
        if (journal.chainId != BASE_CHAIN_ID) revert WrongChain(journal.chainId);
        if (journal.findings.length == 0 || journal.blockRefs.length == 0) revert EmptyAggregate();
        _validateBlockRefs(journal.blockRefs);

        bytes32 publicValuesDigest = keccak256(publicValues);
        uint64 acceptedEpoch = _toUint64(epochClock.currentEpoch());
        bytes32 previousClaimId;
        for (uint256 i; i < journal.findings.length; ++i) {
            Finding memory finding = journal.findings[i];
            if (i != 0 && finding.claimId <= previousClaimId) revert FindingsNotSorted();
            previousClaimId = finding.claimId;
            _acceptFinding(finding, acceptedEpoch);
        }
        emit AggregateAccepted(
            aggregatorId, publicValuesDigest, journal.findings.length, journal.blockRefs.length, msg.sender
        );
    }

    function periodSummary(uint256 agentId, bytes32 sourceId, uint64 periodStartBlock, uint64 periodEndBlock)
        external
        view
        returns (PeriodSummary memory)
    {
        return _periodSummaries[periodSummaryKey(agentId, sourceId, periodStartBlock, periodEndBlock)];
    }

    function periodSummaryKey(uint256 agentId, bytes32 sourceId, uint64 periodStartBlock, uint64 periodEndBlock)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(agentId, sourceId, periodStartBlock, periodEndBlock));
    }

    function _acceptFinding(Finding memory finding, uint64 acceptedEpoch) private {
        ChildProgram memory child = childPrograms[finding.childProgramId];
        if (!child.exists || !child.active) revert UnknownOrInactiveChild(finding.childProgramId);
        if (child.vKey != finding.childProgramVKey) revert WrongChildProgramVKey(finding.childProgramId);
        if (child.sourceId != finding.sourceId) revert WrongSource(finding.childProgramId);
        if (
            finding.claimId == bytes32(0) || finding.agentId == 0 || finding.seller == address(0)
                || finding.periodStartBlock > finding.periodEndBlock || finding.offenseEpoch > acceptedEpoch
                || finding.totalVolume == 0 || finding.provenWashVolume == 0
                || finding.provenWashVolume > finding.totalVolume
        ) revert InvalidFinding(finding.claimId);

        bytes32 findingDigest = keccak256(abi.encode(finding));
        bytes32 existingDigest = claimDigests[finding.claimId];
        if (existingDigest != bytes32(0)) {
            if (existingDigest != findingDigest) revert ConflictingClaim(finding.claimId);
            return;
        }
        claimDigests[finding.claimId] = findingDigest;

        bytes32 summaryKey =
            periodSummaryKey(finding.agentId, finding.sourceId, finding.periodStartBlock, finding.periodEndBlock);
        PeriodSummary storage summary = _periodSummaries[summaryKey];
        if (summary.findingCount == 0) {
            summary.totalVolume = finding.totalVolume;
            summary.firstAcceptedAt = _toUint64(block.timestamp);
        } else if (summary.totalVolume != finding.totalVolume) {
            revert ConflictingPeriodTotal(summaryKey, summary.totalVolume, finding.totalVolume);
        }
        if (finding.provenWashVolume > summary.maxProvenWashVolume) {
            summary.maxProvenWashVolume = finding.provenWashVolume;
        }
        summary.findingCount += 1;

        if (!hasOffense[finding.agentId] || finding.offenseEpoch > latestOffenseEpoch[finding.agentId]) {
            hasOffense[finding.agentId] = true;
            latestOffenseEpoch[finding.agentId] = finding.offenseEpoch;
            latestOffenseAcceptedEpoch[finding.agentId] = acceptedEpoch;
        }
        emit FindingAccepted(
            finding.claimId,
            finding.agentId,
            finding.sourceId,
            finding.childProgramId,
            finding.seller,
            finding.periodStartBlock,
            finding.periodEndBlock,
            finding.offenseEpoch,
            finding.totalVolume,
            finding.provenWashVolume,
            msg.sender
        );
    }

    function _validateBlockRefs(BlockRef[] memory blockRefs) private view {
        uint64 previousNumber;
        for (uint256 i; i < blockRefs.length; ++i) {
            BlockRef memory ref = blockRefs[i];
            if (ref.blockHash == bytes32(0) || (i != 0 && ref.number <= previousNumber)) revert BlockRefsNotSorted();
            previousNumber = ref.number;
            bytes32 canonical = blockhashStore.getBlockhash(ref.number);
            if (canonical == bytes32(0) || canonical != ref.blockHash) {
                revert BlockNotCanonical(ref.number, ref.blockHash, canonical);
            }
        }
    }

    function _toUint64(uint256 value) private pure returns (uint64 result) {
        if (value > type(uint64).max) revert InvalidProgram();
        result = uint64(value);
    }
}
