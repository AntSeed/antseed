// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IBlockhashStore } from "../interfaces/IBlockhashStore.sol";
import { IAntseedWashTradingRegistry } from "../interfaces/IAntseedWashTradingRegistry.sol";
import { ISP1Verifier } from "../interfaces/ISP1Verifier.sol";

contract AntseedWashTradingRegistry is IAntseedWashTradingRegistry {
    uint64 public constant BASE_CHAIN_ID = 8_453;
    uint64 public constant PERIOD_START_BLOCK = 44_471_575;
    uint64 public constant PERIOD_END_BLOCK = 49_936_172;
    uint32 public constant MAX_BACKFILL_CLAIMS = 256;
    bytes32 public constant BATCH_DOMAIN = keccak256("ANTSEED_AIP4_BACKFILL_V1");

    struct BlockRef {
        uint64 number;
        bytes32 blockHash;
    }

    struct SubjectRecord {
        address subject;
        uint128 washVolume;
        uint128 settledVolume;
    }

    struct WashJournal {
        uint8 predicateId;
        uint64 chainId;
        uint64 periodStartBlock;
        uint64 periodEndBlock;
        bytes32 claimId;
        SubjectRecord[] subjects;
        BlockRef[] blockRefs;
    }

    struct WashRecord {
        uint128 washVolume;
        uint128 settledVolume;
    }

    ISP1Verifier public immutable verifier;
    IBlockhashStore public immutable blockhashStore;
    bytes32 public immutable closedLoopVKey;
    bytes32 public immutable reciprocalVKey;
    uint32 public immutable expectedBatchCount;
    bytes32 public immutable expectedBatchDigest;

    bool public override backfillComplete;
    mapping(address => WashRecord) public washRecords;
    mapping(bytes32 => bool) public claimed;
    mapping(bytes32 => bytes32) public override claimJournalDigest;

    error WrongChain();
    error WrongPeriod();
    error BackfillIncomplete();
    error BackfillAlreadyComplete();
    error InvalidAddress();
    error InvalidBatch();
    error InvalidBatchDigest(bytes32 expected, bytes32 actual);
    error InvalidClaim();
    error InvalidPredicate(uint8 predicateId);
    error InvalidVKey();
    error ClaimDigestMismatch(bytes32 claimId, bytes32 expected, bytes32 actual);
    error NonCanonicalBlock(uint64 blockNumber);

    event WashProven(
        address indexed subject,
        uint128 washVolume,
        uint128 settledVolume,
        bytes32 indexed claimId,
        uint8 predicateId,
        address indexed submitter
    );
    event BackfillCompleted(bytes32 indexed batchDigest, uint32 claimCount, address indexed submitter);

    constructor(
        address verifier_,
        address blockhashStore_,
        bytes32 closedLoopVKey_,
        bytes32 reciprocalVKey_,
        uint32 expectedBatchCount_,
        bytes32 expectedBatchDigest_
    ) {
        if (
            verifier_ == address(0) || verifier_.code.length == 0 || blockhashStore_ == address(0)
                || blockhashStore_.code.length == 0
        ) revert InvalidAddress();
        if (closedLoopVKey_ == bytes32(0) || reciprocalVKey_ == bytes32(0)) revert InvalidVKey();
        if (
            expectedBatchCount_ == 0 || expectedBatchCount_ > MAX_BACKFILL_CLAIMS
                || expectedBatchDigest_ == bytes32(0)
        ) revert InvalidBatch();

        verifier = ISP1Verifier(verifier_);
        blockhashStore = IBlockhashStore(blockhashStore_);
        closedLoopVKey = closedLoopVKey_;
        reciprocalVKey = reciprocalVKey_;
        expectedBatchCount = expectedBatchCount_;
        expectedBatchDigest = expectedBatchDigest_;
    }

    function submitBatch(bytes[] calldata publicValues, bytes[] calldata proofBytes) external override {
        if (backfillComplete) revert BackfillAlreadyComplete();
        uint256 count = publicValues.length;
        if (count != expectedBatchCount || proofBytes.length != count) revert InvalidBatch();

        bytes32 digest = _batchSeed(count);
        bytes32 previousClaimId;
        for (uint256 index = 0; index < count; ++index) {
            WashJournal memory journal = abi.decode(publicValues[index], (WashJournal));
            if (journal.claimId <= previousClaimId) revert InvalidBatch();
            previousClaimId = journal.claimId;
            digest = keccak256(abi.encode(digest, journal.claimId, sha256(publicValues[index])));
        }
        if (digest != expectedBatchDigest) revert InvalidBatchDigest(expectedBatchDigest, digest);

        for (uint256 index = 0; index < count; ++index) {
            _submit(publicValues[index], proofBytes[index]);
        }

        backfillComplete = true;
        emit BackfillCompleted(digest, uint32(count), msg.sender);
    }

    function submit(bytes calldata publicValues, bytes calldata proofBytes) external override {
        if (!backfillComplete) revert BackfillIncomplete();
        _submit(publicValues, proofBytes);
    }

    function isSellerWashTradingFlagged(address seller) external view override returns (bool) {
        return washRecords[seller].washVolume > 0;
    }

    function washRatioBps(address seller) public view override returns (uint16) {
        WashRecord storage record = washRecords[seller];
        if (record.washVolume == 0) return 0;
        if (record.settledVolume == 0 || record.washVolume >= record.settledVolume) return 10_000;
        return uint16((uint256(record.washVolume) * 10_000) / uint256(record.settledVolume));
    }

    function _submit(bytes calldata publicValues, bytes calldata proofBytes) private {
        WashJournal memory journal = abi.decode(publicValues, (WashJournal));
        _validateJournal(journal);

        bytes32 journalDigest = sha256(publicValues);
        bytes32 existingDigest = claimJournalDigest[journal.claimId];
        if (existingDigest != bytes32(0)) {
            if (existingDigest != journalDigest) {
                revert ClaimDigestMismatch(journal.claimId, existingDigest, journalDigest);
            }
            return;
        }

        verifier.verifyProof(_vkey(journal.predicateId), publicValues, proofBytes);
        for (uint256 index = 0; index < journal.blockRefs.length; ++index) {
            BlockRef memory ref = journal.blockRefs[index];
            if (ref.blockHash == bytes32(0) || blockhashStore.getBlockhash(ref.number) != ref.blockHash) {
                revert NonCanonicalBlock(ref.number);
            }
        }

        claimed[journal.claimId] = true;
        claimJournalDigest[journal.claimId] = journalDigest;
        for (uint256 index = 0; index < journal.subjects.length; ++index) {
            SubjectRecord memory subject = journal.subjects[index];
            _retainGreaterRatio(subject);
            emit WashProven(
                subject.subject,
                subject.washVolume,
                subject.settledVolume,
                journal.claimId,
                journal.predicateId,
                msg.sender
            );
        }
    }

    function _validateJournal(WashJournal memory journal) private pure {
        if (journal.chainId != BASE_CHAIN_ID) revert WrongChain();
        if (journal.periodStartBlock != PERIOD_START_BLOCK || journal.periodEndBlock != PERIOD_END_BLOCK) {
            revert WrongPeriod();
        }
        if (
            journal.claimId == bytes32(0) || journal.subjects.length == 0 || journal.blockRefs.length == 0
                || journal.subjects.length > 2
        ) revert InvalidClaim();
        for (uint256 index = 0; index < journal.subjects.length; ++index) {
            SubjectRecord memory subject = journal.subjects[index];
            if (subject.subject == address(0) || subject.washVolume == 0) revert InvalidClaim();
        }
    }

    function _retainGreaterRatio(SubjectRecord memory candidate) private {
        WashRecord storage current = washRecords[candidate.subject];
        if (!_isGreaterRatio(candidate.washVolume, candidate.settledVolume, current)) return;
        current.washVolume = candidate.washVolume;
        current.settledVolume = candidate.settledVolume;
    }

    function _isGreaterRatio(uint128 washVolume, uint128 settledVolume, WashRecord storage current)
        private
        view
        returns (bool)
    {
        if (current.washVolume == 0) return true;
        if (current.settledVolume == 0 || current.washVolume >= current.settledVolume) return false;
        if (settledVolume == 0 || washVolume >= settledVolume) return true;
        return uint256(washVolume) * uint256(current.settledVolume)
            > uint256(current.washVolume) * uint256(settledVolume);
    }

    function _vkey(uint8 predicateId) private view returns (bytes32) {
        if (predicateId == 1) return closedLoopVKey;
        if (predicateId == 2) return reciprocalVKey;
        revert InvalidPredicate(predicateId);
    }

    function _batchSeed(uint256 count) private view returns (bytes32) {
        return keccak256(
            abi.encode(
                BATCH_DOMAIN,
                BASE_CHAIN_ID,
                closedLoopVKey,
                reciprocalVKey,
                address(blockhashStore),
                count
            )
        );
    }
}
