// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";
import { Vm } from "forge-std/Vm.sol";

import { AntseedRegistry } from "../../core/AntseedRegistry.sol";
import { AntseedEmissionsGate } from "../../emissions/AntseedEmissionsGate.sol";
import { IAntseedVerification } from "../../interfaces/IAntseedVerification.sol";
import { AntseedVerification } from "../../verification/AntseedVerification.sol";
import { MockERC8004Registry } from "../mocks/MockERC8004Registry.sol";

contract AntseedVerifierRegistryTest is Test {
    uint256 private constant GENESIS = 1_775_728_461;
    address private constant ANTS_TOKEN = 0xa87EE81b2C0Bc659307ca2D9ffdC38514DD85263;
    bytes32 private constant SERVICE_HASH = keccak256("gpt-5.6-sol");
    bytes32 private constant OTHER_SERVICE_HASH = keccak256("gpt-5.6-luna");

    address private verifier = address(0xA11CE);
    address private secondVerifier = address(0xB0B);
    address private seller = address(0xCAFE);

    AntseedRegistry private registry;
    AntseedVerification private verification;
    MockERC8004Registry private identityRegistry;
    uint256 private agentId;

    function setUp() public {
        vm.warp(GENESIS + 8 days);
        registry = new AntseedRegistry();
        deployCodeTo("ANTSToken.sol:ANTSToken", ANTS_TOKEN);
        registry.setAntsToken(ANTS_TOKEN);
        registry.setTeamWallet(address(0x1111));
        registry.setProtocolReserve(address(0x2222));
        identityRegistry = new MockERC8004Registry();
        registry.setIdentityRegistry(address(identityRegistry));
        AntseedEmissionsGate gate = new AntseedEmissionsGate(address(0x1111), address(0x2222), 15_000, 15_000);
        verification = new AntseedVerification(address(registry), address(gate));
        verification.setVerifier(verifier, true);
        verification.setVerifier(secondVerifier, true);
        vm.prank(seller);
        agentId = identityRegistry.register();
    }

    function test_submitCreditsVerifier() public {
        bytes32 auditId = keccak256("audit-1");
        _submit(verifier, auditId, agentId, SERVICE_HASH, IAntseedVerification.Verdict.SAME, 0);

        assertEq(verification.epochCredits(verification.currentEpoch(), verifier), 1);
        assertEq(verification.epochTotalCredits(verification.currentEpoch()), 1);
    }

    function test_attestationsRemainAvailableAsCanonicalEvents() public {
        vm.recordLogs();
        _submit(verifier, keccak256("event-a"), agentId, SERVICE_HASH, IAntseedVerification.Verdict.SAME, 0);
        _submit(verifier, keccak256("event-b"), agentId, SERVICE_HASH, IAntseedVerification.Verdict.DIFF, 2_500);

        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 attestationTopic =
            keccak256("AttestationSubmitted(bytes32,address,uint256,bytes32,uint8,uint16,bytes32,uint32,bool,uint256)");
        uint256 attestationEvents;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics.length != 0 && logs[i].topics[0] == attestationTopic) attestationEvents++;
        }
        assertEq(attestationEvents, 2);
    }

    function test_repeatedAuditsEarnCreditsUntilConfiguredEpochCap() public {
        verification.setMaxCreditsPerVerifierPerEpoch(2);
        _submit(verifier, keccak256("audit-a"), agentId, SERVICE_HASH, IAntseedVerification.Verdict.SAME, 0);
        _submit(verifier, keccak256("audit-b"), agentId, SERVICE_HASH, IAntseedVerification.Verdict.DIFF, 2_500);
        _submit(verifier, keccak256("audit-c"), agentId, SERVICE_HASH, IAntseedVerification.Verdict.SAME, 0);

        assertEq(verification.agentPointsPenaltyBps(agentId), 0);
        assertEq(verification.epochCredits(verification.currentEpoch(), verifier), 2);
        assertEq(verification.epochTotalCredits(verification.currentEpoch()), 2);
    }

    function test_epochCreditCapIsOwnerConfigurableAndMustBeNonzero() public {
        verification.setMaxCreditsPerVerifierPerEpoch(7);
        assertEq(verification.maxCreditsPerVerifierPerEpoch(), 7);

        vm.expectRevert(AntseedVerification.InvalidValue.selector);
        verification.setMaxCreditsPerVerifierPerEpoch(0);
    }

    function test_allFinalVerdictsCanEarnCredits() public {
        _submit(verifier, keccak256("same"), agentId, SERVICE_HASH, IAntseedVerification.Verdict.SAME, 0);
        _submit(verifier, keccak256("diff"), agentId, SERVICE_HASH, IAntseedVerification.Verdict.DIFF, 2_500);
        _submit(
            verifier, keccak256("undetermined"), agentId, SERVICE_HASH, IAntseedVerification.Verdict.UNDETERMINED, 0
        );
        assertEq(verification.epochCredits(verification.currentEpoch(), verifier), 3);
    }

    function test_latestConclusiveAuditFromAnyVerifierControlsPenalty() public {
        _submit(verifier, keccak256("diff"), agentId, SERVICE_HASH, IAntseedVerification.Verdict.DIFF, 2_500);
        assertEq(verification.agentPointsPenaltyBps(agentId), 2_500);

        _submit(secondVerifier, keccak256("same"), agentId, SERVICE_HASH, IAntseedVerification.Verdict.SAME, 0);
        assertEq(verification.agentPointsPenaltyBps(agentId), 0);
    }

    function test_zeroProbeCountAndZeroShareDiffAreAccepted() public {
        bytes32 auditId = keccak256("zero");
        vm.prank(verifier);
        verification.submitVerificationResult(
            auditId,
            agentId,
            SERVICE_HASH,
            IAntseedVerification.Verdict.DIFF,
            _currentEpoch(),
            0,
            0,
            keccak256("zero-evidence")
        );

        assertEq(verification.epochCredits(verification.currentEpoch(), verifier), 1);
        assertEq(verification.agentPointsPenaltyBps(agentId), 0);
    }

    function test_rejectsResultAfterExpectedEpochChanges() public {
        uint256 expectedEpoch = _currentEpoch();
        vm.warp(block.timestamp + 7 days);
        vm.prank(verifier);
        vm.expectRevert(AntseedVerification.EpochChanged.selector);
        verification.submitVerificationResult(
            keccak256("stale"),
            agentId,
            SERVICE_HASH,
            IAntseedVerification.Verdict.SAME,
            expectedEpoch,
            0,
            100,
            keccak256("stale-evidence")
        );
    }

    function test_undeterminedLeavesPenaltyUnchanged() public {
        _submit(verifier, keccak256("diff"), agentId, SERVICE_HASH, IAntseedVerification.Verdict.DIFF, 2_500);
        _submit(
            verifier, keccak256("undetermined"), agentId, SERVICE_HASH, IAntseedVerification.Verdict.UNDETERMINED, 0
        );

        assertEq(verification.agentPointsPenaltyBps(agentId), 2_500);
    }

    function test_latestConclusiveAuditAcrossServicesControlsAgentPenalty() public {
        _submit(verifier, keccak256("diff-one"), agentId, SERVICE_HASH, IAntseedVerification.Verdict.DIFF, 2_000);
        _submit(
            secondVerifier, keccak256("diff-two"), agentId, OTHER_SERVICE_HASH, IAntseedVerification.Verdict.DIFF, 3_000
        );
        assertEq(verification.agentPointsPenaltyBps(agentId), 3_000);
    }

    function test_rejectsDuplicateUnknownSelfAndInvalidInputs() public {
        bytes32 auditId = keccak256("validation");
        _submit(verifier, auditId, agentId, SERVICE_HASH, IAntseedVerification.Verdict.SAME, 0);

        vm.prank(verifier);
        vm.expectRevert(AntseedVerification.AuditAlreadyExists.selector);
        verification.submitVerificationResult(
            auditId,
            agentId,
            SERVICE_HASH,
            IAntseedVerification.Verdict.SAME,
            _currentEpoch(),
            0,
            100,
            keccak256("duplicate")
        );

        vm.prank(verifier);
        vm.expectRevert(AntseedVerification.UnknownAgent.selector);
        verification.submitVerificationResult(
            keccak256("unknown"),
            999,
            SERVICE_HASH,
            IAntseedVerification.Verdict.SAME,
            _currentEpoch(),
            0,
            100,
            keccak256("unknown-evidence")
        );

        verification.setVerifier(seller, true);
        vm.prank(seller);
        vm.expectRevert(AntseedVerification.SelfAudit.selector);
        verification.submitVerificationResult(
            keccak256("self"),
            agentId,
            SERVICE_HASH,
            IAntseedVerification.Verdict.SAME,
            _currentEpoch(),
            0,
            100,
            keccak256("self-evidence")
        );

        vm.prank(verifier);
        vm.expectRevert(AntseedVerification.InvalidModelShare.selector);
        verification.submitVerificationResult(
            keccak256("bad-share"),
            agentId,
            SERVICE_HASH,
            IAntseedVerification.Verdict.SAME,
            _currentEpoch(),
            1,
            100,
            keccak256("bad-share-evidence")
        );
    }

    function _submit(
        address caller,
        bytes32 auditId,
        uint256 targetAgentId,
        bytes32 serviceHash,
        IAntseedVerification.Verdict verdict,
        uint16 modelShareBps
    ) private {
        vm.prank(caller);
        verification.submitVerificationResult(
            auditId,
            targetAgentId,
            serviceHash,
            verdict,
            _currentEpoch(),
            modelShareBps,
            100,
            keccak256(abi.encode(auditId, caller))
        );
    }

    function _currentEpoch() private view returns (uint256) {
        return (block.timestamp - GENESIS) / 7 days;
    }
}
