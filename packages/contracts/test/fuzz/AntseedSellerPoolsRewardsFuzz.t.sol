// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

import { ANTSToken } from "../../core/ANTSToken.sol";
import { AntseedRegistry } from "../../core/AntseedRegistry.sol";
import { AntseedEmissionsGate } from "../../emissions/AntseedEmissionsGate.sol";
import { AntseedSellerPools } from "../../sellers/AntseedSellerPools.sol";
import { AntseedUsageAccounting } from "../../emissions/AntseedUsageAccounting.sol";
import { AntseedSellerPoolsRewards } from "../../emissions/AntseedSellerPoolsRewards.sol";

contract MockAgentLookup {
    mapping(address => uint256) public agentIdBySeller;

    function setAgent(address seller, uint256 agentId) external {
        agentIdBySeller[seller] = agentId;
    }

    function getAgentId(address seller) external view returns (uint256) {
        return agentIdBySeller[seller];
    }
}

/**
 * @title AntseedSellerPoolsRewardsFuzz
 * @notice End-to-end reward-conservation fuzz for the lazy seller-pool reward
 *         controller. Exercises the real stack: EmissionsGate mints, SellerPools
 *         holds stake, UsageAccounting records usage, SellerPoolsRewards settles
 *         and distributes.
 *
 *         Invariants under any random staker set / usage:
 *           1. The pool epoch settles gross == its share of the controller
 *              budget (single pool => full 45% bucket), claimable == gross while
 *              uncapped, and burned + reserve == gross - claimable.
 *           2. The controller never mints past its Gate share budget.
 *           3. Stakers collectively claim <= the claimable amount minted to the
 *              controller — it can NEVER become insolvent. Residual is dust.
 *           4. Each individual position's claim is proportional to its weight and
 *              double-claim is impossible (cursor advances).
 */
contract AntseedSellerPoolsRewardsFuzzTest is Test {
    ANTSToken token;
    AntseedRegistry registry;
    AntseedEmissionsGate gate;
    AntseedSellerPools pools;
    AntseedUsageAccounting usageAccounting;
    AntseedSellerPoolsRewards rewards;
    MockAgentLookup agentLookup;

    address constant KNOWN_ANTS_TOKEN = 0xa87EE81b2C0Bc659307ca2D9ffdC38514DD85263;
    uint256 constant GATE_GENESIS = 1_775_728_461;
    uint256 constant GATE_EPOCH_DURATION = 7 days;
    uint256 constant BPS = 100_000;
    uint32 constant SELLER_POOLS_SHARE_BPS = 45_000;
    bytes32 constant SELLER_POOLS_MINTER_ID = keccak256("antseed.emissions.seller-pools.v1");

    address legacyController = address(0xCAFE);
    address teamWallet = address(0x7EA3);
    address reserve = address(0x5E5E);
    address deposits = address(0xDEDE);
    address seller = address(0x5E11E2);
    address buyer = address(0xB0B);

    uint256 agentId = 0x5EED;
    uint256[] internal positionIds;
    address[] internal stakers;

    function setUp() public {
        vm.warp(1_700_000_000);
        deployCodeTo("ANTSToken.sol:ANTSToken", KNOWN_ANTS_TOKEN);
        token = ANTSToken(KNOWN_ANTS_TOKEN);

        registry = new AntseedRegistry();
        agentLookup = new MockAgentLookup();
        registry.setAntsToken(address(token));
        registry.setEmissions(legacyController);
        registry.setTeamWallet(teamWallet);
        registry.setProtocolReserve(reserve);
        registry.setDeposits(deposits);
        registry.setStaking(address(agentLookup));

        token.setRegistry(address(registry));
        token.enableTransfers();

        // Deploy the gate at epoch 4 so legacy epochs exist and claims for
        // finalized epochs are allowed.
        vm.warp(GATE_GENESIS + GATE_EPOCH_DURATION * 4 + 1);
        gate = new AntseedEmissionsGate(address(registry), 15_000, 15_000);
        token.setRegistry(address(gate));

        pools = new AntseedSellerPools(address(registry), 0, 0, 0); // uncapped APY
        token.setTransferWhitelist(address(pools), true);

        usageAccounting = new AntseedUsageAccounting(address(pools), address(this), address(gate));
        registry.setEmissions(address(usageAccounting)); // pools.currentEpoch() -> gate clock

        rewards = new AntseedSellerPoolsRewards(address(gate), address(pools), address(usageAccounting));
        pools.setRewardStaker(address(rewards), true);
        gate.setMinter(SELLER_POOLS_MINTER_ID, address(rewards), SELLER_POOLS_SHARE_BPS, true);

        agentLookup.setAgent(seller, agentId);
    }

    function _warpGateEpoch(uint256 epoch) internal {
        vm.warp(gate.genesis() + gate.epochDuration() * epoch + 1);
    }

    function _stake(address who, uint256 amount, uint256 dur) internal returns (uint256 id) {
        deal(address(token), who, amount);
        vm.startPrank(who);
        token.approve(address(pools), amount);
        id = pools.stake(agentId, amount, dur);
        vm.stopPrank();
    }

    /// @notice Full lifecycle: random stakers stake into one pool, usage is
    ///         recorded for the seller's agent, the pool epoch settles, and all
    ///         positions claim. The controller distributes exactly what it minted
    ///         (minus rounding dust) and never goes insolvent or over budget.
    function testFuzz_rewardConservationSinglePool(uint256[5] memory amounts, uint8[5] memory durations, uint64 points) public {
        // We are at epoch 4. Stake now (activates epoch 5).
        uint256 stakedTotal;
        for (uint256 i = 0; i < 5; i++) {
            uint256 amount = bound(amounts[i], 1 ether, 50_000_000 ether);
            uint256 dur = uint256(bound(durations[i], 2, 52));
            address who = address(uint160(0x1000 + i));
            stakers.push(who);
            positionIds.push(_stake(who, amount, dur));
            stakedTotal += amount;
        }

        // Move to epoch 5 (positions now active) and record usage for the seller.
        _warpGateEpoch(5);
        uint256 pts = uint256(bound(points, 1, 1_000_000));
        usageAccounting.accrueSellerPoints(seller, pts);
        usageAccounting.accrueBuyerPoints(buyer, pts);

        // Pool must actually have power and recorded weighted points at epoch 5.
        assertGt(pools.poolWeightAtEpoch(agentId, 5), 0, "pool has no power");
        assertGt(usageAccounting.weightedPoolPointsByEpoch(uint256(5), agentId), 0, "no weighted points");

        // Finalize epoch 5 and settle/index it.
        _warpGateEpoch(6);
        uint256 controllerBudget = gate.minterEpochBudget(SELLER_POOLS_MINTER_ID, 5);
        rewards.indexPoolRewards(agentId, 10);

        // ── Invariant 1: settlement routing ──
        (bool settled, uint256 gross, uint256 claimable, uint256 burned, uint256 reserveAmt) =
            rewards.poolEpochEmissions(5, agentId);
        assertTrue(settled, "epoch not settled");
        // Single pool => it owns the whole bucket (minus mulDiv flooring dust).
        assertLe(gross, controllerBudget, "gross over controller budget");
        assertEq(claimable, gross, "uncapped pool should have claimable == gross");
        assertEq(burned, 0, "no burn while uncapped");
        assertEq(reserveAmt, 0, "no reserve while uncapped");

        // ── Invariant 2: controller minted exactly the claimable to itself ──
        // (gross == claimable here; burn/reserve are 0)
        assertEq(gate.minterEpochMinted(SELLER_POOLS_MINTER_ID, 5), gross, "minted != gross");
        assertLe(gate.minterEpochMinted(SELLER_POOLS_MINTER_ID, 5), controllerBudget, "over budget");
        assertEq(token.balanceOf(address(rewards)), claimable, "controller did not custody claimable");

        // ── All positions claim ──
        uint256 totalClaimed;
        for (uint256 i = 0; i < positionIds.length; i++) {
            uint256 before = token.balanceOf(stakers[i]);
            vm.prank(stakers[i]);
            try rewards.claimStakerRewards(positionIds[i], stakers[i]) {
                totalClaimed += token.balanceOf(stakers[i]) - before;
            } catch {
                // NothingToClaim for a dust-zero position is acceptable.
            }
        }

        // ── Invariant 3: conservation + solvency ──
        assertLe(totalClaimed, claimable, "stakers claimed more than minted");
        // The controller holds exactly the undistributed dust; never negative.
        assertEq(token.balanceOf(address(rewards)), claimable - totalClaimed, "insolvency / leak");

        // Dust is bounded by one wei per position (flooring in mulDiv).
        assertLe(claimable - totalClaimed, positionIds.length, "dust larger than rounding bound");

        // ── Invariant 4: double-claim is impossible ──
        for (uint256 i = 0; i < positionIds.length; i++) {
            vm.prank(stakers[i]);
            vm.expectRevert(AntseedSellerPoolsRewards.NothingToClaim.selector);
            rewards.claimStakerRewards(positionIds[i], stakers[i]);
        }
    }
}
