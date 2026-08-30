// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable2Step.sol";

import { IAntseedEmissions } from "../interfaces/IAntseedEmissions.sol";
import { IAntseedPointsPolicy } from "../interfaces/IAntseedPointsPolicy.sol";
import { IAntseedStaking } from "../interfaces/IAntseedStaking.sol";
import { IAntseedWashTradingRegistry } from "../interfaces/IAntseedWashTradingRegistry.sol";

/**
 * @notice Seller-only points penalty for recently proven wash trading.
 *         A finding accepted in epoch N blocks the remainder of N and eight
 *         full subsequent epochs by default, resuming in N + 9.
 */
contract AntseedWashTradingEpochPolicy is IAntseedPointsPolicy, Ownable2Step {
    uint64 public constant DEFAULT_PENALTY_EPOCHS = 8;

    struct DurationCheckpoint {
        uint64 activationEpoch;
        uint64 penaltyEpochs;
    }

    IAntseedWashTradingRegistry public immutable registry;
    IAntseedStaking public immutable sellerRegistry;
    IAntseedEmissions public immutable epochClock;
    DurationCheckpoint[] private _durationCheckpoints;

    event PenaltyEpochsScheduled(uint64 indexed activationEpoch, uint64 penaltyEpochs);

    error ZeroAddress();
    error EpochOverflow();

    constructor(address initialOwner, address registry_, address sellerRegistry_, address epochClock_)
        Ownable(initialOwner)
    {
        if (
            initialOwner == address(0) || registry_ == address(0) || sellerRegistry_ == address(0)
                || epochClock_ == address(0)
        ) revert ZeroAddress();
        registry = IAntseedWashTradingRegistry(registry_);
        sellerRegistry = IAntseedStaking(sellerRegistry_);
        epochClock = IAntseedEmissions(epochClock_);
        _durationCheckpoints.push(DurationCheckpoint(0, DEFAULT_PENALTY_EPOCHS));
    }

    function points(bytes32, address, address seller, uint256 rawPoints)
        external
        view
        returns (uint256 sellerPoints, uint256 buyerPoints)
    {
        uint256 agentId;
        try sellerRegistry.getAgentId(seller) returns (uint256 resolvedAgentId) {
            agentId = resolvedAgentId;
        } catch {
            return (rawPoints, rawPoints);
        }
        if (agentId == 0) return (rawPoints, rawPoints);

        bool found;
        try registry.hasOffense(agentId) returns (bool hasFinding) {
            found = hasFinding;
        } catch {
            return (rawPoints, rawPoints);
        }
        if (!found) return (rawPoints, rawPoints);

        uint64 acceptedEpoch;
        try registry.latestOffenseAcceptedEpoch(agentId) returns (uint64 epoch) {
            acceptedEpoch = epoch;
        } catch {
            return (rawPoints, rawPoints);
        }

        uint256 currentEpoch;
        try epochClock.currentEpoch() returns (uint256 epoch) {
            currentEpoch = epoch;
        } catch {
            return (rawPoints, rawPoints);
        }
        uint256 blockedThroughEpoch = uint256(acceptedEpoch) + penaltyEpochsAt(acceptedEpoch);
        if (currentEpoch <= blockedThroughEpoch) return (0, rawPoints);
        return (rawPoints, rawPoints);
    }

    /// @notice Schedules a duration for findings first accepted next epoch or later.
    function setPenaltyEpochs(uint64 penaltyEpochs) external onlyOwner {
        uint256 currentEpoch = epochClock.currentEpoch();
        if (currentEpoch >= type(uint64).max) revert EpochOverflow();
        uint64 activationEpoch = uint64(currentEpoch + 1);
        uint256 last = _durationCheckpoints.length - 1;
        if (_durationCheckpoints[last].activationEpoch == activationEpoch) {
            _durationCheckpoints[last].penaltyEpochs = penaltyEpochs;
        } else {
            _durationCheckpoints.push(DurationCheckpoint(activationEpoch, penaltyEpochs));
        }
        emit PenaltyEpochsScheduled(activationEpoch, penaltyEpochs);
    }

    function penaltyEpochsAt(uint64 epoch) public view returns (uint64) {
        uint256 low;
        uint256 high = _durationCheckpoints.length;
        while (low + 1 < high) {
            uint256 mid = (low + high) / 2;
            if (_durationCheckpoints[mid].activationEpoch <= epoch) low = mid;
            else high = mid;
        }
        return _durationCheckpoints[low].penaltyEpochs;
    }

    function durationCheckpointCount() external view returns (uint256) {
        return _durationCheckpoints.length;
    }

    function durationCheckpointAt(uint256 index) external view returns (DurationCheckpoint memory) {
        return _durationCheckpoints[index];
    }
}
