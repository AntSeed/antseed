// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IAntseedPointsPolicy } from "../interfaces/IAntseedPointsPolicy.sol";
import { IAntseedRegistry } from "../interfaces/IAntseedRegistry.sol";
import { IAntseedStaking } from "../interfaces/IAntseedStaking.sol";
import { IAntseedVerifierRegistry } from "../interfaces/IAntseedVerifierRegistry.sol";

/**
 * @title AntseedVerifierPointsPolicy
 * @notice Reduces seller usage points when an audit found a DIFF.
 *         The discount stays active until that DIFF is cleared.
 *         Buyer points are not reduced.
 */
contract AntseedVerifierPointsPolicy is IAntseedPointsPolicy {
    uint256 public constant BPS_DENOMINATOR = 10_000;

    IAntseedRegistry public immutable registry;
    IAntseedVerifierRegistry public immutable verifierRegistry;

    error InvalidAddress();

    /// @notice Saves the contracts used to find the seller and discount.
    constructor(address _registry, address _verifierRegistry) {
        if (_registry == address(0) || _verifierRegistry == address(0)) {
            revert InvalidAddress();
        }
        registry = IAntseedRegistry(_registry);
        verifierRegistry = IAntseedVerifierRegistry(_verifierRegistry);
    }

    /// @notice Returns buyer and seller points for one usage record.
    /// @dev Any bad contract read keeps the original points. This prevents an
    ///      audit contract problem from blocking a USDC settlement.
    function points(bytes32, address, address seller, uint256 rawPoints)
        external
        view
        returns (uint256 sellerPoints, uint256 buyerPoints)
    {
        buyerPoints = rawPoints;
        sellerPoints = rawPoints;

        uint256 agentId = _resolveAgentId(seller);
        if (agentId == 0) return (sellerPoints, buyerPoints);

        (bool penaltyOk, uint256 penaltyBps) = _readUint256(
            address(verifierRegistry), abi.encodeCall(IAntseedVerifierRegistry.agentPointsPenaltyBps, (agentId))
        );
        if (!penaltyOk || penaltyBps == 0) return (sellerPoints, buyerPoints);
        if (penaltyBps >= BPS_DENOMINATOR) return (0, buyerPoints);

        sellerPoints = _applyKeepBps(rawPoints, BPS_DENOMINATOR - penaltyBps);
    }

    /// @notice Finds the agent ID linked to a seller address.
    function _resolveAgentId(address seller) internal view returns (uint256) {
        (bool registryOk, uint256 stakingValue) =
            _readUint256(address(registry), abi.encodeCall(IAntseedRegistry.staking, ()));
        if (!registryOk) return 0;

        address staking = address(uint160(stakingValue));
        if (staking == address(0)) return 0;

        (bool stakingOk, uint256 agentId) = _readUint256(staking, abi.encodeCall(IAntseedStaking.getAgentId, (seller)));
        return stakingOk ? agentId : 0;
    }

    /// @notice Reads one uint256 without allowing the target to break this policy.
    function _readUint256(address target, bytes memory callData) internal view returns (bool ok, uint256 value) {
        if (target.code.length == 0) return (false, 0);

        bytes memory data;
        (ok, data) = target.staticcall(callData);
        if (!ok || data.length < 32) return (false, 0);
        value = abi.decode(data, (uint256));
    }

    /// @notice Applies a basis-point factor without overflowing.
    function _applyKeepBps(uint256 amount, uint256 keepBps) internal pure returns (uint256) {
        return (amount / BPS_DENOMINATOR) * keepBps + ((amount % BPS_DENOMINATOR) * keepBps) / BPS_DENOMINATOR;
    }
}
