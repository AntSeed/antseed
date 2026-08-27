// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Ownable2Step } from "@openzeppelin/contracts/access/Ownable2Step.sol";

import { IAntseedPointsPenaltyPolicy } from "../interfaces/IAntseedPointsPenaltyPolicy.sol";
import { IAntseedRegistry } from "../interfaces/IAntseedRegistry.sol";
import { IAntseedStaking } from "../interfaces/IAntseedStaking.sol";
import { IAntseedVerificationStatus } from "../interfaces/IAntseedVerificationStatus.sol";

contract AntseedVerificationPointsPolicy is IAntseedPointsPenaltyPolicy, Ownable2Step {
    bytes32 public constant PENALTY_CATEGORY = keccak256("model-verification");
    uint16 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant MIN_CORROBORATING_VERIFIERS = 2;

    IAntseedRegistry public immutable registry;
    IAntseedVerificationStatus public immutable verificationStatus;
    uint256 public minDistinctDiffVerifiers = MIN_CORROBORATING_VERIFIERS;
    uint16 public diffPenaltyBps = BPS_DENOMINATOR;

    event MinDistinctDiffVerifiersSet(uint256 previousMinimum, uint256 newMinimum);
    event DiffPenaltyBpsSet(uint16 previousPenaltyBps, uint16 newPenaltyBps);

    error InvalidAddress();
    error InvalidMinimumCorroboration();
    error InvalidPenaltyBps();

    constructor(address initialOwner, address registry_, address verificationStatus_) Ownable(initialOwner) {
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
        if (verificationStatus.activeAgentDiffVerifierCount(agentId) < minDistinctDiffVerifiers) return (0, 0);
        return (diffPenaltyBps, 0);
    }

    function setMinDistinctDiffVerifiers(uint256 minimum) external onlyOwner {
        uint256 previousMinimum = minDistinctDiffVerifiers;
        if (minimum < MIN_CORROBORATING_VERIFIERS || minimum < previousMinimum) {
            revert InvalidMinimumCorroboration();
        }
        if (minimum == previousMinimum) return;
        minDistinctDiffVerifiers = minimum;
        emit MinDistinctDiffVerifiersSet(previousMinimum, minimum);
    }

    function setDiffPenaltyBps(uint16 newPenaltyBps) external onlyOwner {
        if (newPenaltyBps > BPS_DENOMINATOR) revert InvalidPenaltyBps();
        uint16 previousPenaltyBps = diffPenaltyBps;
        if (newPenaltyBps == previousPenaltyBps) return;
        diffPenaltyBps = newPenaltyBps;
        emit DiffPenaltyBpsSet(previousPenaltyBps, newPenaltyBps);
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
