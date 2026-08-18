// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IRiscZeroVerifier } from "../interfaces/IRiscZeroVerifier.sol";
import { IBlockhashSource } from "../interfaces/IBlockhashSource.sol";
import { IAntseedWashTradingRegistry } from "../interfaces/IAntseedWashTradingRegistry.sol";

/**
 * @title AntseedWashTradingRegistry
 * @notice Records proof-carrying wash-trading findings. A finding is a
 *         zero-knowledge proof that a funding loop exists on this chain:
 *         seller → (forwarding hops) → funder → buyer, followed by
 *         buyer → seller settlement volume, all read from authenticated
 *         Base receipts inside the zkVM guest.
 *
 *         Submission is permissionless: validity comes entirely from the
 *         RISC Zero seal, which only exists for an honest execution of the
 *         guest whose hash is `imageId`. The contract is fully immutable —
 *         no owner, no setters. One registry IS one rule version: a new
 *         predicate ships as a new registry deployment, and consumers switch
 *         by registering the matching AntseedWashTradingPointsPolicy in
 *         AntseedPointsPolicyRegistry. Recorded findings are permanent; nobody,
 *         including the deployer, can accept, remove, or alter one outside the
 *         proof path.
 *
 *         Consumers: AntseedWashTradingPointsPolicy reads `isFlagged` and is
 *         composed by AntseedPointsPolicyRegistry so flagged buyer/seller edges
 *         accrue zero reward points.
 *
 * @dev    Evidence block hashes are checked against `blockhashSource`
 *         (AntseedBlockhashKeeper). Fresh evidence must therefore be
 *         checkpointed or submitted within the native 256-block window.
 *         Historical evidence older than the keeper's records needs a guest
 *         version that walks parent hashes to a recent anchor (predicate v2).
 */
contract AntseedWashTradingRegistry is IAntseedWashTradingRegistry {
    /// @dev Mirrors the guest's journal ABI encoding: abi.encode(LoopJournal).
    struct BlockRef {
        uint64 number;
        bytes32 blockHash;
    }

    struct LoopJournal {
        uint32 predicateVersion;
        uint64 chainId;
        address usdc;
        address channels;
        address deposits;
        address seller;
        address buyer;
        address funder;
        uint32 hopCount;
        uint128 sellerOutflowRaw;
        uint128 fundedRaw;
        uint128 settledAfterFundingRaw;
        uint64 fundingBlock;
        BlockRef[] blockRefs;
    }

    struct Finding {
        uint32 predicateVersion;
        uint32 hopCount;
        address funder;
        uint128 fundedRaw;
        uint128 settledAfterFundingRaw;
        uint64 fundingBlock;
        uint64 recordedAt;
        address submitter;
    }

    IRiscZeroVerifier public immutable verifier;
    IBlockhashSource public immutable blockhashSource;
    bytes32 public immutable imageId;

    /// @notice Proven loop findings keyed buyer → seller.
    mapping(address => mapping(address => Finding)) public findings;

    /// @notice Block of the first proven loop per seller (0 = never flagged).
    ///         A seller flag is permanent and covers ALL of the seller's
    ///         volume and locked-reward claims, not just the proven edge.
    mapping(address => uint64) public sellerFlaggedAt;

    event LoopFindingRecorded(
        address indexed seller,
        address indexed buyer,
        address indexed funder,
        uint32 hopCount,
        uint128 fundedRaw,
        uint128 settledAfterFundingRaw,
        address submitter
    );

    error ZeroAddress();
    error WrongChain(uint64 journalChainId);
    error WrongContracts();
    error NoBlockRefs();
    error BlockNotCanonical(uint64 number, bytes32 claimed);

    address public immutable usdc;
    address public immutable channels;
    address public immutable deposits;

    constructor(
        address verifier_,
        bytes32 imageId_,
        address blockhashSource_,
        address usdc_,
        address channels_,
        address deposits_
    ) {
        if (
            verifier_ == address(0) || blockhashSource_ == address(0) || usdc_ == address(0)
                || channels_ == address(0) || deposits_ == address(0)
        ) revert ZeroAddress();
        verifier = IRiscZeroVerifier(verifier_);
        imageId = imageId_;
        blockhashSource = IBlockhashSource(blockhashSource_);
        usdc = usdc_;
        channels = channels_;
        deposits = deposits_;
    }

    /// @notice Record a proven funding loop. Callable by anyone: the seal is
    ///         the authority, the sender is only credited as submitter.
    /// @param seal        RISC Zero receipt seal for `imageId`.
    /// @param journalData The guest journal, exactly as committed
    ///                    (abi.encode(LoopJournal)).
    function submitLoopFinding(bytes calldata seal, bytes calldata journalData) external {
        LoopJournal memory journal = abi.decode(journalData, (LoopJournal));

        if (journal.chainId != block.chainid) revert WrongChain(journal.chainId);
        if (journal.usdc != usdc || journal.channels != channels || journal.deposits != deposits) {
            revert WrongContracts();
        }
        if (journal.blockRefs.length == 0) revert NoBlockRefs();

        // The proof: this exact journal came out of the pinned guest.
        verifier.verify(seal, imageId, sha256(journalData));

        // The anchor: every block the guest relied on is canonical here.
        IBlockhashSource source = blockhashSource;
        for (uint256 i = 0; i < journal.blockRefs.length; i++) {
            BlockRef memory ref = journal.blockRefs[i];
            if (source.blockHash(ref.number) != ref.blockHash) {
                revert BlockNotCanonical(ref.number, ref.blockHash);
            }
        }

        if (sellerFlaggedAt[journal.seller] == 0) {
            sellerFlaggedAt[journal.seller] = uint64(block.number);
        }
        findings[journal.buyer][journal.seller] = Finding({
            predicateVersion: journal.predicateVersion,
            hopCount: journal.hopCount,
            funder: journal.funder,
            fundedRaw: journal.fundedRaw,
            settledAfterFundingRaw: journal.settledAfterFundingRaw,
            fundingBlock: journal.fundingBlock,
            recordedAt: uint64(block.number),
            submitter: msg.sender
        });

        emit LoopFindingRecorded(
            journal.seller,
            journal.buyer,
            journal.funder,
            journal.hopCount,
            journal.fundedRaw,
            journal.settledAfterFundingRaw,
            msg.sender
        );
    }

    /// @inheritdoc IAntseedWashTradingRegistry
    function isFlagged(address buyer, address seller) external view returns (bool) {
        return findings[buyer][seller].recordedAt != 0;
    }

    /// @inheritdoc IAntseedWashTradingRegistry
    function isSellerFlagged(address seller) external view returns (bool) {
        return sellerFlaggedAt[seller] != 0;
    }
}
