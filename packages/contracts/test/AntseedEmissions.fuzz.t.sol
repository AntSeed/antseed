// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

import {AntseedEmissions} from "../AntseedEmissions.sol";
import {AntseedRegistry} from "../AntseedRegistry.sol";
import {ANTSToken} from "../ANTSToken.sol";

/**
 * @title AntseedEmissionsFuzz
 * @notice Stateless fuzz tests for AntseedEmissions point accrual + claim arithmetic.
 *         The test contract registers itself as `channels` so it can drive accrue*.
 */
contract AntseedEmissionsFuzz is Test {
    AntseedRegistry registry;
    ANTSToken ants;
    AntseedEmissions emissions;

    uint256 constant INITIAL_EMISSION = 5_000_000e18;
    uint256 constant EPOCH_DURATION = 7 days;

    address sellerA = address(0x5A);
    address sellerB = address(0x5B);

    function setUp() public {
        registry = new AntseedRegistry();
        ants = new ANTSToken();
        emissions = new AntseedEmissions(address(registry), INITIAL_EMISSION, EPOCH_DURATION);

        registry.setChannels(address(this)); // test drives accrue*
        registry.setEmissions(address(emissions));
        registry.setAntsToken(address(ants));
        ants.setRegistry(address(registry));
    }

    // ── point accrual conservation ──────────────────────────────────────────
    function testFuzz_accruePointsConserved(uint256 pa, uint256 pb) public {
        pa = bound(pa, 1, 1e30);
        pb = bound(pb, 1, 1e30);
        uint256 epoch = emissions.currentEpoch();

        emissions.accrueSellerPoints(sellerA, pa);
        emissions.accrueSellerPoints(sellerB, pb);

        assertEq(emissions.userSellerPoints(sellerA, epoch), pa);
        assertEq(emissions.userSellerPoints(sellerB, epoch), pb);
        assertEq(emissions.epochTotalSellerPoints(epoch), pa + pb, "epoch total != sum of user points");
    }

    function testFuzz_accrueIsAdditive(uint256 p1, uint256 p2) public {
        p1 = bound(p1, 1, 1e30);
        p2 = bound(p2, 1, 1e30);
        uint256 epoch = emissions.currentEpoch();

        emissions.accrueSellerPoints(sellerA, p1);
        emissions.accrueSellerPoints(sellerA, p2);
        assertEq(emissions.userSellerPoints(sellerA, epoch), p1 + p2);
    }

    // ── claim never exceeds the epoch seller budget / per-seller cap ─────────
    function testFuzz_claimWithinBudget(uint256 pa, uint256 pb) public {
        pa = bound(pa, 1, 1e24);
        pb = bound(pb, 1, 1e24);

        emissions.accrueSellerPoints(sellerA, pa);
        emissions.accrueSellerPoints(sellerB, pb);

        uint256 claimEpoch = emissions.currentEpoch();
        vm.warp(block.timestamp + EPOCH_DURATION); // finalize the epoch

        uint256 sBudget = (emissions.getEpochEmission(claimEpoch) * emissions.SELLER_SHARE_PCT()) / 100;
        uint256 maxReward = (sBudget * emissions.MAX_SELLER_SHARE_PCT()) / 100;

        uint256[] memory arr = new uint256[](1);
        arr[0] = claimEpoch;
        vm.prank(sellerA);
        emissions.claimSellerEmissions(arr);

        uint256 minted = ants.balanceOf(sellerA);
        assertLe(minted, sBudget, "reward exceeds seller budget");
        assertLe(minted, maxReward, "reward exceeds per-seller cap");
    }

    /// @notice Two sellers' combined claimed seller rewards never exceed the seller budget.
    function testFuzz_combinedClaimsWithinBudget(uint256 pa, uint256 pb) public {
        pa = bound(pa, 1, 1e24);
        pb = bound(pb, 1, 1e24);

        emissions.accrueSellerPoints(sellerA, pa);
        emissions.accrueSellerPoints(sellerB, pb);

        uint256 claimEpoch = emissions.currentEpoch();
        vm.warp(block.timestamp + EPOCH_DURATION);

        uint256 sBudget = (emissions.getEpochEmission(claimEpoch) * emissions.SELLER_SHARE_PCT()) / 100;

        uint256[] memory arr = new uint256[](1);
        arr[0] = claimEpoch;
        vm.prank(sellerA);
        emissions.claimSellerEmissions(arr);
        vm.prank(sellerB);
        emissions.claimSellerEmissions(arr);

        assertLe(ants.balanceOf(sellerA) + ants.balanceOf(sellerB), sBudget, "combined > seller budget");
    }

    // ── double claim is a no-op ──────────────────────────────────────────────
    function testFuzz_doubleClaimNoSecondMint(uint256 pa) public {
        pa = bound(pa, 1, 1e24);
        emissions.accrueSellerPoints(sellerA, pa);

        uint256 claimEpoch = emissions.currentEpoch();
        vm.warp(block.timestamp + EPOCH_DURATION);

        uint256[] memory arr = new uint256[](1);
        arr[0] = claimEpoch;

        vm.prank(sellerA);
        emissions.claimSellerEmissions(arr);
        uint256 afterFirst = ants.balanceOf(sellerA);

        vm.prank(sellerA);
        emissions.claimSellerEmissions(arr);
        assertEq(ants.balanceOf(sellerA), afterFirst, "second claim minted again");
    }

    // ── emission schedule (halving) ──────────────────────────────────────────
    function testFuzz_epochEmissionHalving(uint256 epoch) public view {
        epoch = bound(epoch, 0, 2080); // 20 halvings
        assertEq(emissions.getEpochEmission(epoch), INITIAL_EMISSION >> (epoch / 104));
    }

    function testFuzz_epochEmissionNonIncreasing(uint256 epoch) public view {
        epoch = bound(epoch, 0, 2079);
        assertGe(emissions.getEpochEmission(epoch), emissions.getEpochEmission(epoch + 1));
    }

    // accrue* is restricted to the wired Channels contract.
    function test_accrueOnlyChannels() public {
        vm.prank(address(0xBAD));
        vm.expectRevert(AntseedEmissions.NotAuthorized.selector);
        emissions.accrueSellerPoints(sellerA, 1);
    }
}
