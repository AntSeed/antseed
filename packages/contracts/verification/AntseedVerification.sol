// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Ownable2Step } from "@openzeppelin/contracts/access/Ownable2Step.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import { IAntseedRegistry } from "../interfaces/IAntseedRegistry.sol";
import { IAntseedVerification } from "../interfaces/IAntseedVerification.sol";
import { IERC8004Registry } from "../interfaces/IERC8004Registry.sol";

contract AntseedVerification is IAntseedVerification, Ownable2Step, ReentrancyGuard {
    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant MAX_EVIDENCE_URI_BYTES = 200;
    IAntseedRegistry public immutable override registry;

    mapping(address verifier => bool approved) public override approvedVerifiers;
    mapping(bytes32 evidenceHash => VerificationBundle bundle) private _verificationBundles;
    mapping(uint256 agentId => mapping(bytes32 serviceHash => mapping(address verifier => Verdict verdict))) private
        _latestVerifierVerdicts;
    mapping(uint256 agentId => uint256 verifierCount) private _activeAgentDiffVerifierCounts;
    mapping(uint256 agentId => mapping(bytes32 serviceHash => uint256 verifierCount)) private
        _activeServiceDiffVerifierCounts;
    mapping(uint256 agentId => mapping(address verifier => uint256 serviceCount)) private
        _activeDiffServiceCountsByVerifier;

    event VerifierApprovalSet(address indexed verifier, bool approved);
    event VerificationBundleSubmitted(
        bytes32 indexed evidenceHash, address indexed verifier, uint32 resultCount, string evidenceUri
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

    error InvalidAddress();
    error InvalidValue();
    error NotApprovedVerifier();
    error InvalidVerdict();
    error InvalidModelShare();
    error VerificationAlreadySubmitted();
    error InvalidEvidenceUri();
    error UnknownAgent();
    error SelfAudit();
    error NoStoredVerdict();

    modifier onlyApprovedVerifier() {
        if (!approvedVerifiers[msg.sender]) revert NotApprovedVerifier();
        _;
    }

    constructor(address registry_) Ownable(msg.sender) {
        if (registry_ == address(0) || registry_.code.length == 0) revert InvalidAddress();
        registry = IAntseedRegistry(registry_);
    }

    function setVerifier(address verifier, bool approved) external override onlyOwner {
        if (verifier == address(0)) revert InvalidAddress();
        approvedVerifiers[verifier] = approved;
        emit VerifierApprovalSet(verifier, approved);
    }

    /// @notice Submits the audit for one model across multiple seller peers.
    function submitVerificationBundle(
        bytes32 evidenceHash,
        string calldata evidenceUri,
        VerificationResult[] calldata results
    ) external override onlyApprovedVerifier nonReentrant {
        if (evidenceHash == bytes32(0)) revert InvalidValue();
        if (results.length == 0 || results.length > type(uint32).max) revert InvalidValue();
        _validateEvidenceUri(evidenceUri);
        if (isVerificationSubmitted(evidenceHash)) revert VerificationAlreadySubmitted();

        for (uint256 i = 0; i < results.length; i++) {
            VerificationResult calldata result = results[i];
            _validateResult(result);
            if (_resolveAgentOwner(result.agentId) == msg.sender) revert SelfAudit();
        }

        _verificationBundles[evidenceHash] = VerificationBundle({
            verifier: msg.sender,
            submittedAt: uint64(block.timestamp),
            resultCount: uint32(results.length),
            evidenceUri: evidenceUri
        });

        emit VerificationBundleSubmitted(evidenceHash, msg.sender, uint32(results.length), evidenceUri);
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

    function isVerificationSubmitted(bytes32 evidenceHash) public view override returns (bool) {
        return _verificationBundles[evidenceHash].verifier != address(0);
    }

    function verificationBundle(bytes32 evidenceHash) external view override returns (VerificationBundle memory) {
        return _verificationBundles[evidenceHash];
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

    function _transitionVerifierVerdict(uint256 agentId, bytes32 serviceHash, address verifier, Verdict newVerdict)
        private
    {
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
