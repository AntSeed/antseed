// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IAntseedWashTradingRegistry } from "../interfaces/IAntseedWashTradingRegistry.sol";
import { IBlockhashStore } from "../interfaces/IBlockhashStore.sol";
import { ISP1Verifier } from "../interfaces/ISP1Verifier.sol";

contract AntseedWashTradingRegistry is IAntseedWashTradingRegistry {
    uint32 public constant SCHEMA_VERSION = 1;
    uint64 public constant BASE_CHAIN_ID = 8_453;

    struct SellerJournal {
        uint32 schemaVersion;
        uint64 chainId;
        uint64 periodStartBlock;
        uint64 periodEndBlock;
        bytes32 closedLoopProgramVKey;
        bytes32 reciprocalProgramVKey;
        address seller;
        uint128 provenWashVolume;
        bytes32 evidenceDigest;
        uint32 blockReferenceCount;
        uint32 blockAuthenticationChunkSize;
        uint32 blockAuthenticationChunkCount;
        bytes32 blockAuthenticationRoot;
    }

    struct StagedProof {
        address seller;
        uint128 provenWashVolume;
        bytes32 evidenceDigest;
        uint32 blockReferenceCount;
        uint32 blockAuthenticationChunkSize;
        uint32 blockAuthenticationChunkCount;
        bytes32 blockAuthenticationRoot;
        uint32 authenticatedBlockReferenceCount;
        uint32 authenticatedBlockChunkCount;
        bool finalized;
        bool exists;
    }

    struct SellerRecord {
        uint128 provenWashVolume;
        bytes32 evidenceDigest;
    }

    ISP1Verifier public immutable verifier;
    IBlockhashStore public immutable blockhashStore;
    bytes32 public immutable sellerAggregatorProgramVKey;
    bytes32 public immutable closedLoopProgramVKey;
    bytes32 public immutable reciprocalProgramVKey;
    uint64 public immutable periodStartBlock;
    uint64 public immutable periodEndBlock;

    mapping(bytes32 proofId => StagedProof proof) private stagedProofs;
    mapping(bytes32 proofId => mapping(uint32 chunkIndex => bool authenticated)) private authenticatedChunks;
    mapping(address seller => SellerRecord record) private sellerRecords;

    event SellerProofStaged(
        bytes32 indexed proofId,
        address indexed seller,
        uint128 provenWashVolume,
        bytes32 evidenceDigest,
        uint32 blockReferenceCount,
        uint32 blockAuthenticationChunkSize,
        uint32 blockAuthenticationChunkCount,
        bytes32 blockAuthenticationRoot,
        address submitter
    );
    event BlockReferencesAuthenticated(
        bytes32 indexed proofId,
        uint32 indexed chunkIndex,
        uint32 authenticatedChunkCount,
        uint32 authenticatedReferenceCount,
        address submitter
    );
    event SellerResultUpdated(
        bytes32 indexed proofId,
        address indexed seller,
        uint128 previousProvenWashVolume,
        uint128 provenWashVolume,
        bytes32 evidenceDigest,
        address submitter
    );

    error ZeroAddress();
    error InvalidConfiguration();
    error InvalidSellerProof();
    error SellerProofAlreadyStaged(bytes32 proofId);
    error SellerProofNotStaged(bytes32 proofId);
    error SellerProofAlreadyFinalized(bytes32 proofId);
    error EmptyBlockReferenceChunk();
    error TooManyBlockReferences();
    error InvalidBlockAuthenticationChunk();
    error BlockAuthenticationChunkAlreadySubmitted(bytes32 proofId, uint32 chunkIndex);
    error UnorderedBlockReference(uint64 blockNumber);
    error NonCanonicalBlock(uint64 blockNumber);
    error IncompleteBlockAuthentication();
    error StrongerResultRequired();

    constructor(
        address verifier_,
        address blockhashStore_,
        bytes32 sellerAggregatorProgramVKey_,
        bytes32 closedLoopProgramVKey_,
        bytes32 reciprocalProgramVKey_,
        uint64 periodStartBlock_,
        uint64 periodEndBlock_
    ) {
        if (verifier_ == address(0) || blockhashStore_ == address(0)) revert ZeroAddress();
        if (
            sellerAggregatorProgramVKey_ == bytes32(0) || closedLoopProgramVKey_ == bytes32(0)
                || reciprocalProgramVKey_ == bytes32(0) || periodStartBlock_ == 0 || periodStartBlock_ > periodEndBlock_
        ) revert InvalidConfiguration();
        verifier = ISP1Verifier(verifier_);
        blockhashStore = IBlockhashStore(blockhashStore_);
        sellerAggregatorProgramVKey = sellerAggregatorProgramVKey_;
        closedLoopProgramVKey = closedLoopProgramVKey_;
        reciprocalProgramVKey = reciprocalProgramVKey_;
        periodStartBlock = periodStartBlock_;
        periodEndBlock = periodEndBlock_;
    }

    function stageSellerProof(bytes calldata publicValues, bytes calldata proofBytes)
        external
        returns (bytes32 proofId)
    {
        proofId = keccak256(publicValues);
        if (stagedProofs[proofId].exists) revert SellerProofAlreadyStaged(proofId);
        verifier.verifyProof(sellerAggregatorProgramVKey, publicValues, proofBytes);
        SellerJournal memory journal = abi.decode(publicValues, (SellerJournal));
        if (
            journal.schemaVersion != SCHEMA_VERSION || journal.chainId != BASE_CHAIN_ID
                || journal.periodStartBlock != periodStartBlock || journal.periodEndBlock != periodEndBlock
                || journal.closedLoopProgramVKey != closedLoopProgramVKey
                || journal.reciprocalProgramVKey != reciprocalProgramVKey || journal.seller == address(0)
                || journal.provenWashVolume == 0 || journal.evidenceDigest == bytes32(0) || journal.blockReferenceCount == 0
                || journal.blockAuthenticationChunkSize == 0 || journal.blockAuthenticationChunkCount == 0
                || journal.blockAuthenticationRoot == bytes32(0)
        ) revert InvalidSellerProof();
        uint256 maximumReferences =
            uint256(journal.blockAuthenticationChunkSize) * uint256(journal.blockAuthenticationChunkCount);
        uint256 minimumReferences = maximumReferences - journal.blockAuthenticationChunkSize + 1;
        if (journal.blockReferenceCount < minimumReferences || journal.blockReferenceCount > maximumReferences) {
            revert InvalidSellerProof();
        }

        stagedProofs[proofId] = StagedProof({
            seller: journal.seller,
            provenWashVolume: journal.provenWashVolume,
            evidenceDigest: journal.evidenceDigest,
            blockReferenceCount: journal.blockReferenceCount,
            blockAuthenticationChunkSize: journal.blockAuthenticationChunkSize,
            blockAuthenticationChunkCount: journal.blockAuthenticationChunkCount,
            blockAuthenticationRoot: journal.blockAuthenticationRoot,
            authenticatedBlockReferenceCount: 0,
            authenticatedBlockChunkCount: 0,
            finalized: false,
            exists: true
        });
        emit SellerProofStaged(
            proofId,
            journal.seller,
            journal.provenWashVolume,
            journal.evidenceDigest,
            journal.blockReferenceCount,
            journal.blockAuthenticationChunkSize,
            journal.blockAuthenticationChunkCount,
            journal.blockAuthenticationRoot,
            msg.sender
        );
    }

    function authenticateBlockReferences(
        bytes32 proofId,
        uint32 chunkIndex,
        BlockRef[] calldata references,
        bytes32[] calldata proof
    ) external {
        StagedProof storage staged = stagedProofs[proofId];
        if (!staged.exists) revert SellerProofNotStaged(proofId);
        if (staged.finalized) revert SellerProofAlreadyFinalized(proofId);
        if (references.length == 0) revert EmptyBlockReferenceChunk();
        if (
            chunkIndex >= staged.blockAuthenticationChunkCount
                || references.length > staged.blockAuthenticationChunkSize
        ) {
            revert InvalidBlockAuthenticationChunk();
        }
        if (authenticatedChunks[proofId][chunkIndex]) {
            revert BlockAuthenticationChunkAlreadySubmitted(proofId, chunkIndex);
        }
        bool finalChunk = chunkIndex + 1 == staged.blockAuthenticationChunkCount;
        if (
            (!finalChunk && references.length != staged.blockAuthenticationChunkSize)
                || (finalChunk && references.length != _finalChunkSize(staged))
        ) revert InvalidBlockAuthenticationChunk();
        if (uint256(staged.authenticatedBlockReferenceCount) + references.length > staged.blockReferenceCount) {
            revert TooManyBlockReferences();
        }

        uint64 previousNumber;
        for (uint256 index; index < references.length; ++index) {
            BlockRef calldata blockRef = references[index];
            if (index != 0 && blockRef.number <= previousNumber) revert UnorderedBlockReference(blockRef.number);
            if (blockRef.blockHash == bytes32(0) || blockhashStore.getBlockhash(blockRef.number) != blockRef.blockHash)
            {
                revert NonCanonicalBlock(blockRef.number);
            }
            previousNumber = blockRef.number;
        }
        bytes32 computed = keccak256(abi.encode(chunkIndex, references));
        uint256 path = chunkIndex;
        for (uint256 index; index < proof.length; ++index) {
            computed = path & 1 == 0
                ? keccak256(abi.encode(computed, proof[index]))
                : keccak256(abi.encode(proof[index], computed));
            path >>= 1;
        }
        if (computed != staged.blockAuthenticationRoot) revert InvalidBlockAuthenticationChunk();

        authenticatedChunks[proofId][chunkIndex] = true;
        staged.authenticatedBlockReferenceCount += uint32(references.length);
        staged.authenticatedBlockChunkCount += 1;
        emit BlockReferencesAuthenticated(
            proofId,
            chunkIndex,
            staged.authenticatedBlockChunkCount,
            staged.authenticatedBlockReferenceCount,
            msg.sender
        );
    }

    function finalizeSellerProof(bytes32 proofId) external {
        StagedProof storage staged = stagedProofs[proofId];
        if (!staged.exists) revert SellerProofNotStaged(proofId);
        if (staged.finalized) revert SellerProofAlreadyFinalized(proofId);
        if (
            staged.authenticatedBlockReferenceCount != staged.blockReferenceCount
                || staged.authenticatedBlockChunkCount != staged.blockAuthenticationChunkCount
        ) revert IncompleteBlockAuthentication();

        SellerRecord storage current = sellerRecords[staged.seller];
        if (staged.provenWashVolume <= current.provenWashVolume) revert StrongerResultRequired();
        uint128 previousVolume = current.provenWashVolume;
        current.provenWashVolume = staged.provenWashVolume;
        current.evidenceDigest = staged.evidenceDigest;
        staged.finalized = true;
        emit SellerResultUpdated(
            proofId, staged.seller, previousVolume, staged.provenWashVolume, staged.evidenceDigest, msg.sender
        );
    }

    function proofStaged(bytes32 proofId) external view returns (bool) {
        return stagedProofs[proofId].exists;
    }

    function proofFinalized(bytes32 proofId) external view returns (bool) {
        return stagedProofs[proofId].finalized;
    }

    function proofAuthenticatedBlockReferenceCount(bytes32 proofId) external view returns (uint32) {
        return stagedProofs[proofId].authenticatedBlockReferenceCount;
    }

    function proofAuthenticatedBlockChunkCount(bytes32 proofId) external view returns (uint32) {
        return stagedProofs[proofId].authenticatedBlockChunkCount;
    }

    function proofBlockChunkAuthenticated(bytes32 proofId, uint32 chunkIndex) external view returns (bool) {
        return authenticatedChunks[proofId][chunkIndex];
    }

    function provenWashVolume(address seller) external view returns (uint128) {
        return sellerRecords[seller].provenWashVolume;
    }

    function sellerEvidenceDigest(address seller) external view returns (bytes32) {
        return sellerRecords[seller].evidenceDigest;
    }

    function isProvenWashTrader(address seller) external view returns (bool) {
        return sellerRecords[seller].provenWashVolume != 0;
    }

    function _finalChunkSize(StagedProof storage staged) internal view returns (uint32) {
        return staged.blockReferenceCount
            - staged.blockAuthenticationChunkSize * (staged.blockAuthenticationChunkCount - 1);
    }
}
