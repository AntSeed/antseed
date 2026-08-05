// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

import { IAntseedEmissionsGate } from "../interfaces/IAntseedEmissionsGate.sol";
import { IAntseedVerifierRegistry } from "../interfaces/IAntseedVerifierRegistry.sol";
import { IAntseedVerifierRewards } from "../interfaces/IAntseedVerifierRewards.sol";
import { IAntseedRegistry } from "../interfaces/IAntseedRegistry.sol";

interface IRegistryBoundVerifierEmissionsGate {
    function registry() external view returns (IAntseedRegistry);
}

contract AntseedVerifierRewards is IAntseedVerifierRewards, ReentrancyGuard {
    IAntseedEmissionsGate public immutable override gate;
    IAntseedVerifierRegistry public immutable override verifierRegistry;
    uint256 public immutable override firstRewardedEpoch;

    mapping(uint256 epoch => uint256 budgetPlusOne) private _frozenBudgets;
    mapping(uint256 epoch => uint256 totalPlusOne) private _frozenTotalCredits;
    mapping(uint256 epoch => mapping(address verifier => bool claimed)) public override epochRewardClaimed;
    mapping(uint256 epoch => bool settled) public override epochRemainderSettled;

    event VerifierEpochFrozen(uint256 indexed epoch, uint256 budget, uint256 totalCredits);
    event VerifierRewardClaimed(uint256 indexed epoch, address indexed verifier, uint256 amount);
    event VerifierEpochRemainderSettled(uint256 indexed epoch, uint256 amount);

    error InvalidAddress();
    error GateRegistryMismatch();
    error PreEffectiveEpoch();
    error EpochNotFinalized();
    error AlreadyClaimed();
    error NothingToClaim();
    error NothingToSettle();

    constructor(address gate_, address verifierRegistry_) {
        if (gate_ == address(0) || verifierRegistry_ == address(0)) revert InvalidAddress();
        if (gate_.code.length == 0 || verifierRegistry_.code.length == 0) revert InvalidAddress();
        gate = IAntseedEmissionsGate(gate_);
        verifierRegistry = IAntseedVerifierRegistry(verifierRegistry_);
        if (address(IRegistryBoundVerifierEmissionsGate(gate_).registry()) != address(verifierRegistry.registry())) {
            revert GateRegistryMismatch();
        }
        firstRewardedEpoch = gate.effectiveEpoch();
    }

    function claimVerifierReward(uint256 epoch) external override nonReentrant {
        if (epoch < firstRewardedEpoch) revert PreEffectiveEpoch();
        if (epoch >= gate.currentEpoch()) revert EpochNotFinalized();
        if (epochRewardClaimed[epoch][msg.sender]) revert AlreadyClaimed();

        uint256 credits = verifierRegistry.epochCredits(epoch, msg.sender);
        if (credits == 0) revert NothingToClaim();
        (uint256 budget, uint256 totalCredits) = _freezeEpoch(epoch);
        if (totalCredits == 0) revert NothingToClaim();

        uint256 amount = Math.mulDiv(budget, credits, totalCredits);
        epochRewardClaimed[epoch][msg.sender] = true;
        if (amount != 0) gate.claim(epoch, msg.sender, amount);
        emit VerifierRewardClaimed(epoch, msg.sender, amount);
    }

    function settleEpochRemainder(uint256 epoch)
        external
        override
        nonReentrant
        returns (uint256 burnedAmount, uint256 reserveAmount)
    {
        if (epochRemainderSettled[epoch]) revert AlreadyClaimed();
        (uint256 budget, uint256 totalCredits) = _freezeEpoch(epoch);
        if (totalCredits != 0 || budget == 0) revert NothingToSettle();

        epochRemainderSettled[epoch] = true;
        (burnedAmount, reserveAmount) = gate.claimRemainder(epoch, gate.emissionsReserve(), budget);
        emit VerifierEpochRemainderSettled(epoch, budget);
    }

    function pendingVerifierReward(uint256 epoch, address verifier) external view override returns (uint256) {
        if (epoch < firstRewardedEpoch || epoch >= gate.currentEpoch()) return 0;
        if (epochRewardClaimed[epoch][verifier]) return 0;
        uint256 credits = verifierRegistry.epochCredits(epoch, verifier);
        if (credits == 0) return 0;
        uint256 totalCredits = verifierEpochTotalCredits(epoch);
        if (totalCredits == 0) return 0;
        return Math.mulDiv(verifierEpochBudget(epoch), credits, totalCredits);
    }

    function verifierEpochBudget(uint256 epoch) public view override returns (uint256) {
        uint256 frozen = _frozenBudgets[epoch];
        return frozen == 0 ? gate.controllerEpochBudget(address(this), epoch) : frozen - 1;
    }

    function verifierEpochTotalCredits(uint256 epoch) public view override returns (uint256) {
        uint256 frozen = _frozenTotalCredits[epoch];
        return frozen == 0 ? verifierRegistry.epochTotalCredits(epoch) : frozen - 1;
    }

    function _freezeEpoch(uint256 epoch) private returns (uint256 budget, uint256 totalCredits) {
        if (epoch < firstRewardedEpoch) revert PreEffectiveEpoch();
        if (epoch >= gate.currentEpoch()) revert EpochNotFinalized();

        uint256 frozenBudget = _frozenBudgets[epoch];
        uint256 frozenTotal = _frozenTotalCredits[epoch];
        if (frozenBudget == 0) {
            budget = gate.controllerEpochBudget(address(this), epoch);
            _frozenBudgets[epoch] = budget + 1;
        } else {
            budget = frozenBudget - 1;
        }
        if (frozenTotal == 0) {
            totalCredits = verifierRegistry.epochTotalCredits(epoch);
            _frozenTotalCredits[epoch] = totalCredits + 1;
        } else {
            totalCredits = frozenTotal - 1;
        }
        if (frozenBudget == 0 || frozenTotal == 0) emit VerifierEpochFrozen(epoch, budget, totalCredits);
    }
}
