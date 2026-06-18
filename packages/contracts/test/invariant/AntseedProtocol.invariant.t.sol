// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ProtocolFixture} from "./ProtocolFixture.sol";

/**
 * @title AntseedProtocolInvariants
 * @notice Custody & conservation invariants over the live-mainnet payment core:
 *         AntseedDeposits (custody) ↔ AntseedChannels (lifecycle).
 *
 *         Emissions is intentionally out of scope here (and unwired in the fixture) while its
 *         economics are under revision; these custody invariants don't depend on it.
 */
contract AntseedProtocolInvariants is ProtocolFixture {
    // ═════════════════════════════════════════════════════════════════════
    //                  CUSTODY INVARIANTS (AntseedDeposits)
    // ═════════════════════════════════════════════════════════════════════

    /// @notice Deposits holds exactly the sum of all buyer balances — no USDC leaks or appears.
    function invariant_depositsSolvent() public view {
        uint256 sumBalances;
        for (uint256 i = 0; i < handler.buyerCount(); i++) {
            (uint256 balance,,,,,) = deposits.buyers(handler.buyerAt(i));
            sumBalances += balance;
        }
        assertEq(usdc.balanceOf(address(deposits)), sumBalances, "deposits insolvent");
    }

    /// @notice Reserved never exceeds balance for any buyer (custody can't over-lock).
    function invariant_reservedLeqBalance() public view {
        for (uint256 i = 0; i < handler.buyerCount(); i++) {
            (uint256 balance, uint256 reserved,,,,) = deposits.buyers(handler.buyerAt(i));
            assertLe(reserved, balance, "reserved exceeds balance");
        }
    }

    /// @notice Global reserved per buyer equals Σ(active channel deposit − settled).
    function invariant_reservedMatchesChannels() public view {
        for (uint256 i = 0; i < handler.buyerCount(); i++) {
            address b = handler.buyerAt(i);
            (, uint256 reserved,,,,) = deposits.buyers(b);
            assertEq(reserved, handler.expectedReservedOf(b), "reserved != sum of channel locks");
        }
    }

    /// @notice The swappable Channels contract never custodies USDC.
    function invariant_channelsHoldNoUsdc() public view {
        assertEq(usdc.balanceOf(address(channels)), 0, "channels holds USDC");
    }

    /// @notice Full USDC conservation across Deposits: held + paid-out = total deposited.
    function invariant_usdcConservation() public view {
        uint256 held = usdc.balanceOf(address(deposits));
        uint256 paidOut = handler.ghostWithdrawn() + handler.ghostToSellers() + handler.ghostToReserve();
        uint256 seeded = SEED_DEPOSIT * handler.buyerCount();
        assertEq(held + paidOut, handler.ghostDeposited() + seeded, "USDC not conserved");
    }
}
