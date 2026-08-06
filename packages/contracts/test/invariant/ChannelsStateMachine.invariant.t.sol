// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ProtocolFixture} from "./ProtocolFixture.sol";
import {AntseedChannels} from "../../payments/AntseedChannels.sol";

/**
 * @title ChannelsStateMachineInvariants
 * @notice State-machine safety invariants for AntseedChannels, driven by the same lifecycle
 *         handler as the custody suite. These are structural (status, accounting, counters) and
 *         independent of the economic/incentive parameters under revision.
 */
contract ChannelsStateMachineInvariants is ProtocolFixture {
    /// @notice A channel's settled amount never exceeds its deposit ceiling.
    function invariant_settledNeverExceedsDeposit() public view {
        uint256 n = handler.chanCount();
        for (uint256 i = 0; i < n; i++) {
            (bytes32 id,,,,,) = handler.chans(i);
            (,, uint128 deposit, uint128 settled,,,,,) = channels.channels(id);
            assertLe(settled, deposit, "settled exceeds deposit");
        }
    }

    /// @notice Once opened, a channel never reverts to the None (uninitialized) status.
    function invariant_openedChannelNeverNone() public view {
        uint256 n = handler.chanCount();
        for (uint256 i = 0; i < n; i++) {
            (bytes32 id,,,,,) = handler.chans(i);
            (,,,,,,,, AntseedChannels.ChannelStatus status) = channels.channels(id);
            assertTrue(status != AntseedChannels.ChannelStatus.None, "opened channel is None");
        }
    }

    /// @notice activeChannelCount[seller] equals the number of channels in Active status for
    ///         that seller — the counter that gates AntseedStaking.unstake must stay exact.
    function invariant_activeChannelCountReconciles() public view {
        uint256 n = handler.chanCount();
        for (uint256 si = 0; si < handler.sellerCount(); si++) {
            address seller = handler.sellerAt(si);
            uint256 liveActive;
            for (uint256 i = 0; i < n; i++) {
                (bytes32 id,, uint256 sellerPk,,,) = handler.chans(i);
                if (vm.addr(sellerPk) != seller) continue;
                (,,,,,,,, AntseedChannels.ChannelStatus status) = channels.channels(id);
                if (status == AntseedChannels.ChannelStatus.Active) liveActive++;
            }
            assertEq(channels.activeChannelCount(seller), liveActive, "activeChannelCount desync");
        }
    }

    /// @notice The handler's mirror `active` flag agrees with the live Active status for every
    ///         channel — i.e. terminal channels (Settled/TimedOut) are never re-activated.
    function invariant_mirrorMatchesLiveActive() public view {
        uint256 n = handler.chanCount();
        for (uint256 i = 0; i < n; i++) {
            (bytes32 id,,,,, bool mirrorActive) = handler.chans(i);
            (,,,,,,,, AntseedChannels.ChannelStatus status) = channels.channels(id);
            bool liveActive = status == AntseedChannels.ChannelStatus.Active;
            assertEq(mirrorActive, liveActive, "mirror/live active mismatch");
        }
    }
}
