// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";

import { IAntseedRelayTreasury } from "../../interfaces/IAntseedRelayTreasury.sol";
import { AntseedRelayTreasury } from "../../verification/AntseedRelayTreasury.sol";
import { MockUSDC } from "../mocks/MockUSDC.sol";

contract TreasuryRegistryCaller {
    function reserve(
        AntseedRelayTreasury treasury,
        bytes32 auditId,
        uint256 epoch,
        uint16 jobCount,
        uint96 payout,
        uint64 releaseAfter
    ) external {
        treasury.reserveAuditBudget(auditId, epoch, jobCount, payout, releaseAfter);
    }

    function payJob(AntseedRelayTreasury treasury, bytes32 auditId, address recipient) external {
        treasury.payJob(auditId, recipient);
    }

    function payBatch(
        AntseedRelayTreasury treasury,
        bytes32 auditId,
        address[] calldata recipients,
        uint16[] calldata jobCounts
    ) external {
        treasury.payBatch(auditId, recipients, jobCounts);
    }
}

contract AntseedRelayTreasuryTest is Test {
    uint96 private constant PER_JOB = 100;
    uint96 private constant PER_AUDIT = 1_000;
    uint96 private constant PER_EPOCH = 5_000;

    MockUSDC private usdc;
    TreasuryRegistryCaller private registryCaller;
    AntseedRelayTreasury private treasury;

    function setUp() public {
        vm.warp(1_800_000_000);
        usdc = new MockUSDC();
        registryCaller = new TreasuryRegistryCaller();
        treasury = new AntseedRelayTreasury(address(usdc), address(registryCaller), PER_JOB, PER_AUDIT, PER_EPOCH);
        usdc.mint(address(this), 10_000);
        usdc.approve(address(treasury), type(uint256).max);
        treasury.fund(5_000);
    }

    function test_constructorRejectsInvalidAddressesAndCaps() public {
        vm.expectRevert(AntseedRelayTreasury.InvalidAddress.selector);
        new AntseedRelayTreasury(address(0), address(registryCaller), 1, 1, 1);
        vm.expectRevert(AntseedRelayTreasury.InvalidAddress.selector);
        new AntseedRelayTreasury(address(usdc), address(0x1234), 1, 1, 1);
        vm.expectRevert(AntseedRelayTreasury.InvalidPayoutCaps.selector);
        new AntseedRelayTreasury(address(usdc), address(registryCaller), 2, 1, 3);
        vm.expectRevert(AntseedRelayTreasury.InvalidPayoutCaps.selector);
        new AntseedRelayTreasury(address(usdc), address(registryCaller), 1, 3, 2);
    }

    function test_onlyRegistryCanReserveAndPay() public {
        vm.expectRevert(AntseedRelayTreasury.NotVerifierRegistry.selector);
        treasury.reserveAuditBudget(bytes32("audit"), 1, 1, PER_JOB, uint64(block.timestamp + 1));
        vm.expectRevert(AntseedRelayTreasury.NotVerifierRegistry.selector);
        treasury.payJob(bytes32("audit"), address(1));
    }

    function test_reservationLocksRealBalanceAndTracksEpochs() public {
        _reserve(bytes32("audit"), 2, 4, PER_JOB);
        assertEq(treasury.totalLockedUsdc(), 400);
        assertEq(treasury.availableBalance(), 4_600);
        assertEq(treasury.committedBudgetByEpoch(2), 400);
        assertEq(treasury.lockedBudgetByEpoch(2), 400);
        IAntseedRelayTreasury.AuditReservation memory reservation = treasury.getReservation(bytes32("audit"));
        assertEq(reservation.totalBudgetUsdc, 400);
        assertEq(reservation.remainingBudgetUsdc, 400);
    }

    function test_underfundedAndDuplicateReservationsRevert() public {
        AntseedRelayTreasury empty =
            new AntseedRelayTreasury(address(usdc), address(registryCaller), PER_JOB, PER_AUDIT, PER_EPOCH);
        vm.expectRevert(AntseedRelayTreasury.InsufficientTreasuryBalance.selector);
        registryCaller.reserve(empty, bytes32("empty"), 1, 1, PER_JOB, uint64(block.timestamp + 1));

        _reserve(bytes32("audit"), 1, 1, PER_JOB);
        vm.expectRevert(AntseedRelayTreasury.AuditBudgetAlreadyReserved.selector);
        _reserve(bytes32("audit"), 1, 1, PER_JOB);
    }

    function test_reservationEnforcesJobAuditAndEpochCaps() public {
        vm.expectRevert(AntseedRelayTreasury.PayoutCapExceeded.selector);
        _reserve(bytes32("job-cap"), 1, 1, PER_JOB + 1);
        vm.expectRevert(AntseedRelayTreasury.PayoutCapExceeded.selector);
        _reserve(bytes32("audit-cap"), 1, 11, PER_JOB);

        _reserve(bytes32("epoch-a"), 7, 10, PER_JOB);
        treasury.setEpochBudgetCap(PER_AUDIT);
        vm.expectRevert(AntseedRelayTreasury.EpochBudgetCapExceeded.selector);
        _reserve(bytes32("epoch-b"), 7, 1, PER_JOB);
    }

    function test_withdrawCannotConsumeLockedFunds() public {
        _reserve(bytes32("audit"), 1, 10, PER_JOB);
        treasury.withdraw(address(0xCAFE), 4_000);
        assertEq(usdc.balanceOf(address(0xCAFE)), 4_000);
        vm.expectRevert(AntseedRelayTreasury.LockedFunds.selector);
        treasury.withdraw(address(0xCAFE), 1);
        assertEq(usdc.balanceOf(address(treasury)), treasury.totalLockedUsdc());
    }

    function test_singleAndBatchPaymentsUseFrozenPrice() public {
        bytes32 auditId = bytes32("audit");
        _reserve(auditId, 3, 5, PER_JOB);
        registryCaller.payJob(treasury, auditId, address(0xA));

        address[] memory recipients = new address[](2);
        recipients[0] = address(0xB);
        recipients[1] = address(0xC);
        uint16[] memory counts = new uint16[](2);
        counts[0] = 2;
        counts[1] = 1;
        registryCaller.payBatch(treasury, auditId, recipients, counts);

        assertEq(usdc.balanceOf(address(0xA)), PER_JOB);
        assertEq(usdc.balanceOf(address(0xB)), PER_JOB * 2);
        assertEq(usdc.balanceOf(address(0xC)), PER_JOB);
        assertEq(treasury.totalLockedUsdc(), PER_JOB);
        assertEq(treasury.lockedBudgetByEpoch(3), PER_JOB);
        assertEq(treasury.committedBudgetByEpoch(3), PER_JOB * 5);
    }

    function test_batchValidationAndOverpayment() public {
        bytes32 auditId = bytes32("audit");
        _reserve(auditId, 1, 2, PER_JOB);
        address[] memory recipients = new address[](0);
        uint16[] memory counts = new uint16[](0);
        vm.expectRevert(AntseedRelayTreasury.ArrayLengthMismatch.selector);
        registryCaller.payBatch(treasury, auditId, recipients, counts);

        recipients = new address[](1);
        counts = new uint16[](2);
        vm.expectRevert(AntseedRelayTreasury.ArrayLengthMismatch.selector);
        registryCaller.payBatch(treasury, auditId, recipients, counts);

        counts = new uint16[](1);
        vm.expectRevert(AntseedRelayTreasury.InvalidAddress.selector);
        registryCaller.payBatch(treasury, auditId, recipients, counts);
        recipients[0] = address(1);
        vm.expectRevert(AntseedRelayTreasury.InvalidAmount.selector);
        registryCaller.payBatch(treasury, auditId, recipients, counts);
        counts[0] = 3;
        vm.expectRevert(AntseedRelayTreasury.InsufficientReservedBudget.selector);
        registryCaller.payBatch(treasury, auditId, recipients, counts);
    }

    function test_expiryReleaseIsPermissionlessAndIdempotent() public {
        bytes32 auditId = bytes32("audit");
        _reserve(auditId, 4, 3, PER_JOB);
        uint64 releaseAfter = treasury.getReservation(auditId).releaseAfter;
        vm.expectRevert(AntseedRelayTreasury.ReleaseNotAvailable.selector);
        treasury.releaseExpiredAuditBudget(auditId);
        vm.warp(releaseAfter + 1);
        vm.prank(address(0xBEEF));
        treasury.releaseExpiredAuditBudget(auditId);
        assertEq(treasury.totalLockedUsdc(), 0);
        assertEq(treasury.lockedBudgetByEpoch(4), 0);
        assertEq(treasury.committedBudgetByEpoch(4), 300);
        vm.expectRevert(AntseedRelayTreasury.AuditBudgetReleasedAlready.selector);
        treasury.releaseExpiredAuditBudget(auditId);
    }

    function test_capChangesOnlyAffectFutureReservations() public {
        bytes32 auditId = bytes32("audit");
        _reserve(auditId, 1, 2, PER_JOB);
        treasury.setPayoutCaps(50, 500);
        registryCaller.payJob(treasury, auditId, address(0xA));
        assertEq(usdc.balanceOf(address(0xA)), PER_JOB);

        vm.expectRevert(AntseedRelayTreasury.InvalidPayoutCaps.selector);
        treasury.setPayoutCaps(600, 500);
        vm.expectRevert(AntseedRelayTreasury.InvalidPayoutCaps.selector);
        treasury.setEpochBudgetCap(400);
    }

    function _reserve(bytes32 auditId, uint256 epoch, uint16 jobCount, uint96 payout) private {
        registryCaller.reserve(treasury, auditId, epoch, jobCount, payout, uint64(block.timestamp + 1 days));
    }
}
