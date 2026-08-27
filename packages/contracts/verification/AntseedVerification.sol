// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Ownable2Step } from "@openzeppelin/contracts/access/Ownable2Step.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

import { IAntseedEmissionsGate } from "../interfaces/IAntseedEmissionsGate.sol";
import { IAntseedRegistry } from "../interfaces/IAntseedRegistry.sol";
import { IAntseedVerification } from "../interfaces/IAntseedVerification.sol";
import { IERC8004Registry } from "../interfaces/IERC8004Registry.sol";

contract AntseedVerification is IAntseedVerification, Ownable2Step, ReentrancyGuard {
    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant MAX_EVIDENCE_URI_BYTES = 200;
    IAntseedRegistry public immutable override registry;
    IAntseedEmissionsGate public immutable override emissionsGate;
    uint256 public immutable override firstRewardedEpoch;

    mapping(address verifier => bool approved) public override approvedVerifiers;

    /// @notice Credit weights use six-decimal USD micros: 1 credit = $1 = 1_000_000 units.
    /// @dev The default cap is 100 credits. Fractional credits remain exact, so $1.20 is 1_200_000 units.
    uint64 public override maxCreditUsdMicrosPerVerifierPerEpoch = 100_000_000;

    mapping(bytes32 evidenceHash => bool submitted) private _submittedVerifications;
    mapping(uint256 agentId => mapping(bytes32 serviceHash => mapping(address verifier => Verdict verdict)))
        private _latestVerifierVerdicts;
    mapping(uint256 agentId => uint256 verifierCount) private _activeAgentDiffVerifierCounts;
    mapping(uint256 agentId => mapping(bytes32 serviceHash => uint256 verifierCount))
        private _activeServiceDiffVerifierCounts;
    mapping(uint256 agentId => mapping(address verifier => uint256 serviceCount))
        private _activeDiffServiceCountsByVerifier;

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
        uint32 resultCount,
        string evidenceUri
    );
    event VerificationResultSubmitted(
        bytes32 indexed evidenceHash,
        uint256 indexed agentId,
        bytes32 indexed serviceHash,
        Verdict verdict,
        uint16 modelShareBps
    );
    event VerifierVerdictTransitioned(
        uint256 indexed agentId,
        bytes32 indexed serviceHash,
        address indexed verifier,
        Verdict previousVerdict,
        Verdict newVerdict
    );
    event VerifierVerdictRemediated(
        uint256 indexed agentId, bytes32 indexed serviceHash, address indexed verifier, Verdict previousVerdict
    );
    event VerifierRewardClaimed(uint256 indexed epoch, address indexed verifier, uint256 amount);
    event VerifierEpochRemainderSettled(uint256 indexed epoch, uint256 amount);

    error InvalidAddress();
    error InvalidValue();
    error NotApprovedVerifier();
    error InvalidVerdict();
    error InvalidModelShare();
    error EpochChanged();
    error VerificationAlreadySubmitted();
    error InvalidEvidenceUri();
    error UnknownAgent();
    error SelfAudit();
    error PreEffectiveEpoch();
    error EpochNotFinalized();
    error AlreadyClaimed();
    error NothingToClaim();
    error NothingToSettle();
    error NoStoredVerdict();

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
        string calldata evidenceUri,
        VerificationResult[] calldata results
    ) external override onlyApprovedVerifier nonReentrant {
        if (evidenceHash == bytes32(0)) revert InvalidValue();
        _validateEvidenceUri(evidenceUri);
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
            evidenceHash,
            msg.sender,
            epoch,
            totalAuditCostUsdMicros,
            awardedCreditUsdMicros,
            uint32(results.length),
            evidenceUri
        );
        for (uint256 i = 0; i < results.length; i++) {
            VerificationResult calldata result = results[i];
            _transitionVerifierVerdict(result.agentId, result.serviceHash, msg.sender, result.verdict);
            emit VerificationResultSubmitted(
                evidenceHash, result.agentId, result.serviceHash, result.verdict, result.modelShareBps
            );
        }
    }

    function _validateEvidenceUri(string calldata evidenceUri) private pure {
        bytes memory uri = bytes(evidenceUri);
        if (uri.length == 0) return;
        if (
            uri.length <= 7 || uri.length > MAX_EVIDENCE_URI_BYTES || uri[0] != bytes1("i") || uri[1] != bytes1("p")
                || uri[2] != bytes1("f") || uri[3] != bytes1("s") || uri[4] != bytes1(":") || uri[5] != bytes1("/")
                || uri[6] != bytes1("/")
        ) revert InvalidEvidenceUri();
    }

    function isVerificationSubmitted(bytes32 evidenceHash) external view override returns (bool) {
        return _submittedVerifications[evidenceHash];
    }

    function currentEpoch() public view override returns (uint256) {
        return emissionsGate.currentEpoch();
    }

    function activeAgentDiffVerifierCount(uint256 agentId) external view override returns (uint256) {
        return _activeAgentDiffVerifierCounts[agentId];
    }

    function activeServiceDiffVerifierCount(uint256 agentId, bytes32 serviceHash)
        external
        view
        override
        returns (uint256)
    {
        return _activeServiceDiffVerifierCounts[agentId][serviceHash];
    }

    function latestVerifierVerdict(uint256 agentId, bytes32 serviceHash, address verifier)
        external
        view
        override
        returns (uint8)
    {
        return uint8(_latestVerifierVerdicts[agentId][serviceHash][verifier]);
    }

    function clearVerifierVerdict(uint256 agentId, bytes32 serviceHash, address verifier) external override onlyOwner {
        if (agentId == 0 || serviceHash == bytes32(0)) revert InvalidValue();
        if (verifier == address(0)) revert InvalidAddress();

        Verdict previousVerdict = _latestVerifierVerdicts[agentId][serviceHash][verifier];
        if (previousVerdict == Verdict.UNKNOWN) revert NoStoredVerdict();
        _transitionVerifierVerdict(agentId, serviceHash, verifier, Verdict.UNKNOWN);
        emit VerifierVerdictRemediated(agentId, serviceHash, verifier, previousVerdict);
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

    function _transitionVerifierVerdict(
        uint256 agentId,
        bytes32 serviceHash,
        address verifier,
        Verdict newVerdict
    ) private {
        Verdict previousVerdict = _latestVerifierVerdicts[agentId][serviceHash][verifier];
        if (previousVerdict == newVerdict) return;

        if (previousVerdict == Verdict.DIFF) {
            uint256 activeServiceCount = _activeDiffServiceCountsByVerifier[agentId][verifier];
            _activeDiffServiceCountsByVerifier[agentId][verifier] = activeServiceCount - 1;
            _activeServiceDiffVerifierCounts[agentId][serviceHash] -= 1;
            if (activeServiceCount == 1) _activeAgentDiffVerifierCounts[agentId] -= 1;
        }

        if (newVerdict == Verdict.DIFF) {
            uint256 activeServiceCount = _activeDiffServiceCountsByVerifier[agentId][verifier];
            if (activeServiceCount == 0) _activeAgentDiffVerifierCounts[agentId] += 1;
            _activeDiffServiceCountsByVerifier[agentId][verifier] = activeServiceCount + 1;
            _activeServiceDiffVerifierCounts[agentId][serviceHash] += 1;
        }

        if (newVerdict == Verdict.UNKNOWN) {
            delete _latestVerifierVerdicts[agentId][serviceHash][verifier];
        } else {
            _latestVerifierVerdicts[agentId][serviceHash][verifier] = newVerdict;
        }
        emit VerifierVerdictTransitioned(agentId, serviceHash, verifier, previousVerdict, newVerdict);
    }

    function _validateResult(VerificationResult calldata result) private pure {
        if (result.agentId == 0 || result.serviceHash == bytes32(0)) revert InvalidValue();
        if (result.verdict == Verdict.UNKNOWN || uint8(result.verdict) > uint8(Verdict.UNDETERMINED)) {
            revert InvalidVerdict();
        }
        if (result.modelShareBps > BPS_DENOMINATOR) revert InvalidModelShare();
        if (result.verdict != Verdict.DIFF && result.modelShareBps != 0) revert InvalidModelShare();
    }

}
