// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Ownable2Step } from "@openzeppelin/contracts/access/Ownable2Step.sol";

import { IAntseedSellerClaimPolicy } from "../interfaces/IAntseedSellerClaimPolicy.sol";
import { IAntseedSellerUnlockPolicy } from "../interfaces/IAntseedSellerUnlockPolicy.sol";
import { IBaseHistoricalCoverage } from "../interfaces/IBaseHistoricalCoverage.sol";

contract AntseedHistoricalClaimsPolicy is IAntseedSellerClaimPolicy, IAntseedSellerUnlockPolicy, Ownable2Step {
    IBaseHistoricalCoverage public immutable historicalCoverage;

    bool public backfillFinalized;
    bytes32 public proofReleaseDigest;

    event BackfillFinalized(bytes32 indexed proofReleaseDigest);

    error InvalidAddress();
    error InvalidProofReleaseDigest();
    error HistoricalCoverageIncomplete();
    error BackfillAlreadyFinalized();

    constructor(address historicalCoverage_, address initialOwner) Ownable(initialOwner) {
        if (historicalCoverage_ == address(0) || historicalCoverage_.code.length == 0) revert InvalidAddress();
        historicalCoverage = IBaseHistoricalCoverage(historicalCoverage_);
    }

    function finalizeBackfill(bytes32 proofReleaseDigest_) external onlyOwner {
        if (backfillFinalized) revert BackfillAlreadyFinalized();
        if (proofReleaseDigest_ == bytes32(0)) revert InvalidProofReleaseDigest();
        if (!historicalCoverage.historicalCoverageComplete()) revert HistoricalCoverageIncomplete();
        proofReleaseDigest = proofReleaseDigest_;
        backfillFinalized = true;
        emit BackfillFinalized(proofReleaseDigest_);
    }

    function canClaimSellerUnlocked(address) external view returns (bool) {
        return backfillFinalized;
    }

    function claimableSellerRewards(address, uint256 lockedAmount) external view returns (uint256) {
        return backfillFinalized ? lockedAmount : 0;
    }
}
