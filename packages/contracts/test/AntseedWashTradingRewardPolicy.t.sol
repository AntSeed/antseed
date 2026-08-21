// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Test } from "forge-std/Test.sol";

import { AntseedWashTradingRewardPolicy } from "../policies/AntseedWashTradingRewardPolicy.sol";
import { IAntseedWashTradingStatus } from "../interfaces/IAntseedWashTradingStatus.sol";

contract MockWashTradingStatusRegistry is IAntseedWashTradingStatus {
    mapping(address seller => bool flagged) private sellerFlags;
    bool public revertReads;

    function setWashTradingFlag(address seller, bool flagged) external {
        sellerFlags[seller] = flagged;
    }

    function setRevertReads(bool value) external {
        revertReads = value;
    }

    function isSellerWashTradingFlagged(address seller) external view returns (bool) {
        if (revertReads) revert("wash-trading registry unavailable");
        return sellerFlags[seller];
    }
}

contract RewardPolicyHistoricalCoverageMock {
    bool public historicalCoverageComplete;

    function setHistoricalCoverageComplete(bool complete) external {
        historicalCoverageComplete = complete;
    }

    function isCanonicalBlock(uint64, bytes32) external pure returns (bool) {
        return true;
    }
}

contract AntseedWashTradingRewardPolicyTest is Test {
    address internal constant SELLER = address(0xA11CE);
    address internal constant OTHER = address(0xB0B);
    uint256 internal constant LOCKED = 100 ether;
    bytes32 internal constant RELEASE_DIGEST = keccak256("complete-proof-release");

    MockWashTradingStatusRegistry internal registry;
    RewardPolicyHistoricalCoverageMock internal coverage;
    AntseedWashTradingRewardPolicy internal policy;

    function setUp() public {
        registry = new MockWashTradingStatusRegistry();
        coverage = new RewardPolicyHistoricalCoverageMock();
        policy = new AntseedWashTradingRewardPolicy(address(registry), address(coverage), address(this));
    }

    function test_claimsStayBlockedBeforeBackfillFinalization() public view {
        assertFalse(policy.canClaimSellerUnlocked(SELLER));
        assertEq(policy.claimableSellerRewards(SELLER, LOCKED), 0);
    }

    function test_unflaggedSellerCanUseBothRewardRoutesAfterBackfill() public {
        _finalizeBackfill();

        assertTrue(policy.canClaimSellerUnlocked(SELLER));
        assertEq(policy.claimableSellerRewards(SELLER, LOCKED), LOCKED);
    }

    function test_flaggedSellerIsBlockedOnBothRewardRoutes() public {
        _finalizeBackfill();
        registry.setWashTradingFlag(SELLER, true);

        assertFalse(policy.canClaimSellerUnlocked(SELLER));
        assertEq(policy.claimableSellerRewards(SELLER, LOCKED), 0);
    }

    function test_dependencyFailureFailsClosed() public {
        _finalizeBackfill();
        registry.setRevertReads(true);

        vm.expectRevert("wash-trading registry unavailable");
        policy.canClaimSellerUnlocked(SELLER);
        vm.expectRevert("wash-trading registry unavailable");
        policy.claimableSellerRewards(SELLER, LOCKED);
    }

    function test_finalizeBackfillRecordsReleaseDigestOnce() public {
        _finalizeBackfill();

        assertTrue(policy.backfillFinalized());
        assertEq(policy.proofReleaseDigest(), RELEASE_DIGEST);
        vm.expectRevert(AntseedWashTradingRewardPolicy.BackfillAlreadyFinalized.selector);
        policy.finalizeBackfill(keccak256("second-release"));
    }

    function test_finalizeBackfillRequiresHistoricalCoverage() public {
        vm.expectRevert(AntseedWashTradingRewardPolicy.HistoricalCoverageIncomplete.selector);
        policy.finalizeBackfill(RELEASE_DIGEST);
    }

    function test_finalizeBackfillRejectsZeroDigest() public {
        coverage.setHistoricalCoverageComplete(true);

        vm.expectRevert(AntseedWashTradingRewardPolicy.InvalidProofReleaseDigest.selector);
        policy.finalizeBackfill(bytes32(0));
    }

    function test_onlyOwnerCanFinalizeBackfill() public {
        coverage.setHistoricalCoverageComplete(true);

        vm.prank(OTHER);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, OTHER));
        policy.finalizeBackfill(RELEASE_DIGEST);
    }

    function test_constructorRejectsInvalidWashTradingStatus() public {
        vm.expectRevert(AntseedWashTradingRewardPolicy.InvalidAddress.selector);
        new AntseedWashTradingRewardPolicy(address(0), address(coverage), address(this));
        vm.expectRevert(AntseedWashTradingRewardPolicy.InvalidAddress.selector);
        new AntseedWashTradingRewardPolicy(address(1), address(coverage), address(this));
    }

    function test_constructorRejectsInvalidBaseStateOracle() public {
        vm.expectRevert(AntseedWashTradingRewardPolicy.InvalidAddress.selector);
        new AntseedWashTradingRewardPolicy(address(registry), address(0), address(this));
        vm.expectRevert(AntseedWashTradingRewardPolicy.InvalidAddress.selector);
        new AntseedWashTradingRewardPolicy(address(registry), address(1), address(this));
    }

    function _finalizeBackfill() internal {
        coverage.setHistoricalCoverageComplete(true);
        policy.finalizeBackfill(RELEASE_DIGEST);
    }
}
