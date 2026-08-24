// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IBaseAnalysisStateOracle } from "../interfaces/IBaseAnalysisStateOracle.sol";
import { IAntseedWashTradingRegistry } from "../interfaces/IAntseedWashTradingRegistry.sol";
import { ISP1Verifier } from "../interfaces/ISP1Verifier.sol";

contract AntseedWashTradingRegistry is IAntseedWashTradingRegistry {
    uint64 private constant BASE_CHAIN_ID = 8_453;

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
    IBaseAnalysisStateOracle public immutable stateOracle;
    bytes32 public immutable closedLoopVKey;
    bytes32 public immutable reciprocalVKey;

    mapping(address => WashRecord) public washRecords;
    mapping(bytes32 => bool) public claimed;

    error WrongChain();
    error AlreadyClaimed();
    error InvalidVKey();
    error NonCanonicalBlock(uint64 blockNumber);

    event WashProven(
        address indexed subject, uint128 washVolume, uint128 settledVolume, bytes32 indexed claimId, uint8 predicateId
    );

    constructor(address verifier_, address stateOracle_, bytes32 closedLoopVKey_, bytes32 reciprocalVKey_) {
        verifier = ISP1Verifier(verifier_);
        stateOracle = IBaseAnalysisStateOracle(stateOracle_);
        closedLoopVKey = closedLoopVKey_;
        reciprocalVKey = reciprocalVKey_;
    }

    function submit(bytes calldata publicValues, bytes calldata proofBytes) external {
        WashJournal memory journal = abi.decode(publicValues, (WashJournal));

        if (journal.chainId != BASE_CHAIN_ID) revert WrongChain();
        if (claimed[journal.claimId]) revert AlreadyClaimed();

        bytes32 vkey = journal.predicateId == 1 ? closedLoopVKey : reciprocalVKey;
        if (vkey == bytes32(0)) revert InvalidVKey();

        verifier.verifyProof(vkey, publicValues, proofBytes);
        claimed[journal.claimId] = true;

        for (uint256 i = 0; i < journal.blockRefs.length; ++i) {
            BlockRef memory ref = journal.blockRefs[i];
            if (!stateOracle.isCanonicalBlock(ref.number, ref.blockHash)) {
                revert NonCanonicalBlock(ref.number);
            }
        }

        for (uint256 i = 0; i < journal.subjects.length; ++i) {
            SubjectRecord memory s = journal.subjects[i];
            WashRecord storage r = washRecords[s.subject];
            r.washVolume += s.washVolume;
            if (s.settledVolume > r.settledVolume) r.settledVolume = s.settledVolume;
            emit WashProven(s.subject, s.washVolume, s.settledVolume, journal.claimId, journal.predicateId);
        }
    }

    function isSellerWashTradingFlagged(address seller) external view override returns (bool) {
        return washRecords[seller].washVolume > 0;
    }

    function washRatioBps(address seller) external view returns (uint256) {
        WashRecord storage r = washRecords[seller];
        if (r.settledVolume == 0) return 0;
        uint256 ratio = (uint256(r.washVolume) * 10_000) / uint256(r.settledVolume);
        return ratio > 10_000 ? 10_000 : ratio;
    }
}
