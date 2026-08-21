// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IBaseAnalysisStateOracle } from "../interfaces/IBaseAnalysisStateOracle.sol";
import { IAntseedWashTradingRegistry } from "../interfaces/IAntseedWashTradingRegistry.sol";
import { IRiscZeroVerifier } from "../interfaces/IRiscZeroVerifier.sol";

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

    IRiscZeroVerifier public immutable verifier;
    IBaseAnalysisStateOracle public immutable stateOracle;
    bytes32 public immutable closedCycleImageId;
    bytes32 public immutable reciprocalImageId;

    mapping(address seller => bool p0) public override isSellerP0;

    error WrongChain(uint256 chainId);
    error ZeroAddress();
    error NoCode(address target);
    error ZeroConfiguration();
    error NonCanonicalBlock(uint64 blockNumber, bytes32 blockHash);

    event SellerP0Recorded(address indexed seller, bytes32 indexed journalDigest, uint8 indexed proofType);

    constructor(address verifier_, address stateOracle_, bytes32 closedCycleImageId_, bytes32 reciprocalImageId_) {
        if (block.chainid != BASE_CHAIN_ID) revert WrongChain(block.chainid);
        if (verifier_ == address(0) || stateOracle_ == address(0)) revert ZeroAddress();
        if (verifier_.code.length == 0) revert NoCode(verifier_);
        if (stateOracle_.code.length == 0) revert NoCode(stateOracle_);
        if (closedCycleImageId_ == bytes32(0) || reciprocalImageId_ == bytes32(0)) revert ZeroConfiguration();
        verifier = IRiscZeroVerifier(verifier_);
        stateOracle = IBaseAnalysisStateOracle(stateOracle_);
        closedCycleImageId = closedCycleImageId_;
        reciprocalImageId = reciprocalImageId_;
    }

    function submitClosedCycleProof(bytes calldata seal, bytes calldata journalData) external returns (bool recorded) {
        bytes32 journalDigest = sha256(journalData);
        verifier.verify(seal, closedCycleImageId, journalDigest);
        ClosedCycleJournal memory journal = abi.decode(journalData, (ClosedCycleJournal));
        _validateBlocks(journal.blockRefs);
        return _recordSellerP0(journal.seller, journalDigest, CLOSED_CYCLE_PROOF_TYPE);
    }

    function submitReciprocalProof(bytes calldata seal, bytes calldata journalData)
        external
        returns (bool recordedA, bool recordedB)
    {
        bytes32 journalDigest = sha256(journalData);
        verifier.verify(seal, reciprocalImageId, journalDigest);
        ReciprocalJournal memory journal = abi.decode(journalData, (ReciprocalJournal));
        _validateBlocks(journal.blockRefs);
        recordedA = _recordSellerP0(journal.addressA, journalDigest, RECIPROCAL_PROOF_TYPE);
        recordedB = _recordSellerP0(journal.addressB, journalDigest, RECIPROCAL_PROOF_TYPE);
    }

    function _validateBlocks(BlockRef[] memory blockRefs) private view {
        for (uint256 index = 0; index < blockRefs.length; ++index) {
            BlockRef memory blockRef = blockRefs[index];
            if (!stateOracle.isCanonicalBlock(blockRef.number, blockRef.blockHash)) {
                revert NonCanonicalBlock(blockRef.number, blockRef.blockHash);
            }
        }
    }

    function _recordSellerP0(address seller, bytes32 journalDigest, uint8 proofType) private returns (bool) {
        if (isSellerP0[seller]) return false;
        isSellerP0[seller] = true;
        emit SellerP0Recorded(seller, journalDigest, proofType);
        return true;
    }
}
