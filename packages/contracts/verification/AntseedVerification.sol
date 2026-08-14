// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Ownable2Step } from "@openzeppelin/contracts/access/Ownable2Step.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

import { IAntseedEmissionsGate } from "../interfaces/IAntseedEmissionsGate.sol";
import { IAntseedRegistry } from "../interfaces/IAntseedRegistry.sol";
import { IAntseedStaking } from "../interfaces/IAntseedStaking.sol";
import { IAntseedVerification } from "../interfaces/IAntseedVerification.sol";
import { IERC8004Registry } from "../interfaces/IERC8004Registry.sol";

contract AntseedVerification is IAntseedVerification, Ownable2Step, ReentrancyGuard {
    uint256 public constant BPS_DENOMINATOR = 10_000;
    IAntseedRegistry public immutable override registry;
    IAntseedEmissionsGate public immutable override emissionsGate;
    uint256 public immutable override firstRewardedEpoch;

    mapping(address verifier => bool approved) public override approvedVerifiers;

    /// @notice Credit weights use six-decimal USD micros: 1 credit = $1 = 1_000_000 units.
    /// @dev The default cap is 100 credits. Fractional credits remain exact, so $1.20 is 1_200_000 units.
    uint64 public override maxCreditUsdMicrosPerVerifierPerEpoch = 100_000_000;

    mapping(bytes32 evidenceHash => bool submitted) private _submittedVerifications;
    mapping(uint256 agentId => uint16 penaltyBps) private _agentPointsPenaltyBps;

    mapping(uint256 epoch => mapping(address verifier => uint256 creditUsdMicros)) public override epochCreditUsdMicros;
    mapping(uint256 epoch => uint256 creditUsdMicros) public override epochTotalCreditUsdMicros;

    mapping(uint256 epoch => uint256 budgetPlusOne) private _frozenEpochBudgets;
    mapping(uint256 epoch => uint256 totalCreditUsdMicrosPlusOne) private _frozenEpochTotalCreditUsdMicros;
    mapping(uint256 epoch => bool settled) public override epochRemainderSettled;

    event VerifierApprovalSet(address indexed verifier, bool approved);
    event MaxCreditUsdMicrosPerVerifierPerEpochSet(uint64 maximum);
    event VerificationBundleSubmitted(
        bytes32 indexed evidenceHash,
        address indexed verifier,
        uint256 indexed epoch,
        uint64 totalAuditCostUsdMicros,
        uint64 awardedCreditUsdMicros,
        uint32 resultCount
    );
    event VerificationResultSubmitted(
        bytes32 indexed evidenceHash,
        uint256 indexed agentId,
        bytes32 indexed serviceHash,
        Verdict verdict,
        uint16 modelShareBps
    );
    event AgentPointsPenaltySet(uint256 indexed agentId, uint16 penaltyBps);
    event VerifierRewardClaimed(uint256 indexed epoch, address indexed verifier, uint256 amount);
    event VerifierEpochRemainderSettled(uint256 indexed epoch, uint256 amount);

    error InvalidAddress();
    error InvalidValue();
    error NotApprovedVerifier();
    error InvalidVerdict();
    error InvalidModelShare();
    error EpochChanged();
    error VerificationAlreadySubmitted();
    error UnknownAgent();
    error SelfAudit();
    error PreEffectiveEpoch();
    error EpochNotFinalized();
    error AlreadyClaimed();
    error NothingToClaim();
    error NothingToSettle();

    modifier onlyApprovedVerifier() {
        if (!approvedVerifiers[msg.sender]) revert NotApprovedVerifier();
        _;
    }

    constructor(address registry_, address emissionsGate_) Ownable(msg.sender) {
        if (registry_ == address(0) || emissionsGate_ == address(0)) revert InvalidAddress();
        if (registry_.code.length == 0 || emissionsGate_.code.length == 0) revert InvalidAddress();
        registry = IAntseedRegistry(registry_);
        emissionsGate = IAntseedEmissionsGate(emissionsGate_);
        firstRewardedEpoch = Math.max(emissionsGate.effectiveEpoch(), emissionsGate.currentEpoch() + 1);
    }

    function setVerifier(address verifier, bool approved) external override onlyOwner {
        if (verifier == address(0)) revert InvalidAddress();
        approvedVerifiers[verifier] = approved;
        emit VerifierApprovalSet(verifier, approved);
    }

    function setMaxCreditUsdMicrosPerVerifierPerEpoch(uint64 maximum) external override onlyOwner {
        if (maximum == 0) revert InvalidValue();
        maxCreditUsdMicrosPerVerifierPerEpoch = maximum;
        emit MaxCreditUsdMicrosPerVerifierPerEpochSet(maximum);
    }

    /// @notice Submits the audit for one model across multiple seller peers.
    function submitVerificationBundle(
        uint256 expectedEpoch,
        uint64 totalAuditCostUsdMicros,
        bytes32 evidenceHash,
        VerificationResult[] calldata results
    ) external override onlyApprovedVerifier nonReentrant {
        if (evidenceHash == bytes32(0)) revert InvalidValue();
        if (_submittedVerifications[evidenceHash]) revert VerificationAlreadySubmitted();
        uint256 epoch = currentEpoch();
        if (epoch != expectedEpoch) revert EpochChanged();

        for (uint256 i = 0; i < results.length; i++) {
            VerificationResult calldata result = results[i];
            _validateResult(result);
            if (_resolveAgentOwner(result.agentId) == msg.sender) revert SelfAudit();
        }

        _submittedVerifications[evidenceHash] = true;

        uint64 awardedCreditUsdMicros;
        if (epoch >= firstRewardedEpoch && emissionsGate.controllerEpochBudget(address(this), epoch) != 0) {
            uint256 currentCreditUsdMicros = epochCreditUsdMicros[epoch][msg.sender];
            uint256 remainingCreditUsdMicros = currentCreditUsdMicros < maxCreditUsdMicrosPerVerifierPerEpoch
                ? uint256(maxCreditUsdMicrosPerVerifierPerEpoch) - currentCreditUsdMicros
                : 0;
            awardedCreditUsdMicros = totalAuditCostUsdMicros < remainingCreditUsdMicros
                ? totalAuditCostUsdMicros
                : uint64(remainingCreditUsdMicros);
            if (awardedCreditUsdMicros != 0) {
                epochCreditUsdMicros[epoch][msg.sender] = currentCreditUsdMicros + awardedCreditUsdMicros;
                epochTotalCreditUsdMicros[epoch] += awardedCreditUsdMicros;
            }
        }

        emit VerificationBundleSubmitted(
            evidenceHash, msg.sender, epoch, totalAuditCostUsdMicros, awardedCreditUsdMicros, uint32(results.length)
        );
        for (uint256 i = 0; i < results.length; i++) {
            VerificationResult calldata result = results[i];
            _applyAttestationPenalty(result.agentId, result.verdict, result.modelShareBps);
            emit VerificationResultSubmitted(
                evidenceHash, result.agentId, result.serviceHash, result.verdict, result.modelShareBps
            );
        }
    }

    function isVerificationSubmitted(bytes32 evidenceHash) external view override returns (bool) {
        return _submittedVerifications[evidenceHash];
    }

    function currentEpoch() public view override returns (uint256) {
        return emissionsGate.currentEpoch();
    }

    function agentPointsPenaltyBps(uint256 agentId) external view override returns (uint16) {
        return _agentPointsPenaltyBps[agentId];
    }

    function points(bytes32, address, address seller, uint256 rawPoints)
        external
        view
        override
        returns (uint256 sellerPoints, uint256 buyerPoints)
    {
        buyerPoints = rawPoints;
        sellerPoints = rawPoints;

        uint256 agentId = _resolveSellerAgentId(seller);
        if (agentId == 0) return (sellerPoints, buyerPoints);

        uint16 penaltyBps = _agentPointsPenaltyBps[agentId];
        if (penaltyBps == 0) return (sellerPoints, buyerPoints);
        if (penaltyBps >= BPS_DENOMINATOR) return (0, buyerPoints);
        sellerPoints = _applyKeepBps(rawPoints, BPS_DENOMINATOR - penaltyBps);
    }

    function claimVerifierReward(uint256 epoch) external override nonReentrant {
        if (epoch < firstRewardedEpoch) revert PreEffectiveEpoch();
        if (epoch >= currentEpoch()) revert EpochNotFinalized();
        uint256 creditUsdMicros = epochCreditUsdMicros[epoch][msg.sender];
        if (creditUsdMicros == 0) revert NothingToClaim();
        (uint256 budget, uint256 totalCreditUsdMicros) = _freezeEpochRewardState(epoch);
        if (budget == 0 || totalCreditUsdMicros == 0) revert NothingToClaim();

        uint256 amount = Math.mulDiv(budget, creditUsdMicros, totalCreditUsdMicros);
        epochCreditUsdMicros[epoch][msg.sender] = 0;
        if (amount != 0) emissionsGate.claim(epoch, msg.sender, amount);
        emit VerifierRewardClaimed(epoch, msg.sender, amount);
    }

    function settleEpochRemainder(uint256 epoch)
        external
        override
        nonReentrant
        returns (uint256 burnedAmount, uint256 reserveAmount)
    {
        if (epoch < firstRewardedEpoch) revert PreEffectiveEpoch();
        if (epoch >= currentEpoch()) revert EpochNotFinalized();
        if (epochRemainderSettled[epoch]) revert AlreadyClaimed();
        (uint256 budget, uint256 totalCreditUsdMicros) = _freezeEpochRewardState(epoch);
        if (totalCreditUsdMicros != 0 || budget == 0) revert NothingToSettle();

        epochRemainderSettled[epoch] = true;
        (burnedAmount, reserveAmount) = emissionsGate.claimRemainder(epoch, emissionsGate.emissionsReserve(), budget);
        emit VerifierEpochRemainderSettled(epoch, budget);
    }

    function pendingVerifierReward(uint256 epoch, address verifier) external view override returns (uint256) {
        if (epoch < firstRewardedEpoch || epoch >= currentEpoch()) return 0;
        uint256 creditUsdMicros = epochCreditUsdMicros[epoch][verifier];
        if (creditUsdMicros == 0) return 0;
        uint256 totalCreditUsdMicros = verifierEpochTotalCreditUsdMicros(epoch);
        if (totalCreditUsdMicros == 0) return 0;
        return Math.mulDiv(verifierEpochBudget(epoch), creditUsdMicros, totalCreditUsdMicros);
    }

    function verifierEpochBudget(uint256 epoch) public view override returns (uint256) {
        uint256 frozenBudget = _frozenEpochBudgets[epoch];
        if (frozenBudget != 0) return frozenBudget - 1;
        return emissionsGate.controllerEpochBudget(address(this), epoch);
    }

    function verifierEpochTotalCreditUsdMicros(uint256 epoch) public view override returns (uint256) {
        uint256 frozenTotalCreditUsdMicros = _frozenEpochTotalCreditUsdMicros[epoch];
        if (frozenTotalCreditUsdMicros != 0) return frozenTotalCreditUsdMicros - 1;
        return epochTotalCreditUsdMicros[epoch];
    }

    function _freezeEpochRewardState(uint256 epoch) private returns (uint256 budget, uint256 totalCreditUsdMicros) {
        uint256 frozenBudget = _frozenEpochBudgets[epoch];
        if (frozenBudget != 0) {
            return (frozenBudget - 1, _frozenEpochTotalCreditUsdMicros[epoch] - 1);
        }

        budget = emissionsGate.controllerEpochBudget(address(this), epoch);
        totalCreditUsdMicros = epochTotalCreditUsdMicros[epoch];
        _frozenEpochBudgets[epoch] = budget + 1;
        _frozenEpochTotalCreditUsdMicros[epoch] = totalCreditUsdMicros + 1;
    }

    function _resolveAgentOwner(uint256 agentId) private view returns (address) {
        address identityRegistry = registry.identityRegistry();
        if (identityRegistry == address(0) || identityRegistry.code.length == 0) revert UnknownAgent();
        try IERC8004Registry(identityRegistry).ownerOf(agentId) returns (address owner) {
            if (owner == address(0)) revert UnknownAgent();
            return owner;
        } catch {
            revert UnknownAgent();
        }
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

    function _applyAttestationPenalty(uint256 agentId, Verdict verdict, uint16 modelShareBps) private {
        if (verdict == Verdict.UNDETERMINED) return;
        uint16 nextPenalty = verdict == Verdict.DIFF ? modelShareBps : 0;
        if (_agentPointsPenaltyBps[agentId] == nextPenalty) return;
        _agentPointsPenaltyBps[agentId] = nextPenalty;
        emit AgentPointsPenaltySet(agentId, nextPenalty);
    }

    function _validateResult(VerificationResult calldata result) private pure {
        if (result.agentId == 0 || result.serviceHash == bytes32(0)) revert InvalidValue();
        if (result.verdict == Verdict.UNKNOWN || uint8(result.verdict) > uint8(Verdict.UNDETERMINED)) {
            revert InvalidVerdict();
        }
        if (result.modelShareBps > BPS_DENOMINATOR) revert InvalidModelShare();
        if (result.verdict != Verdict.DIFF && result.modelShareBps != 0) revert InvalidModelShare();
    }

    function _applyKeepBps(uint256 amount, uint256 keepBps) private pure returns (uint256) {
        return Math.mulDiv(amount, keepBps, BPS_DENOMINATOR);
    }
}
