// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IBaseAnalysisStateOracle } from "../interfaces/IBaseAnalysisStateOracle.sol";
import { IAntseedWashTradingRegistry } from "../interfaces/IAntseedWashTradingRegistry.sol";
import { IRiscZeroVerifier } from "../interfaces/IRiscZeroVerifier.sol";

contract AntseedWashTradingRegistry is IAntseedWashTradingRegistry {
    uint32 public constant PREDICATE_VERSION = 3;
    uint64 public constant PERIOD_START_BLOCK = 44_471_575;
    uint64 public constant PERIOD_END_BLOCK_EXCLUSIVE = 49_936_173;
    uint128 public constant MINIMUM_VOLUME_RAW = 1_000_000_000;
    uint128 public constant MINIMUM_RECIPROCAL_DIRECTION_VOLUME_RAW = 10_000_000;
    uint16 public constant MINIMUM_RECIPROCAL_VOLUME_BPS = 8_000;
    uint32 public constant MAX_BUYERS = 160;
    uint32 public constant MAX_BLOCK_REFS = 2_048;
    uint8 public constant CLOSED_CYCLE_PROOF_TYPE = 1;
    uint8 public constant RECIPROCAL_PROOF_TYPE = 2;
    uint8 public constant P0_PROOF_TYPE_MASK = 0x03;
    uint8 public constant DIRECT_CLOSURE = 1;
    uint8 public constant RELAY_CLOSURE = 2;
    uint8 public constant SELF_FUNDED_CLOSURE = 3;

    struct BlockRef {
        uint64 number;
        bytes32 blockHash;
    }

    struct ClosedCycleJournal {
        uint32 predicateVersion;
        bytes32 claimId;
        uint64 periodStartBlock;
        uint64 periodEndBlockExclusive;
        address seller;
        address funder;
        bytes32 cohortHash;
        uint32 cohortCount;
        uint128 qualifiedVolumeRaw;
        uint8 closureKind;
        uint32 closurePathCount;
        BlockRef[] blockRefs;
    }

    struct ReciprocalJournal {
        uint32 predicateVersion;
        bytes32 claimId;
        uint64 periodStartBlock;
        uint64 periodEndBlockExclusive;
        address addressA;
        address addressB;
        uint32 settlementCountAToB;
        uint32 settlementCountBToA;
        uint128 volumeAToBRaw;
        uint128 volumeBToARaw;
        BlockRef[] blockRefs;
    }

    IRiscZeroVerifier public immutable verifier;
    IBaseAnalysisStateOracle public immutable stateOracle;
    bytes32 public immutable closedCycleImageId;
    bytes32 public immutable reciprocalImageId;

    mapping(address seller => uint8 proofTypeMask) public override sellerProofTypeMask;
    mapping(bytes32 claimId => bool consumed) public consumedClaimIds;

    error ZeroAddress();
    error ZeroConfiguration();
    error InvalidProofJournal();
    error NonCanonicalBlock(uint64 blockNumber, bytes32 blockHash);

    event SellerP0Recorded(address indexed seller, bytes32 indexed claimId, uint8 indexed proofType);

    constructor(address verifier_, address stateOracle_, bytes32 closedCycleImageId_, bytes32 reciprocalImageId_) {
        if (verifier_ == address(0) || stateOracle_ == address(0)) revert ZeroAddress();
        if (closedCycleImageId_ == bytes32(0) || reciprocalImageId_ == bytes32(0)) revert ZeroConfiguration();
        verifier = IRiscZeroVerifier(verifier_);
        stateOracle = IBaseAnalysisStateOracle(stateOracle_);
        closedCycleImageId = closedCycleImageId_;
        reciprocalImageId = reciprocalImageId_;
    }

    function submitClosedCycleProof(bytes calldata seal, bytes calldata journalData)
        external
        returns (bool recorded)
    {
        verifier.verify(seal, closedCycleImageId, sha256(journalData));
        ClosedCycleJournal memory journal = abi.decode(journalData, (ClosedCycleJournal));
        _validateClosedCycle(journal);
        if (consumedClaimIds[journal.claimId]) return false;
        consumedClaimIds[journal.claimId] = true;
        return _recordSellerP0(journal.seller, journal.claimId, CLOSED_CYCLE_PROOF_TYPE);
    }

    function submitReciprocalProof(bytes calldata seal, bytes calldata journalData)
        external
        returns (bool recordedA, bool recordedB)
    {
        verifier.verify(seal, reciprocalImageId, sha256(journalData));
        ReciprocalJournal memory journal = abi.decode(journalData, (ReciprocalJournal));
        _validateReciprocal(journal);
        if (consumedClaimIds[journal.claimId]) return (false, false);
        consumedClaimIds[journal.claimId] = true;
        recordedA = _recordSellerP0(journal.addressA, journal.claimId, RECIPROCAL_PROOF_TYPE);
        recordedB = _recordSellerP0(journal.addressB, journal.claimId, RECIPROCAL_PROOF_TYPE);
    }

    function isSellerP0(address seller) external view override returns (bool) {
        return sellerProofTypeMask[seller] & P0_PROOF_TYPE_MASK != 0;
    }

    function _validateClosedCycle(ClosedCycleJournal memory journal) private view {
        bytes32 expectedClaimId = keccak256(
            abi.encode(
                block.chainid,
                CLOSED_CYCLE_PROOF_TYPE,
                journal.periodStartBlock,
                journal.periodEndBlockExclusive,
                journal.seller,
                journal.funder,
                journal.cohortHash
            )
        );
        if (
            !_validSharedCohort(
                journal.predicateVersion,
                journal.periodStartBlock,
                journal.periodEndBlockExclusive,
                journal.seller,
                journal.funder,
                journal.cohortHash,
                journal.cohortCount
            ) || journal.claimId != expectedClaimId || journal.qualifiedVolumeRaw < MINIMUM_VOLUME_RAW
                || (
                    journal.closureKind == DIRECT_CLOSURE
                        && (journal.seller == journal.funder || journal.closurePathCount != 1)
                )
                || (
                    journal.closureKind == RELAY_CLOSURE
                        && (journal.seller == journal.funder || journal.closurePathCount < 3)
                )
                || (
                    journal.closureKind == SELF_FUNDED_CLOSURE
                        && (journal.seller != journal.funder || journal.closurePathCount < 3)
                )
                || (
                    journal.closureKind != DIRECT_CLOSURE && journal.closureKind != RELAY_CLOSURE
                        && journal.closureKind != SELF_FUNDED_CLOSURE
                )
        ) revert InvalidProofJournal();
        _validateBlocks(journal.blockRefs);
    }

    function _validateReciprocal(ReciprocalJournal memory journal) private view {
        bytes32 expectedClaimId = keccak256(
            abi.encode(
                block.chainid,
                RECIPROCAL_PROOF_TYPE,
                journal.periodStartBlock,
                journal.periodEndBlockExclusive,
                journal.addressA,
                journal.addressB
            )
        );
        if (
            journal.predicateVersion != PREDICATE_VERSION || journal.claimId != expectedClaimId
                || journal.periodStartBlock != PERIOD_START_BLOCK
                || journal.periodEndBlockExclusive != PERIOD_END_BLOCK_EXCLUSIVE || journal.addressA == address(0)
                || journal.addressA >= journal.addressB
                || uint256(journal.settlementCountAToB) + journal.settlementCountBToA < 100
                || journal.settlementCountAToB < 10 || journal.settlementCountBToA < 10
                || journal.volumeAToBRaw < MINIMUM_RECIPROCAL_DIRECTION_VOLUME_RAW
                || journal.volumeBToARaw < MINIMUM_RECIPROCAL_DIRECTION_VOLUME_RAW
                || uint256(_min(journal.volumeAToBRaw, journal.volumeBToARaw)) * 10_000
                    < uint256(_max(journal.volumeAToBRaw, journal.volumeBToARaw)) * MINIMUM_RECIPROCAL_VOLUME_BPS
        ) revert InvalidProofJournal();
        _validateBlocks(journal.blockRefs);
    }

    function _validSharedCohort(
        uint32 predicateVersion,
        uint64 periodStartBlock,
        uint64 periodEndBlockExclusive,
        address seller,
        address funder,
        bytes32 cohortHash,
        uint32 cohortCount
    ) private pure returns (bool) {
        return predicateVersion == PREDICATE_VERSION && periodStartBlock == PERIOD_START_BLOCK
            && periodEndBlockExclusive == PERIOD_END_BLOCK_EXCLUSIVE && seller != address(0) && funder != address(0)
            && cohortHash != bytes32(0) && cohortCount >= 3 && cohortCount <= MAX_BUYERS;
    }

    function _validateBlocks(BlockRef[] memory blockRefs) private view {
        if (blockRefs.length == 0 || blockRefs.length > MAX_BLOCK_REFS) revert InvalidProofJournal();
        uint64 previous;
        for (uint256 index = 0; index < blockRefs.length; ++index) {
            BlockRef memory ref = blockRefs[index];
            if (ref.blockHash == bytes32(0) || (index != 0 && ref.number <= previous)) {
                revert InvalidProofJournal();
            }
            if (!stateOracle.isCanonicalBlock(ref.number, ref.blockHash)) {
                revert NonCanonicalBlock(ref.number, ref.blockHash);
            }
            previous = ref.number;
        }
    }

    function _recordSellerP0(address seller, bytes32 claimId, uint8 proofType) private returns (bool) {
        uint8 proofBit = uint8(1 << (proofType - 1));
        uint8 previous = sellerProofTypeMask[seller];
        if (previous & proofBit != 0) return false;
        sellerProofTypeMask[seller] = previous | proofBit;
        emit SellerP0Recorded(seller, claimId, proofType);
        return true;
    }

    function _min(uint128 left, uint128 right) private pure returns (uint128) {
        return left < right ? left : right;
    }

    function _max(uint128 left, uint128 right) private pure returns (uint128) {
        return left > right ? left : right;
    }
}
