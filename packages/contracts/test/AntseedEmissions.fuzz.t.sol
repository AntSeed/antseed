// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

import {AntseedEmissions} from "../AntseedEmissions.sol";
import {AntseedRegistry} from "../AntseedRegistry.sol";
import {ANTSToken} from "../ANTSToken.sol";

/**
 * @title AntseedEmissionsFuzz
 * @notice Net-new property coverage over AntseedEmissions.t.sol (which already covers accrual,
 *         idempotent claims, the halving schedule at fixed points, and the seller cap): the
 *         claim-within-budget bound over fuzzed point distributions, and emission monotonicity
 *         over the full epoch range. The test contract registers as `channels` to drive accrual.
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

        registry.setChannels(address(this));
        registry.setEmissions(address(emissions));
        registry.setAntsToken(address(ants));
        ants.setRegistry(address(registry));
    }

    /// @notice Two sellers' combined claimed seller rewards never exceed the epoch seller budget,
    ///         for any point split — the conservation the per-seller cap and proportional split
    ///         must jointly guarantee.
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

    /// @notice The emission schedule is non-increasing across the full epoch range (halving).
    function testFuzz_epochEmissionNonIncreasing(uint256 epoch) public view {
        epoch = bound(epoch, 0, 2079);
        assertGe(emissions.getEpochEmission(epoch), emissions.getEpochEmission(epoch + 1));
    }
}
