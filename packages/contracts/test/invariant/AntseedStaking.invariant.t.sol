// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

import {AntseedStaking} from "../../staking/AntseedStaking.sol";
import {AntseedRegistry} from "../../core/AntseedRegistry.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";
import {MockERC8004Registry} from "../mocks/MockERC8004Registry.sol";
import {MockChannelsCounter} from "../mocks/MockChannelsCounter.sol";

import {StakingHandler} from "./StakingHandler.sol";

/**
 * @title AntseedStakingInvariants
 * @notice Custody + identity-binding invariants for AntseedStaking, deployed without a slashing
 *         module (slashing is being reworked). Asserts solvency and the agentId<->seller
 *         bijection across arbitrary stake/stakeFor/unstake sequences.
 */
contract AntseedStakingInvariants is Test {
    MockUSDC usdc;
    MockERC8004Registry identity;
    AntseedRegistry registry;
    MockChannelsCounter mockChannels;
    AntseedStaking staking;
    StakingHandler handler;

    function setUp() public {
        usdc = new MockUSDC();
        identity = new MockERC8004Registry();
        registry = new AntseedRegistry();
        mockChannels = new MockChannelsCounter();
        staking = new AntseedStaking(address(usdc), address(registry));

        registry.setIdentityRegistry(address(identity));
        registry.setChannels(address(mockChannels));
        registry.setProtocolReserve(address(0xFEE));

        handler = new StakingHandler(staking, usdc, identity, mockChannels);

        bytes4[] memory selectors = new bytes4[](4);
        selectors[0] = handler.stakeSelf.selector;
        selectors[1] = handler.stakeForOther.selector;
        selectors[2] = handler.unstake.selector;
        selectors[3] = handler.setActiveCount.selector;

        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    /// @notice The staking contract holds exactly the sum of all sellers' stakes.
    function invariant_solvency() public view {
        uint256 sum;
        for (uint256 i = 0; i < handler.sellerCount(); i++) {
            sum += staking.getStake(handler.sellerAt(i));
        }
        assertEq(usdc.balanceOf(address(staking)), sum, "staking insolvent");
    }

    /// @notice agentId<->seller binding is a consistent bijection: a staked seller's agentId
    ///         resolves back to that seller, and clearing stake clears the binding.
    function invariant_bindingBijection() public view {
        for (uint256 i = 0; i < handler.sellerCount(); i++) {
            address s = handler.sellerAt(i);
            uint256 boundAgent = staking.sellerAgentId(s);
            if (staking.getStake(s) > 0) {
                assertTrue(boundAgent != 0, "staked seller has no agentId");
                assertEq(staking.agentSeller(boundAgent), s, "agent does not resolve to seller");
            } else {
                assertEq(boundAgent, 0, "unstaked seller still bound");
            }
        }
    }

    /// @notice A seller's own registered agentId is never bound to a different seller.
    function invariant_noCrossBinding() public view {
        for (uint256 i = 0; i < handler.sellerCount(); i++) {
            uint256 agentId = handler.agentIdAt(i);
            address bound_ = staking.agentSeller(agentId);
            assertTrue(
                bound_ == address(0) || bound_ == handler.sellerAt(i),
                "agent bound to wrong seller"
            );
        }
    }
}
