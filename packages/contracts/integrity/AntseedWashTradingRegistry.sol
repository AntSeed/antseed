// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IBaseAnalysisStateOracle } from "../interfaces/IBaseAnalysisStateOracle.sol";
import { IAntseedWashTradingRegistry } from "../interfaces/IAntseedWashTradingRegistry.sol";
import { ISP1Verifier } from "../interfaces/ISP1Verifier.sol";

contract AntseedWashTradingRegistry is IAntseedWashTradingRegistry {
    uint256 private constant BASE_CHAIN_ID = 8_453;
    uint8 private constant CLOSED_CYCLE_PROOF_TYPE = 1;
    uint8 private constant RECIPROCAL_PROOF_TYPE = 2;

    struct BlockRef {
        uint64 number;
        bytes32 blockHash;
    }

    struct ClosedCycleJournal {
        address seller;
        BlockRef[] blockRefs;
    }

    struct ReciprocalJournal {
        address addressA;
        address addressB;
        BlockRef[] blockRefs;
    }

    ISP1Verifier public immutable verifier;
    IBaseAnalysisStateOracle public immutable stateOracle;
    bytes32 public immutable closedCycleProgramVKey;
    bytes32 public immutable reciprocalProgramVKey;

    mapping(address seller => bool flagged) public override isSellerWashTradingFlagged;

    error WrongChain(uint256 chainId);
    error ZeroAddress();
    error NoCode(address target);
    error ZeroConfiguration();
    error NonCanonicalBlock(uint64 blockNumber, bytes32 blockHash);

    event SellerWashTradingFlagged(address indexed seller, bytes32 indexed journalDigest, uint8 indexed proofType);

    constructor(
        address verifier_,
        address stateOracle_,
        bytes32 closedCycleProgramVKey_,
        bytes32 reciprocalProgramVKey_
    ) {
        if (block.chainid != BASE_CHAIN_ID) revert WrongChain(block.chainid);
        if (verifier_ == address(0) || stateOracle_ == address(0)) revert ZeroAddress();
        if (verifier_.code.length == 0) revert NoCode(verifier_);
        if (stateOracle_.code.length == 0) revert NoCode(stateOracle_);
        if (closedCycleProgramVKey_ == bytes32(0) || reciprocalProgramVKey_ == bytes32(0)) revert ZeroConfiguration();
        verifier = ISP1Verifier(verifier_);
        stateOracle = IBaseAnalysisStateOracle(stateOracle_);
        closedCycleProgramVKey = closedCycleProgramVKey_;
        reciprocalProgramVKey = reciprocalProgramVKey_;
    }

    function submitClosedCycleProof(bytes calldata proofBytes, bytes calldata publicValues)
        external
        returns (bool recorded)
    {
        bytes32 journalDigest = sha256(publicValues);
        verifier.verifyProof(closedCycleProgramVKey, publicValues, proofBytes);
        ClosedCycleJournal memory journal = abi.decode(publicValues, (ClosedCycleJournal));
        _validateBlocks(journal.blockRefs);
        return _recordSellerFlag(journal.seller, journalDigest, CLOSED_CYCLE_PROOF_TYPE);
    }

    function submitReciprocalProof(bytes calldata proofBytes, bytes calldata publicValues)
        external
        returns (bool recordedA, bool recordedB)
    {
        bytes32 journalDigest = sha256(publicValues);
        verifier.verifyProof(reciprocalProgramVKey, publicValues, proofBytes);
        ReciprocalJournal memory journal = abi.decode(publicValues, (ReciprocalJournal));
        _validateBlocks(journal.blockRefs);
        recordedA = _recordSellerFlag(journal.addressA, journalDigest, RECIPROCAL_PROOF_TYPE);
        recordedB = _recordSellerFlag(journal.addressB, journalDigest, RECIPROCAL_PROOF_TYPE);
    }

    function _validateBlocks(BlockRef[] memory blockRefs) private view {
        for (uint256 index = 0; index < blockRefs.length; ++index) {
            BlockRef memory blockRef = blockRefs[index];
            if (!stateOracle.isCanonicalBlock(blockRef.number, blockRef.blockHash)) {
                revert NonCanonicalBlock(blockRef.number, blockRef.blockHash);
            }
        }
    }

    function _recordSellerFlag(address seller, bytes32 journalDigest, uint8 proofType) private returns (bool) {
        if (isSellerWashTradingFlagged[seller]) return false;
        isSellerWashTradingFlagged[seller] = true;
        emit SellerWashTradingFlagged(seller, journalDigest, proofType);
        return true;
    }
}
