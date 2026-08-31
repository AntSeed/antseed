// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IAntseedWashTradingRegistry } from "../interfaces/IAntseedWashTradingRegistry.sol";
import { ISP1Verifier } from "../interfaces/ISP1Verifier.sol";

contract AntseedWashTradingRegistry is IAntseedWashTradingRegistry {
    uint32 public constant SCHEMA_VERSION = 1;
    uint64 public constant BASE_CHAIN_ID = 8_453;

    struct SellerResult {
        address seller;
        uint128 provenWashVolume;
    }

    struct AggregateJournal {
        uint32 schemaVersion;
        uint64 chainId;
        bytes32 reportRoot;
        bytes32 manifestDigest;
        uint64 periodStartBlock;
        uint64 periodEndBlock;
        uint32 sourceClaimCount;
        SellerResult[] sellers;
        uint128 totalProvenWashVolume;
        uint32 blockReferenceCount;
    }

    ISP1Verifier public immutable verifier;
    bytes32 public immutable aggregatorProgramVKey;
    bytes32 public immutable reportRoot;
    bytes32 public immutable manifestDigest;
    uint64 public immutable periodStartBlock;
    uint64 public immutable periodEndBlock;
    uint32 public immutable expectedSourceClaimCount;
    uint32 public immutable expectedSellerCount;
    uint128 public immutable expectedTotalProvenWashVolume;

    bool public historicalResultSubmitted;
    uint128 public totalProvenWashVolume;
    uint32 public blockReferenceCount;
    mapping(address seller => uint128 volume) public provenWashVolume;

    event HistoricalResultAccepted(
        bytes32 indexed publicValuesDigest,
        bytes32 indexed reportRoot,
        bytes32 indexed manifestDigest,
        uint32 sourceClaimCount,
        uint32 sellerCount,
        uint128 totalProvenWashVolume,
        uint32 blockReferenceCount,
        address submitter
    );

    error ZeroAddress();
    error InvalidConfiguration();
    error HistoricalResultAlreadySubmitted();
    error HistoricalIdentityMismatch();
    error InvalidSellerResults();

    constructor(
        address verifier_,
        bytes32 aggregatorProgramVKey_,
        bytes32 reportRoot_,
        bytes32 manifestDigest_,
        uint64 periodStartBlock_,
        uint64 periodEndBlock_,
        uint32 expectedSourceClaimCount_,
        uint32 expectedSellerCount_,
        uint128 expectedTotalProvenWashVolume_
    ) {
        if (verifier_ == address(0)) revert ZeroAddress();
        if (
            aggregatorProgramVKey_ == bytes32(0) || reportRoot_ == bytes32(0) || manifestDigest_ == bytes32(0)
                || periodStartBlock_ == 0 || periodStartBlock_ > periodEndBlock_ || expectedSourceClaimCount_ == 0
                || expectedSellerCount_ == 0 || expectedTotalProvenWashVolume_ == 0
        ) revert InvalidConfiguration();
        verifier = ISP1Verifier(verifier_);
        aggregatorProgramVKey = aggregatorProgramVKey_;
        reportRoot = reportRoot_;
        manifestDigest = manifestDigest_;
        periodStartBlock = periodStartBlock_;
        periodEndBlock = periodEndBlock_;
        expectedSourceClaimCount = expectedSourceClaimCount_;
        expectedSellerCount = expectedSellerCount_;
        expectedTotalProvenWashVolume = expectedTotalProvenWashVolume_;
    }

    function submitHistoricalAggregate(bytes calldata publicValues, bytes calldata proofBytes) external {
        if (historicalResultSubmitted) revert HistoricalResultAlreadySubmitted();
        verifier.verifyProof(aggregatorProgramVKey, publicValues, proofBytes);
        AggregateJournal memory journal = abi.decode(publicValues, (AggregateJournal));
        if (
            journal.schemaVersion != SCHEMA_VERSION || journal.chainId != BASE_CHAIN_ID
                || journal.reportRoot != reportRoot || journal.manifestDigest != manifestDigest
                || journal.periodStartBlock != periodStartBlock || journal.periodEndBlock != periodEndBlock
                || journal.sourceClaimCount != expectedSourceClaimCount || journal.sellers.length != expectedSellerCount
                || journal.totalProvenWashVolume != expectedTotalProvenWashVolume || journal.blockReferenceCount == 0
        ) revert HistoricalIdentityMismatch();

        uint128 calculatedTotal;
        address previousSeller;
        for (uint256 i; i < journal.sellers.length; ++i) {
            SellerResult memory result = journal.sellers[i];
            if (
                result.seller == address(0) || result.provenWashVolume == 0
                    || (i != 0 && result.seller <= previousSeller)
            ) {
                revert InvalidSellerResults();
            }
            previousSeller = result.seller;
            calculatedTotal += result.provenWashVolume;
            provenWashVolume[result.seller] = result.provenWashVolume;
        }
        if (calculatedTotal != journal.totalProvenWashVolume) revert InvalidSellerResults();

        totalProvenWashVolume = journal.totalProvenWashVolume;
        blockReferenceCount = journal.blockReferenceCount;
        historicalResultSubmitted = true;
        emit HistoricalResultAccepted(
            keccak256(publicValues),
            journal.reportRoot,
            journal.manifestDigest,
            journal.sourceClaimCount,
            uint32(journal.sellers.length),
            journal.totalProvenWashVolume,
            journal.blockReferenceCount,
            msg.sender
        );
    }

    function isProvenWashTrader(address seller) external view returns (bool) {
        return provenWashVolume[seller] != 0;
    }
}
