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
    uint32 public override maxCreditsPerVerifierPerEpoch = 100;

    mapping(bytes32 auditId => bool submitted) private _submittedAudits;
    mapping(uint256 agentId => uint16 penaltyBps) private _agentPointsPenaltyBps;

    mapping(uint256 epoch => mapping(address verifier => uint256 credits)) public override epochCredits;
    mapping(uint256 epoch => uint256 credits) public override epochTotalCredits;

    mapping(uint256 epoch => bool settled) public override epochRemainderSettled;

    event VerifierApprovalSet(address indexed verifier, bool approved);
    event MaxCreditsPerVerifierPerEpochSet(uint32 maximum);
    event AttestationSubmitted(
        bytes32 indexed auditId,
        address indexed verifier,
        uint256 indexed agentId,
        bytes32 serviceHash,
        Verdict verdict,
        uint16 modelShareBps,
        bytes32 evidenceHash,
        uint32 probeCount,
        bool credited,
        uint256 epoch
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
    error AuditAlreadyExists();
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
        firstRewardedEpoch = emissionsGate.effectiveEpoch();
    }

    function setVerifier(address verifier, bool approved) external override onlyOwner {
        if (verifier == address(0)) revert InvalidAddress();
        approvedVerifiers[verifier] = approved;
        emit VerifierApprovalSet(verifier, approved);
    }

    function setMaxCreditsPerVerifierPerEpoch(uint32 maximum) external override onlyOwner {
        if (maximum == 0) revert InvalidValue();
        maxCreditsPerVerifierPerEpoch = maximum;
        emit MaxCreditsPerVerifierPerEpochSet(maximum);
    }

    function submitVerificationResult(
        bytes32 auditId,
        uint256 agentId,
        bytes32 serviceHash,
        Verdict verdict,
        uint256 expectedEpoch,
        uint16 modelShareBps,
        uint32 probeCount,
        bytes32 evidenceHash
    ) external override onlyApprovedVerifier {
        if (auditId == bytes32(0) || agentId == 0 || serviceHash == bytes32(0) || evidenceHash == bytes32(0)) {
            revert InvalidValue();
        }
        if (_submittedAudits[auditId]) revert AuditAlreadyExists();
        if (verdict == Verdict.UNKNOWN || uint8(verdict) > uint8(Verdict.UNDETERMINED)) revert InvalidVerdict();
        if (modelShareBps > BPS_DENOMINATOR) revert InvalidModelShare();
        if (verdict != Verdict.DIFF && modelShareBps != 0) revert InvalidModelShare();
        address seller = _resolveAgentOwner(agentId);
        if (seller == msg.sender) revert SelfAudit();

        uint256 epoch = currentEpoch();
        if (epoch != expectedEpoch) revert EpochChanged();
        _submittedAudits[auditId] = true;
        _applyAttestationPenalty(agentId, verdict, modelShareBps);

        bool credited = epochCredits[epoch][msg.sender] < maxCreditsPerVerifierPerEpoch;
        if (credited) {
            epochCredits[epoch][msg.sender]++;
            epochTotalCredits[epoch]++;
        }

        emit AttestationSubmitted(
            auditId, msg.sender, agentId, serviceHash, verdict, modelShareBps, evidenceHash, probeCount, credited, epoch
        );
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
        uint256 credits = epochCredits[epoch][msg.sender];
        if (credits == 0) revert NothingToClaim();
        uint256 budget = emissionsGate.controllerEpochBudget(address(this), epoch);
        uint256 totalCredits = epochTotalCredits[epoch];
        if (totalCredits == 0) revert NothingToClaim();

        uint256 amount = Math.mulDiv(budget, credits, totalCredits);
        epochCredits[epoch][msg.sender] = 0;
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
        uint256 budget = emissionsGate.controllerEpochBudget(address(this), epoch);
        uint256 totalCredits = epochTotalCredits[epoch];
        if (totalCredits != 0 || budget == 0) revert NothingToSettle();

        epochRemainderSettled[epoch] = true;
        (burnedAmount, reserveAmount) = emissionsGate.claimRemainder(epoch, emissionsGate.emissionsReserve(), budget);
        emit VerifierEpochRemainderSettled(epoch, budget);
    }

    function pendingVerifierReward(uint256 epoch, address verifier) external view override returns (uint256) {
        if (epoch < firstRewardedEpoch || epoch >= currentEpoch()) return 0;
        uint256 credits = epochCredits[epoch][verifier];
        if (credits == 0) return 0;
        uint256 totalCredits = verifierEpochTotalCredits(epoch);
        if (totalCredits == 0) return 0;
        return Math.mulDiv(verifierEpochBudget(epoch), credits, totalCredits);
    }

    function verifierEpochBudget(uint256 epoch) public view override returns (uint256) {
        return emissionsGate.controllerEpochBudget(address(this), epoch);
    }

    function verifierEpochTotalCredits(uint256 epoch) public view override returns (uint256) {
        return epochTotalCredits[epoch];
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

    function _applyKeepBps(uint256 amount, uint256 keepBps) private pure returns (uint256) {
        return (amount / BPS_DENOMINATOR) * keepBps + ((amount % BPS_DENOMINATOR) * keepBps) / BPS_DENOMINATOR;
    }
}
