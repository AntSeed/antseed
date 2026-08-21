// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Ownable2Step } from "@openzeppelin/contracts/access/Ownable2Step.sol";

import { IAntseedSellerClaimPolicy } from "../interfaces/IAntseedSellerClaimPolicy.sol";
import { IAntseedSellerUnlockPolicy } from "../interfaces/IAntseedSellerUnlockPolicy.sol";

contract AntseedSellerRewardPolicyRegistry is IAntseedSellerClaimPolicy, IAntseedSellerUnlockPolicy, Ownable2Step {
    uint256 public constant MAX_POLICIES = 8;
    uint256 public constant POLICY_GAS_LIMIT = 100_000;

    struct RegisteredPolicy {
        address policy;
        bool checksUnlockedClaims;
        bool checksLockedClaims;
    }

    RegisteredPolicy[] private _policies;
    mapping(address policy => uint256 indexPlusOne) private _policyIndexPlusOne;
    uint256 public unlockedClaimPolicyCount;
    uint256 public lockedClaimPolicyCount;

    event PolicyRegistered(
        address indexed policy, bool indexed checksUnlockedClaims, bool indexed checksLockedClaims, uint256 index
    );
    event PolicyRemoved(address indexed policy, uint256 indexed index);

    error InvalidPolicy();
    error PolicyAlreadyRegistered(address policy);
    error PolicyNotRegistered(address policy);
    error TooManyPolicies();

    constructor(address initialOwner) Ownable(initialOwner) { }

    function registerPolicy(address policy, bool checksUnlockedClaims, bool checksLockedClaims) external onlyOwner {
        if (
            policy == address(0) || policy == address(this) || policy.code.length == 0
                || (!checksUnlockedClaims && !checksLockedClaims)
        ) revert InvalidPolicy();
        if (_policyIndexPlusOne[policy] != 0) revert PolicyAlreadyRegistered(policy);
        if (_policies.length == MAX_POLICIES) revert TooManyPolicies();

        uint256 index = _policies.length;
        _policies.push(
            RegisteredPolicy({
                policy: policy,
                checksUnlockedClaims: checksUnlockedClaims,
                checksLockedClaims: checksLockedClaims
            })
        );
        _policyIndexPlusOne[policy] = index + 1;
        if (checksUnlockedClaims) ++unlockedClaimPolicyCount;
        if (checksLockedClaims) ++lockedClaimPolicyCount;
        emit PolicyRegistered(policy, checksUnlockedClaims, checksLockedClaims, index);
    }

    function removePolicy(address policy) external onlyOwner {
        uint256 indexPlusOne = _policyIndexPlusOne[policy];
        if (indexPlusOne == 0) revert PolicyNotRegistered(policy);

        uint256 index = indexPlusOne - 1;
        uint256 lastIndex = _policies.length - 1;
        RegisteredPolicy memory removed = _policies[index];
        for (uint256 current = index; current < lastIndex; ++current) {
            RegisteredPolicy memory shifted = _policies[current + 1];
            _policies[current] = shifted;
            _policyIndexPlusOne[shifted.policy] = current + 1;
        }
        _policies.pop();
        delete _policyIndexPlusOne[policy];
        if (removed.checksUnlockedClaims) --unlockedClaimPolicyCount;
        if (removed.checksLockedClaims) --lockedClaimPolicyCount;
        emit PolicyRemoved(policy, index);
    }

    function policyCount() external view returns (uint256) {
        return _policies.length;
    }

    function policyAt(uint256 index) external view returns (RegisteredPolicy memory) {
        return _policies[index];
    }

    function isPolicyRegistered(address policy) external view returns (bool) {
        return _policyIndexPlusOne[policy] != 0;
    }

    function canClaimSellerUnlocked(address seller) external view returns (bool) {
        if (unlockedClaimPolicyCount == 0) return false;
        uint256 count = _policies.length;
        for (uint256 index = 0; index < count; ++index) {
            RegisteredPolicy memory registered = _policies[index];
            if (!registered.checksUnlockedClaims) continue;
            (bool success, bytes memory result) = registered.policy.staticcall{ gas: POLICY_GAS_LIMIT }(
                abi.encodeCall(IAntseedSellerUnlockPolicy.canClaimSellerUnlocked, (seller))
            );
            if (!success || result.length != 32) return false;
            uint256 allowed;
            assembly {
                allowed := mload(add(result, 0x20))
            }
            if (allowed != 1) return false;
        }
        return true;
    }

    function claimableSellerRewards(address seller, uint256 lockedAmount) external view returns (uint256 amount) {
        if (lockedClaimPolicyCount == 0) return 0;
        amount = lockedAmount;
        uint256 count = _policies.length;
        for (uint256 index = 0; index < count; ++index) {
            RegisteredPolicy memory registered = _policies[index];
            if (!registered.checksLockedClaims) continue;
            (bool success, bytes memory result) = registered.policy.staticcall{ gas: POLICY_GAS_LIMIT }(
                abi.encodeCall(IAntseedSellerClaimPolicy.claimableSellerRewards, (seller, lockedAmount))
            );
            if (!success || result.length != 32) return 0;
            uint256 candidate;
            assembly {
                candidate := mload(add(result, 0x20))
            }
            if (candidate > lockedAmount) return 0;
            if (candidate < amount) amount = candidate;
        }
    }
}
