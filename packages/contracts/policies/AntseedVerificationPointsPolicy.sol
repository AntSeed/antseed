// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IAntseedPointsPenaltyPolicy } from "../interfaces/IAntseedPointsPenaltyPolicy.sol";
import { IAntseedRegistry } from "../interfaces/IAntseedRegistry.sol";
import { IAntseedStaking } from "../interfaces/IAntseedStaking.sol";
import { IAntseedVerificationStatus } from "../interfaces/IAntseedVerificationStatus.sol";

contract AntseedVerificationPointsPolicy is IAntseedPointsPenaltyPolicy {
    bytes32 public constant PENALTY_CATEGORY = keccak256("model-verification");

    IAntseedRegistry public immutable registry;
    IAntseedVerificationStatus public immutable verificationStatus;

    error InvalidAddress();

    constructor(address registry_, address verificationStatus_) {
        if (
            registry_ == address(0) || registry_.code.length == 0 || verificationStatus_ == address(0)
                || verificationStatus_.code.length == 0
        ) revert InvalidAddress();
        registry = IAntseedRegistry(registry_);
        verificationStatus = IAntseedVerificationStatus(verificationStatus_);
    }

    function penaltyCategory() external pure returns (bytes32) {
        return PENALTY_CATEGORY;
    }

    function penaltyBps(bytes32, address, address seller, uint256)
        external
        view
        returns (uint16 sellerPenaltyBps, uint16 buyerPenaltyBps)
    {
        uint256 agentId = _resolveSellerAgentId(seller);
        if (agentId == 0) return (0, 0);
        return (verificationStatus.agentPointsPenaltyBps(agentId), 0);
    }

    function _resolveSellerAgentId(address seller) private view returns (uint256) {
        (bool registryOk, uint256 stakingValue) =
            _readUint256(address(registry), abi.encodeCall(IAntseedRegistry.staking, ()));
        if (!registryOk) return 0;

        address staking = address(uint160(stakingValue));
        if (staking == address(0)) return 0;

        (bool stakingOk, uint256 agentId) = _readUint256(staking, abi.encodeCall(IAntseedStaking.getAgentId, (seller)));
        return stakingOk ? agentId : 0;
    }

    function _readUint256(address target, bytes memory callData) private view returns (bool ok, uint256 value) {
        if (target.code.length == 0) return (false, 0);

        bytes memory data;
        (ok, data) = target.staticcall(callData);
        if (!ok || data.length < 32) return (false, 0);
        value = abi.decode(data, (uint256));
    }
}
