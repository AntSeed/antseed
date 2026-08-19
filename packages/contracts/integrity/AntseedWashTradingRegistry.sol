// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IBaseAnalysisStateOracle } from "../interfaces/IBaseAnalysisStateOracle.sol";
import { IAntseedWashTradingRegistry } from "../interfaces/IAntseedWashTradingRegistry.sol";
import { IRiscZeroVerifier } from "../interfaces/IRiscZeroVerifier.sol";

/**
 * @title AntseedWashTradingRegistry
 * @notice Applies a seller-only future-reward penalty from authenticated,
 *         monotonic positive evidence proven by the pinned RISC Zero guest.
 *
 * The proof need not be complete. Omitting evidence can only prevent a seller
 * from reaching the thresholds; it cannot create an unsupported penalty.
 */
contract AntseedWashTradingRegistry is IAntseedWashTradingRegistry {
    uint32 public constant PREDICATE_VERSION = 2;
    uint64 public constant BASE_CHAIN_ID = 8_453;
    address public constant BASE_USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address public constant ANTSEED_CHANNELS = 0xBA66d3b4fbCf472F6F11D6F9F96aaCE96516F09d;
    address public constant ANTSEED_DEPOSITS = 0x0F7a3a8f4Da01637d1202bb5443fcF7F88F99fD2;
    uint32 public constant MINIMUM_LINKED_BUYERS = 3;
    uint128 public constant MINIMUM_SUSPICIOUS_VOLUME_RAW = 1_000_000_000;
    uint16 public constant PENALTY_BPS = 9_000;

    struct BlockRef {
        uint64 number;
        bytes32 blockHash;
    }

    struct SellerPenaltyJournal {
        uint32 predicateVersion;
        uint64 chainId;
        address usdc;
        address channels;
        address deposits;
        address seller;
        address funder;
        uint32 linkedBuyerCount;
        uint32 hopCount;
        uint16 penaltyBps;
        uint128 sellerOutflowRaw;
        uint128 totalFundedRaw;
        uint128 suspiciousVolumeRaw;
        uint64 earliestFundingBlock;
        uint64 latestSettlementBlock;
        BlockRef[] blockRefs;
    }

    IRiscZeroVerifier public immutable verifier;
    IBaseAnalysisStateOracle public immutable stateOracle;
    bytes32 public immutable sellerPenaltyImageId;

    mapping(address seller => uint16 penaltyBps) public override sellerPenaltyBps;
    mapping(bytes32 journalDigest => bool consumed) public consumedJournalDigests;

    error ZeroAddress();
    error ZeroImageId();
    error InvalidProofJournal();
    error NonCanonicalBlock(uint64 blockNumber, bytes32 blockHash);

    event SellerPenaltyApplied(
        address indexed seller,
        address indexed funder,
        bytes32 indexed journalDigest,
        uint32 linkedBuyerCount,
        uint128 suspiciousVolumeRaw,
        uint16 penaltyBps
    );

    constructor(address verifier_, address stateOracle_, bytes32 sellerPenaltyImageId_) {
        if (verifier_ == address(0) || stateOracle_ == address(0)) revert ZeroAddress();
        if (sellerPenaltyImageId_ == bytes32(0)) revert ZeroImageId();
        verifier = IRiscZeroVerifier(verifier_);
        stateOracle = IBaseAnalysisStateOracle(stateOracle_);
        sellerPenaltyImageId = sellerPenaltyImageId_;
    }

    /**
     * @notice Verifies a seller-penalty receipt and applies the fixed penalty.
     * @return applied True only when this call newly penalizes the seller.
     */
    function submitSellerPenalty(bytes calldata seal, bytes calldata journalData) external returns (bool applied) {
        bytes32 journalDigest = sha256(journalData);
        if (consumedJournalDigests[journalDigest]) return false;

        verifier.verify(seal, sellerPenaltyImageId, journalDigest);
        SellerPenaltyJournal memory journal = abi.decode(journalData, (SellerPenaltyJournal));
        _validateJournal(journal);

        uint64 previousBlock;
        for (uint256 i = 0; i < journal.blockRefs.length; ++i) {
            BlockRef memory blockRef = journal.blockRefs[i];
            if (blockRef.blockHash == bytes32(0) || (i != 0 && blockRef.number <= previousBlock)) {
                revert InvalidProofJournal();
            }
            if (!stateOracle.isCanonicalBlock(blockRef.number, blockRef.blockHash)) {
                revert NonCanonicalBlock(blockRef.number, blockRef.blockHash);
            }
            previousBlock = blockRef.number;
        }

        consumedJournalDigests[journalDigest] = true;
        if (sellerPenaltyBps[journal.seller] == PENALTY_BPS) return false;

        sellerPenaltyBps[journal.seller] = PENALTY_BPS;
        emit SellerPenaltyApplied(
            journal.seller,
            journal.funder,
            journalDigest,
            journal.linkedBuyerCount,
            journal.suspiciousVolumeRaw,
            PENALTY_BPS
        );
        return true;
    }

    /// @inheritdoc IAntseedWashTradingRegistry
    function isSellerPenalized(address seller) external view returns (bool) {
        return sellerPenaltyBps[seller] != 0;
    }

    function _validateJournal(SellerPenaltyJournal memory journal) private pure {
        if (
            journal.predicateVersion != PREDICATE_VERSION || journal.chainId != BASE_CHAIN_ID
                || journal.usdc != BASE_USDC || journal.channels != ANTSEED_CHANNELS || journal.deposits != ANTSEED_DEPOSITS
                || journal.seller == address(0) || journal.funder == address(0)
                || journal.linkedBuyerCount < MINIMUM_LINKED_BUYERS || journal.penaltyBps != PENALTY_BPS
                || journal.suspiciousVolumeRaw < MINIMUM_SUSPICIOUS_VOLUME_RAW || journal.earliestFundingBlock == 0
                || journal.latestSettlementBlock <= journal.earliestFundingBlock || journal.blockRefs.length == 0
        ) revert InvalidProofJournal();
    }
}
