// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IBaseAnalysisStateOracle } from "../interfaces/IBaseAnalysisStateOracle.sol";
import { IAntseedWashTradingRegistry } from "../interfaces/IAntseedWashTradingRegistry.sol";
import { IRiscZeroVerifier } from "../interfaces/IRiscZeroVerifier.sol";

contract AntseedWashTradingRegistry is IAntseedWashTradingRegistry {
    uint32 public constant PREDICATE_VERSION = 1;
    uint16 public constant PENALTY_BPS = 9_000;
    uint8 public constant P0_CLOSED_LOOP = 1;
    uint8 public constant P1_COORDINATED_CONTROL = 2;

    struct BlockRef {
        uint64 number;
        bytes32 blockHash;
    }

    struct CohortJournal {
        uint32 predicateVersion;
        uint8 claimType;
        bytes32 claimId;
        bytes32 reportRoot;
        address seller;
        uint16 penaltyBps;
        uint32 linkedBuyerCount;
        uint128 qualifiedVolumeRaw;
        BlockRef[] blockRefs;
    }

    struct ReciprocalJournal {
        uint32 predicateVersion;
        bytes32 claimId;
        bytes32 reportRoot;
        address sellerA;
        address sellerB;
        uint16 penaltyBps;
        uint32 settlementCount;
        uint128 qualifiedVolumeRaw;
        BlockRef[] blockRefs;
    }

    IRiscZeroVerifier public immutable verifier;
    IBaseAnalysisStateOracle public immutable stateOracle;
    bytes32 public immutable cohortImageId;
    bytes32 public immutable reciprocalImageId;
    bytes32 public immutable approvedReportRoot;

    mapping(address seller => uint16 penaltyBps) public override sellerPenaltyBps;
    mapping(bytes32 claimId => bool consumed) public consumedClaimIds;

    error ZeroAddress();
    error ZeroConfiguration();
    error InvalidProofJournal();
    error NonCanonicalBlock(uint64 blockNumber, bytes32 blockHash);

    event SellerPenaltyApplied(
        address indexed seller,
        bytes32 indexed claimId,
        uint8 indexed claimType,
        uint16 previousPenaltyBps,
        uint16 newPenaltyBps
    );

    constructor(
        address verifier_,
        address stateOracle_,
        bytes32 cohortImageId_,
        bytes32 reciprocalImageId_,
        bytes32 approvedReportRoot_
    ) {
        if (verifier_ == address(0) || stateOracle_ == address(0)) revert ZeroAddress();
        if (cohortImageId_ == bytes32(0) || reciprocalImageId_ == bytes32(0) || approvedReportRoot_ == bytes32(0)) {
            revert ZeroConfiguration();
        }
        verifier = IRiscZeroVerifier(verifier_);
        stateOracle = IBaseAnalysisStateOracle(stateOracle_);
        cohortImageId = cohortImageId_;
        reciprocalImageId = reciprocalImageId_;
        approvedReportRoot = approvedReportRoot_;
    }

    function submitCohortPenalty(bytes calldata seal, bytes calldata journalData) external returns (bool applied) {
        verifier.verify(seal, cohortImageId, sha256(journalData));
        CohortJournal memory journal = abi.decode(journalData, (CohortJournal));
        if (consumedClaimIds[journal.claimId]) return false;
        if (
            journal.predicateVersion != PREDICATE_VERSION
                || (journal.claimType != P0_CLOSED_LOOP && journal.claimType != P1_COORDINATED_CONTROL)
                || journal.claimId == bytes32(0) || journal.reportRoot != approvedReportRoot || journal.seller == address(0)
                || journal.penaltyBps != PENALTY_BPS || journal.linkedBuyerCount < 3
                || journal.qualifiedVolumeRaw < 1_000_000_000
        ) revert InvalidProofJournal();
        _validateBlocks(journal.blockRefs);
        consumedClaimIds[journal.claimId] = true;
        return _applyPenalty(journal.seller, journal.claimId, journal.claimType);
    }

    function submitReciprocalPenalty(bytes calldata seal, bytes calldata journalData)
        external
        returns (bool appliedA, bool appliedB)
    {
        verifier.verify(seal, reciprocalImageId, sha256(journalData));
        ReciprocalJournal memory journal = abi.decode(journalData, (ReciprocalJournal));
        if (consumedClaimIds[journal.claimId]) return (false, false);
        if (
            journal.predicateVersion != PREDICATE_VERSION || journal.claimId == bytes32(0)
                || journal.reportRoot != approvedReportRoot || journal.sellerA == address(0)
                || journal.sellerB == address(0) || journal.sellerA == journal.sellerB || journal.penaltyBps != PENALTY_BPS
                || journal.settlementCount < 100 || journal.qualifiedVolumeRaw == 0
        ) revert InvalidProofJournal();
        _validateBlocks(journal.blockRefs);
        consumedClaimIds[journal.claimId] = true;
        appliedA = _applyPenalty(journal.sellerA, journal.claimId, 3);
        appliedB = _applyPenalty(journal.sellerB, journal.claimId, 3);
    }

    function isSellerPenalized(address seller) external view returns (bool) {
        return sellerPenaltyBps[seller] != 0;
    }

    function _validateBlocks(BlockRef[] memory blockRefs) private view {
        if (blockRefs.length == 0) revert InvalidProofJournal();
        uint64 previousBlock;
        for (uint256 index = 0; index < blockRefs.length; ++index) {
            BlockRef memory blockRef = blockRefs[index];
            if (blockRef.blockHash == bytes32(0) || (index != 0 && blockRef.number <= previousBlock)) {
                revert InvalidProofJournal();
            }
            if (!stateOracle.isCanonicalBlock(blockRef.number, blockRef.blockHash)) {
                revert NonCanonicalBlock(blockRef.number, blockRef.blockHash);
            }
            previousBlock = blockRef.number;
        }
    }

    function _applyPenalty(address seller, bytes32 claimId, uint8 claimType) private returns (bool applied) {
        uint16 previousPenalty = sellerPenaltyBps[seller];
        uint16 newPenalty = previousPenalty > PENALTY_BPS ? previousPenalty : PENALTY_BPS;
        if (newPenalty == previousPenalty) return false;
        sellerPenaltyBps[seller] = newPenalty;
        emit SellerPenaltyApplied(seller, claimId, claimType, previousPenalty, newPenalty);
        return true;
    }
}
