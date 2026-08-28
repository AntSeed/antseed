// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Ownable2Step } from "@openzeppelin/contracts/access/Ownable2Step.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

import { IAntseedPointsPenaltyPolicy } from "../../../interfaces/IAntseedPointsPenaltyPolicy.sol";
import { IAntseedPointsPolicy } from "../../../interfaces/IAntseedPointsPolicy.sol";

contract TestPointsPolicyRegistry is IAntseedPointsPolicy, Ownable2Step {
    uint256 public constant MAX_POLICIES = 8;
    uint256 public constant POLICY_GAS_LIMIT = 100_000;
    uint16 public constant BPS_DENOMINATOR = 10_000;
    uint16 public constant MAX_SOFT_PENALTY_BPS = 9_000;

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
    error PolicyEvaluationFailed(address policy, uint256 index);
    error InvalidPenaltyBps(address policy, uint256 index, uint256 sellerPenaltyBps, uint256 buyerPenaltyBps);

    constructor(address initialOwner) Ownable(initialOwner) { }

    function registerPolicy(address policy) external onlyOwner {
        if (policy == address(0) || policy == address(this) || policy.code.length == 0) revert InvalidPolicy();
        if (_policyIndexPlusOne[policy] != 0) revert PolicyAlreadyRegistered(policy);
        if (_policies.length == MAX_POLICIES) revert TooManyPolicies();

        (bool success, bytes memory result) =
            policy.staticcall{ gas: POLICY_GAS_LIMIT }(abi.encodeCall(IAntseedPointsPenaltyPolicy.penaltyCategory, ()));
        if (!success || result.length != 32) revert InvalidPolicy();
        bytes32 category = abi.decode(result, (bytes32));
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
        uint16[MAX_POLICIES] memory sellerCategoryPenalties;
        uint16[MAX_POLICIES] memory buyerCategoryPenalties;
        uint256 categoryCount;

        uint256 count = _policies.length;
        for (uint256 index = 0; index < count; ++index) {
            RegisteredPolicy memory registered = _policies[index];
            (bool success, bytes memory result) = registered.policy.staticcall{ gas: POLICY_GAS_LIMIT }(
                abi.encodeCall(IAntseedPointsPenaltyPolicy.penaltyBps, (channelId, buyer, seller, rawPoints))
            );
            if (!success || result.length != 64) revert PolicyEvaluationFailed(registered.policy, index);

            (uint256 sellerPenalty, uint256 buyerPenalty) = abi.decode(result, (uint256, uint256));
            if (sellerPenalty > BPS_DENOMINATOR || buyerPenalty > BPS_DENOMINATOR) {
                revert InvalidPenaltyBps(registered.policy, index, sellerPenalty, buyerPenalty);
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
                ++categoryCount;
            }
            if (sellerPenalty > sellerCategoryPenalties[categoryIndex]) {
                sellerCategoryPenalties[categoryIndex] = uint16(sellerPenalty);
            }
            if (buyerPenalty > buyerCategoryPenalties[categoryIndex]) {
                buyerCategoryPenalties[categoryIndex] = uint16(buyerPenalty);
            }
        }

        uint256 totalSellerPenalty;
        uint256 totalBuyerPenalty;
        for (uint256 index = 0; index < categoryCount; ++index) {
            totalSellerPenalty = _addCategoryPenalty(totalSellerPenalty, sellerCategoryPenalties[index]);
            totalBuyerPenalty = _addCategoryPenalty(totalBuyerPenalty, buyerCategoryPenalties[index]);
        }
        sellerPoints = Math.mulDiv(rawPoints, BPS_DENOMINATOR - totalSellerPenalty, BPS_DENOMINATOR);
        buyerPoints = Math.mulDiv(rawPoints, BPS_DENOMINATOR - totalBuyerPenalty, BPS_DENOMINATOR);
    }

    function _addCategoryPenalty(uint256 totalPenalty, uint16 categoryPenalty) private pure returns (uint256) {
        if (totalPenalty == BPS_DENOMINATOR || categoryPenalty == 0) return totalPenalty;
        if (categoryPenalty == BPS_DENOMINATOR) return BPS_DENOMINATOR;
        return Math.min(MAX_SOFT_PENALTY_BPS, totalPenalty + categoryPenalty);
    }
}
