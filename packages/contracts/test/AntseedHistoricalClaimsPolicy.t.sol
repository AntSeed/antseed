// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";

import { AntseedHistoricalClaimsPolicy } from "../policies/AntseedHistoricalClaimsPolicy.sol";

contract HistoricalCoverageMock {
    bool public historicalCoverageComplete;

    function setHistoricalCoverageComplete(bool complete) external {
        historicalCoverageComplete = complete;
    }
}

contract HistoricalClaimsPolicyTest is Test {
    address internal constant SELLER = address(0xA11CE);
    bytes32 internal constant RELEASE_DIGEST = keccak256("proof-release");

    HistoricalCoverageMock internal coverage;
    AntseedHistoricalClaimsPolicy internal policy;

    function setUp() public {
        coverage = new HistoricalCoverageMock();
        policy = new AntseedHistoricalClaimsPolicy(address(coverage), address(this));
    }

    function test_blocksBothClaimRoutesBeforeFinalization() public view {
        assertFalse(policy.canClaimSellerUnlocked(SELLER));
        assertEq(policy.claimableSellerRewards(SELLER, 100 ether), 0);
    }

    function test_rejectsIncompleteHistoricalCoverage() public {
        vm.expectRevert(AntseedHistoricalClaimsPolicy.HistoricalCoverageIncomplete.selector);
        policy.finalizeBackfill(RELEASE_DIGEST);
    }

    function test_rejectsZeroReleaseDigest() public {
        coverage.setHistoricalCoverageComplete(true);
        vm.expectRevert(AntseedHistoricalClaimsPolicy.InvalidProofReleaseDigest.selector);
        policy.finalizeBackfill(bytes32(0));
    }

    function test_finalizesOnceAndStoresReleaseDigest() public {
        coverage.setHistoricalCoverageComplete(true);
        policy.finalizeBackfill(RELEASE_DIGEST);
        assertTrue(policy.backfillFinalized());
        assertEq(policy.proofReleaseDigest(), RELEASE_DIGEST);

        vm.expectRevert(AntseedHistoricalClaimsPolicy.BackfillAlreadyFinalized.selector);
        policy.finalizeBackfill(keccak256("second-release"));
    }

    function test_passesBothClaimRoutesAfterFinalization() public {
        coverage.setHistoricalCoverageComplete(true);
        policy.finalizeBackfill(RELEASE_DIGEST);
        assertTrue(policy.canClaimSellerUnlocked(SELLER));
        assertEq(policy.claimableSellerRewards(SELLER, 100 ether), 100 ether);
    }
}
