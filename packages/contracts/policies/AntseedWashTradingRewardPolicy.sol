// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Ownable2Step } from "@openzeppelin/contracts/access/Ownable2Step.sol";

import { IBaseAnalysisStateOracle } from "../interfaces/IBaseAnalysisStateOracle.sol";
import { IAntseedSellerClaimPolicy } from "../interfaces/IAntseedSellerClaimPolicy.sol";
import { IAntseedSellerUnlockPolicy } from "../interfaces/IAntseedSellerUnlockPolicy.sol";
import { IAntseedWashTradingStatus } from "../interfaces/IAntseedWashTradingStatus.sol";

contract AntseedWashTradingRewardPolicy is IAntseedSellerClaimPolicy, IAntseedSellerUnlockPolicy, Ownable2Step {
    IAntseedWashTradingStatus public immutable washTradingStatus;
    IBaseAnalysisStateOracle public immutable baseStateOracle;
    bool public backfillFinalized;
    bytes32 public proofReleaseDigest;

    event BackfillFinalized(bytes32 indexed proofReleaseDigest);

    error InvalidAddress();
    error InvalidProofReleaseDigest();
    error HistoricalCoverageIncomplete();
    error BackfillAlreadyFinalized();

    constructor(address washTradingStatus_, address baseStateOracle_, address initialOwner) Ownable(initialOwner) {
        if (
            washTradingStatus_ == address(0) || washTradingStatus_.code.length == 0 || baseStateOracle_ == address(0)
                || baseStateOracle_.code.length == 0
        ) revert InvalidAddress();
        washTradingStatus = IAntseedWashTradingStatus(washTradingStatus_);
        baseStateOracle = IBaseAnalysisStateOracle(baseStateOracle_);
    }

    function finalizeBackfill(bytes32 proofReleaseDigest_) external onlyOwner {
        if (backfillFinalized) revert BackfillAlreadyFinalized();
        if (proofReleaseDigest_ == bytes32(0)) revert InvalidProofReleaseDigest();
        if (!baseStateOracle.historicalCoverageComplete()) revert HistoricalCoverageIncomplete();
        proofReleaseDigest = proofReleaseDigest_;
        backfillFinalized = true;
        emit BackfillFinalized(proofReleaseDigest_);
    }

    function claimableSellerRewards(address seller, uint256 lockedAmount) external view returns (uint256 amount) {
        if (!backfillFinalized) return 0;
        return washTradingStatus.isSellerWashTradingFlagged(seller) ? 0 : lockedAmount;
    }

    function canClaimSellerUnlocked(address seller) external view returns (bool) {
        if (!backfillFinalized) return false;
        return !washTradingStatus.isSellerWashTradingFlagged(seller);
    }
}
