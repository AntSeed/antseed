// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";

import { IAntseedRelayTreasury } from "../../interfaces/IAntseedRelayTreasury.sol";
import { AntseedRelayTreasury } from "../../verification/AntseedRelayTreasury.sol";
import { MockUSDC } from "../mocks/MockUSDC.sol";

contract AntseedRelayTreasuryFuzzTest is Test {
    MockUSDC private usdc;
    AntseedRelayTreasury private treasury;

    function setUp() public {
        vm.warp(1_800_000_000);
        usdc = new MockUSDC();
        treasury = new AntseedRelayTreasury(address(usdc), address(this), 1_000, 100_000, 1_000_000);
        usdc.mint(address(treasury), 1_000_000);
    }

    function testFuzz_paidRemainingAndReleasedReconcile(uint16 jobsSeed, uint96 payoutSeed, uint16 paidSeed) public {
        uint16 jobs = uint16(bound(jobsSeed, 1, 100));
        uint96 payout = uint96(bound(payoutSeed, 1, 1_000));
        vm.assume(uint256(jobs) * payout <= 100_000);
        uint16 paid = uint16(bound(paidSeed, 0, jobs));
        bytes32 auditId = keccak256(abi.encode(jobs, payout, paid));
        treasury.reserveAuditBudget(auditId, 1, jobs, payout, uint64(block.timestamp + 1 days));
        if (paid != 0) {
            address[] memory recipients = new address[](1);
            recipients[0] = address(0xBEEF);
            uint16[] memory counts = new uint16[](1);
            counts[0] = paid;
            treasury.payBatch(auditId, recipients, counts);
        }

        IAntseedRelayTreasury.AuditReservation memory beforeRelease = treasury.getReservation(auditId);
        assertEq(
            uint256(beforeRelease.paidJobCount) * payout + beforeRelease.remainingBudgetUsdc,
            beforeRelease.totalBudgetUsdc
        );
        assertGe(usdc.balanceOf(address(treasury)), treasury.totalLockedUsdc());

        if (beforeRelease.remainingBudgetUsdc != 0) {
            vm.warp(beforeRelease.releaseAfter + 1);
            treasury.releaseExpiredAuditBudget(auditId);
            IAntseedRelayTreasury.AuditReservation memory afterRelease = treasury.getReservation(auditId);
            assertTrue(afterRelease.released);
            assertEq(afterRelease.remainingBudgetUsdc, 0);
            vm.expectRevert(AntseedRelayTreasury.AuditBudgetReleasedAlready.selector);
            treasury.payJob(auditId, address(1));
        }
    }

    function testFuzz_withdrawNeverConsumesLocks(uint16 jobsSeed, uint96 payoutSeed, uint256 withdrawSeed) public {
        uint16 jobs = uint16(bound(jobsSeed, 1, 100));
        uint96 payout = uint96(bound(payoutSeed, 1, 1_000));
        vm.assume(uint256(jobs) * payout <= 100_000);
        treasury.reserveAuditBudget(bytes32("audit"), 1, jobs, payout, uint64(block.timestamp + 1 days));
        uint256 amount = bound(withdrawSeed, 0, treasury.availableBalance());
        if (amount != 0) treasury.withdraw(address(0xCAFE), amount);
        assertGe(usdc.balanceOf(address(treasury)), treasury.totalLockedUsdc());
    }

    function invariant_balanceAlwaysCoversLockedLiabilities() public view {
        assertGe(usdc.balanceOf(address(treasury)), treasury.totalLockedUsdc());
    }
}
