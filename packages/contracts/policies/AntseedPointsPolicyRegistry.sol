// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Ownable2Step } from "@openzeppelin/contracts/access/Ownable2Step.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

import { IAntseedPointsModifier } from "../interfaces/IAntseedPointsModifier.sol";
import { IAntseedPointsPolicy } from "../interfaces/IAntseedPointsPolicy.sol";

contract AntseedPointsPolicyRegistry is IAntseedPointsPolicy, Ownable2Step {
    uint256 public constant MAX_POLICIES = 8;
    uint16 public constant BPS_DENOMINATOR = 10_000;
    uint16 public constant MIN_POINTS_MULTIPLIER_BPS = 1_000;
    uint16 public constant MAX_POINTS_MULTIPLIER_BPS = 20_000;

    struct RegisteredPolicy {
        address policy;
        bytes32 category;
    }

    RegisteredPolicy[] private _policies;
    mapping(address policy => uint256 indexPlusOne) private _policyIndexPlusOne;

    event PolicyRegistered(address indexed policy, bytes32 indexed category, uint256 indexed index);
    event PolicyRemoved(address indexed policy, bytes32 indexed category, uint256 indexed index);

    error InvalidPolicy();
    error PolicyAlreadyRegistered(address policy);
    error PolicyNotRegistered(address policy);
    error TooManyPolicies();
    error InvalidPointsMultiplier(
        address policy, uint256 index, uint256 sellerMultiplierBps, uint256 buyerMultiplierBps
    );

    constructor(address initialOwner) Ownable(initialOwner) { }

    function registerPolicy(address policy) external onlyOwner {
        if (policy == address(0) || policy == address(this) || policy.code.length == 0) revert InvalidPolicy();
        if (_policyIndexPlusOne[policy] != 0) revert PolicyAlreadyRegistered(policy);
        if (_policies.length == MAX_POLICIES) revert TooManyPolicies();

        bytes32 category;
        try IAntseedPointsModifier(policy).modifierCategory() returns (bytes32 policyCategory) {
            category = policyCategory;
        } catch {
            revert InvalidPolicy();
        }
        if (category == bytes32(0)) revert InvalidPolicy();

        uint256 index = _policies.length;
        _policies.push(RegisteredPolicy({ policy: policy, category: category }));
        _policyIndexPlusOne[policy] = index + 1;
        emit PolicyRegistered(policy, category, index);
    }

    function removePolicy(address policy) external onlyOwner {
        uint256 indexPlusOne = _policyIndexPlusOne[policy];
        if (indexPlusOne == 0) revert PolicyNotRegistered(policy);

        uint256 index = indexPlusOne - 1;
        uint256 lastIndex = _policies.length - 1;
        bytes32 category = _policies[index].category;
        for (uint256 current = index; current < lastIndex; ++current) {
            RegisteredPolicy memory shifted = _policies[current + 1];
            _policies[current] = shifted;
            _policyIndexPlusOne[shifted.policy] = current + 1;
        }
        _policies.pop();
        delete _policyIndexPlusOne[policy];
        emit PolicyRemoved(policy, category, index);
    }

    function policyCount() external view returns (uint256) {
        return _policies.length;
    }

    function policyAt(uint256 index) external view returns (address policy, bytes32 category) {
        RegisteredPolicy memory registered = _policies[index];
        return (registered.policy, registered.category);
    }

    function isPolicyRegistered(address policy) external view returns (bool) {
        return _policyIndexPlusOne[policy] != 0;
    }

    function points(bytes32 channelId, address buyer, address seller, uint256 rawPoints)
        external
        view
        returns (uint256 sellerPoints, uint256 buyerPoints)
    {
        bytes32[MAX_POLICIES] memory categories;
        uint16[MAX_POLICIES] memory sellerCategoryMultipliers;
        uint16[MAX_POLICIES] memory buyerCategoryMultipliers;
        uint256 categoryCount;

        uint256 count = _policies.length;
        for (uint256 index = 0; index < count; ++index) {
            RegisteredPolicy memory registered = _policies[index];
            (uint16 sellerMultiplier, uint16 buyerMultiplier) =
                IAntseedPointsModifier(registered.policy).pointsMultiplierBps(channelId, buyer, seller, rawPoints);
            if (sellerMultiplier > MAX_POINTS_MULTIPLIER_BPS || buyerMultiplier > MAX_POINTS_MULTIPLIER_BPS) {
                revert InvalidPointsMultiplier(registered.policy, index, sellerMultiplier, buyerMultiplier);
            }

            uint256 categoryIndex = categoryCount;
            for (uint256 current = 0; current < categoryCount; ++current) {
                if (categories[current] == registered.category) {
                    categoryIndex = current;
                    break;
                }
            }
            if (categoryIndex == categoryCount) {
                categories[categoryCount] = registered.category;
                sellerCategoryMultipliers[categoryCount] = BPS_DENOMINATOR;
                buyerCategoryMultipliers[categoryCount] = BPS_DENOMINATOR;
                ++categoryCount;
            }
            sellerCategoryMultipliers[categoryIndex] =
                _strongerMultiplier(sellerCategoryMultipliers[categoryIndex], sellerMultiplier);
            buyerCategoryMultipliers[categoryIndex] =
                _strongerMultiplier(buyerCategoryMultipliers[categoryIndex], buyerMultiplier);
        }

        sellerPoints =
            Math.mulDiv(rawPoints, _combinedMultiplier(sellerCategoryMultipliers, categoryCount), BPS_DENOMINATOR);
        buyerPoints =
            Math.mulDiv(rawPoints, _combinedMultiplier(buyerCategoryMultipliers, categoryCount), BPS_DENOMINATOR);
    }

    function _strongerMultiplier(uint16 currentMultiplier, uint16 candidateMultiplier) private pure returns (uint16) {
        uint256 currentDistance = currentMultiplier > BPS_DENOMINATOR
            ? currentMultiplier - BPS_DENOMINATOR
            : BPS_DENOMINATOR - currentMultiplier;
        uint256 candidateDistance = candidateMultiplier > BPS_DENOMINATOR
            ? candidateMultiplier - BPS_DENOMINATOR
            : BPS_DENOMINATOR - candidateMultiplier;
        if (
            candidateDistance > currentDistance
                || candidateDistance == currentDistance && candidateMultiplier < currentMultiplier
        ) {
            return candidateMultiplier;
        }
        return currentMultiplier;
    }

    function _combinedMultiplier(uint16[MAX_POLICIES] memory categoryMultipliers, uint256 categoryCount)
        private
        pure
        returns (uint256)
    {
        uint256 totalReduction;
        uint256 totalBoost;
        for (uint256 index = 0; index < categoryCount; ++index) {
            uint16 multiplier = categoryMultipliers[index];
            if (multiplier == 0) return 0;
            if (multiplier < BPS_DENOMINATOR) {
                totalReduction += BPS_DENOMINATOR - multiplier;
            } else {
                totalBoost += multiplier - BPS_DENOMINATOR;
            }
        }

        if (totalBoost >= totalReduction) {
            return Math.min(MAX_POINTS_MULTIPLIER_BPS, BPS_DENOMINATOR + totalBoost - totalReduction);
        }

        uint256 netReduction = totalReduction - totalBoost;
        if (netReduction >= BPS_DENOMINATOR - MIN_POINTS_MULTIPLIER_BPS) {
            return MIN_POINTS_MULTIPLIER_BPS;
        }
        return BPS_DENOMINATOR - netReduction;
    }
}
