// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";
import { Vm } from "forge-std/Vm.sol";

import { AntseedRegistry } from "../../core/AntseedRegistry.sol";
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

    AntseedVerification private verification;
    MockERC8004Registry private identityRegistry;
    uint256 private agentId;

    function setUp() public {
        vm.warp(GENESIS + 8 days);
        AntseedRegistry registry = new AntseedRegistry();
        deployCodeTo("ANTSToken.sol:ANTSToken", ANTS_TOKEN);
        registry.setAntsToken(ANTS_TOKEN);
        registry.setTeamWallet(address(0x1111));
        registry.setProtocolReserve(address(0x2222));
        identityRegistry = new MockERC8004Registry();
        registry.setIdentityRegistry(address(identityRegistry));
        verification = new AntseedVerification(address(registry));
        verification.setVerifier(verifier, true);
        verification.setVerifier(secondVerifier, true);
        vm.prank(seller);
        agentId = identityRegistry.register();
    }

    function test_submitBundleStoresMetadataForFutureAccounting() public {
        bytes32 evidenceHash = keccak256("bundle-1");
        _submit(verifier, evidenceHash, _oneResult(agentId, SERVICE_HASH, IAntseedVerification.Verdict.SAME, 0));

        IAntseedVerification.VerificationBundle memory bundle = verification.verificationBundle(evidenceHash);
        assertEq(bundle.verifier, verifier);
        assertEq(bundle.submittedAt, block.timestamp);
        assertEq(bundle.resultCount, 1);
        assertEq(bundle.evidenceUri, "");
    }

    function test_emitsOneBundleEventAndOneResultEventPerSeller() public {
        IAntseedVerification.VerificationResult[] memory results = new IAntseedVerification.VerificationResult[](2);
        results[0] = _result(agentId, SERVICE_HASH, IAntseedVerification.Verdict.SAME, 0);
        results[1] = _result(_register(address(0xD00D)), SERVICE_HASH, IAntseedVerification.Verdict.DIFF, 2_500);

        vm.recordLogs();
        _submit(verifier, keccak256("events"), results);

        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 bundleTopic = keccak256("VerificationBundleSubmitted(bytes32,address,uint32,string)");
        bytes32 resultTopic = keccak256("VerificationResultSubmitted(bytes32,uint256,bytes32,uint8,uint16)");
        uint256 bundleEvents;
        uint256 resultEvents;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics.length == 0) continue;
            if (logs[i].topics[0] == bundleTopic) bundleEvents++;
            if (logs[i].topics[0] == resultTopic) resultEvents++;
        }
        assertEq(bundleEvents, 1);
        assertEq(resultEvents, 2);
    }

    function test_emitsIpfsEvidenceUriInBundleEvent() public {
        bytes32 evidenceHash = keccak256("ipfs-evidence");
        string memory evidenceUri = "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3r3eifqeedsvt2eubqtskghpm";
        vm.recordLogs();
        _submitWithUri(
            verifier, evidenceHash, evidenceUri, _oneResult(agentId, SERVICE_HASH, IAntseedVerification.Verdict.SAME, 0)
        );

        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 bundleTopic = keccak256("VerificationBundleSubmitted(bytes32,address,uint32,string)");
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics.length == 0 || logs[i].topics[0] != bundleTopic) continue;
            (, string memory emittedUri) = abi.decode(logs[i].data, (uint32, string));
            assertEq(emittedUri, evidenceUri);
            return;
        }
        fail("bundle event not emitted");
    }

    function test_rejectsInvalidAndOversizedEvidenceUris() public {
        IAntseedVerification.VerificationResult[] memory results =
            _oneResult(agentId, SERVICE_HASH, IAntseedVerification.Verdict.SAME, 0);

        vm.prank(verifier);
        vm.expectRevert(AntseedVerification.InvalidEvidenceUri.selector);
        verification.submitVerificationBundle(keccak256("https-evidence"), "https://example.invalid/evidence", results);

        vm.prank(verifier);
        vm.expectRevert(AntseedVerification.InvalidEvidenceUri.selector);
        verification.submitVerificationBundle(keccak256("empty-cid"), "ipfs://", results);

        vm.prank(verifier);
        vm.expectRevert(AntseedVerification.InvalidEvidenceUri.selector);
        verification.submitVerificationBundle(
            keccak256("oversized-uri"), string.concat("ipfs://", string(new bytes(194))), results
        );
    }

    function test_rejectsEmptyBundles() public {
        IAntseedVerification.VerificationResult[] memory results = new IAntseedVerification.VerificationResult[](0);

        vm.prank(verifier);
        vm.expectRevert(AntseedVerification.InvalidValue.selector);
        verification.submitVerificationBundle(keccak256("empty-bundle"), "", results);
    }

    function test_multipleBundlesUpdateVerdictsWithoutRewardAccounting() public {
        _submit(
            verifier, keccak256("bundle-a"), _oneResult(agentId, SERVICE_HASH, IAntseedVerification.Verdict.SAME, 0)
        );
        _submit(
            verifier, keccak256("bundle-b"), _oneResult(agentId, SERVICE_HASH, IAntseedVerification.Verdict.DIFF, 2_500)
        );

        assertEq(verification.activeAgentDiffVerifierCount(agentId), 1);
        assertEq(verification.activeServiceDiffVerifierCount(agentId, SERVICE_HASH), 1);
    }

    function test_onlyOwnerCanConfigureAndOnlyApprovedVerifiersCanSubmit() public {
        address unauthorized = address(0xBAD);
        vm.startPrank(unauthorized);
        vm.expectRevert();
        verification.setVerifier(unauthorized, true);
        vm.expectRevert(AntseedVerification.NotApprovedVerifier.selector);
        verification.submitVerificationBundle(
            keccak256("unauthorized-evidence"),
            "",
            _oneResult(agentId, SERVICE_HASH, IAntseedVerification.Verdict.SAME, 0)
        );
        vm.stopPrank();
    }

    function test_allFinalVerdictsCanBeRegistered() public {
        IAntseedVerification.VerificationResult[] memory results = new IAntseedVerification.VerificationResult[](3);
        results[0] = _result(agentId, SERVICE_HASH, IAntseedVerification.Verdict.SAME, 0);
        results[1] = _result(_register(address(0xD00D)), SERVICE_HASH, IAntseedVerification.Verdict.DIFF, 2_500);
        results[2] = _result(_register(address(0xF00D)), SERVICE_HASH, IAntseedVerification.Verdict.UNDETERMINED, 0);
        _submit(verifier, keccak256("all-verdicts"), results);
        assertTrue(verification.isVerificationSubmitted(keccak256("all-verdicts")));
    }

    function test_zeroShareDiffIsAcceptedWithoutClearingVerdict() public {
        _submit(
            verifier,
            keccak256("initial-diff"),
            _oneResult(agentId, SERVICE_HASH, IAntseedVerification.Verdict.DIFF, 2_500)
        );
        _submit(verifier, keccak256("zero"), _oneResult(agentId, SERVICE_HASH, IAntseedVerification.Verdict.DIFF, 0));

        assertEq(verification.activeAgentDiffVerifierCount(agentId), 1);
        assertEq(verification.activeServiceDiffVerifierCount(agentId, SERVICE_HASH), 1);
        _assertLatest(agentId, SERVICE_HASH, verifier, IAntseedVerification.Verdict.DIFF);
    }

    function test_undeterminedRetractsSameServiceDiff() public {
        _submit(
            verifier, keccak256("diff"), _oneResult(agentId, SERVICE_HASH, IAntseedVerification.Verdict.DIFF, 2_500)
        );
        _submit(
            verifier,
            keccak256("undetermined"),
            _oneResult(agentId, SERVICE_HASH, IAntseedVerification.Verdict.UNDETERMINED, 0)
        );

        assertEq(verification.activeAgentDiffVerifierCount(agentId), 0);
        assertEq(verification.activeServiceDiffVerifierCount(agentId, SERVICE_HASH), 0);
        _assertLatest(agentId, SERVICE_HASH, verifier, IAntseedVerification.Verdict.UNDETERMINED);
    }

    function test_oneVerifierCountsOnceAcrossMultipleServices() public {
        _submit(
            verifier, keccak256("diff-one"), _oneResult(agentId, SERVICE_HASH, IAntseedVerification.Verdict.DIFF, 2_000)
        );
        _submit(
            verifier,
            keccak256("diff-two"),
            _oneResult(agentId, OTHER_SERVICE_HASH, IAntseedVerification.Verdict.DIFF, 3_000)
        );

        assertEq(verification.activeAgentDiffVerifierCount(agentId), 1);
        assertEq(verification.activeServiceDiffVerifierCount(agentId, SERVICE_HASH), 1);
        assertEq(verification.activeServiceDiffVerifierCount(agentId, OTHER_SERVICE_HASH), 1);
    }

    function test_twoDistinctDiffVerifiersAreCountedPerServiceAndAgent() public {
        _submit(
            verifier, keccak256("diff-one"), _oneResult(agentId, SERVICE_HASH, IAntseedVerification.Verdict.DIFF, 2_000)
        );
        _submit(
            secondVerifier,
            keccak256("diff-two"),
            _oneResult(agentId, SERVICE_HASH, IAntseedVerification.Verdict.DIFF, 3_000)
        );

        assertEq(verification.activeAgentDiffVerifierCount(agentId), 2);
        assertEq(verification.activeServiceDiffVerifierCount(agentId, SERVICE_HASH), 2);
    }

    function test_sameServiceRetractionRemovesOnlyRetractingVerifier() public {
        _submit(
            verifier, keccak256("diff-one"), _oneResult(agentId, SERVICE_HASH, IAntseedVerification.Verdict.DIFF, 2_000)
        );
        _submit(
            secondVerifier,
            keccak256("diff-two"),
            _oneResult(agentId, SERVICE_HASH, IAntseedVerification.Verdict.DIFF, 3_000)
        );
        _submit(
            verifier, keccak256("same-one"), _oneResult(agentId, SERVICE_HASH, IAntseedVerification.Verdict.SAME, 0)
        );

        assertEq(verification.activeAgentDiffVerifierCount(agentId), 1);
        assertEq(verification.activeServiceDiffVerifierCount(agentId, SERVICE_HASH), 1);
        _assertLatest(agentId, SERVICE_HASH, verifier, IAntseedVerification.Verdict.SAME);
        _assertLatest(agentId, SERVICE_HASH, secondVerifier, IAntseedVerification.Verdict.DIFF);
    }

    function test_crossServiceSameCannotClearStandingDiff() public {
        _submit(
            verifier, keccak256("diff"), _oneResult(agentId, SERVICE_HASH, IAntseedVerification.Verdict.DIFF, 2_000)
        );
        _submit(
            verifier,
            keccak256("same-other"),
            _oneResult(agentId, OTHER_SERVICE_HASH, IAntseedVerification.Verdict.SAME, 0)
        );

        assertEq(verification.activeAgentDiffVerifierCount(agentId), 1);
        assertEq(verification.activeServiceDiffVerifierCount(agentId, SERVICE_HASH), 1);
        assertEq(verification.activeServiceDiffVerifierCount(agentId, OTHER_SERVICE_HASH), 0);
        _assertLatest(agentId, SERVICE_HASH, verifier, IAntseedVerification.Verdict.DIFF);
    }

    function test_ownerRemediationUpdatesServiceAndAgentCounts() public {
        _submit(
            verifier, keccak256("diff-one"), _oneResult(agentId, SERVICE_HASH, IAntseedVerification.Verdict.DIFF, 2_000)
        );
        _submit(
            verifier,
            keccak256("diff-two"),
            _oneResult(agentId, OTHER_SERVICE_HASH, IAntseedVerification.Verdict.DIFF, 3_000)
        );
        _submit(
            secondVerifier,
            keccak256("diff-three"),
            _oneResult(agentId, SERVICE_HASH, IAntseedVerification.Verdict.DIFF, 4_000)
        );

        verification.clearVerifierVerdict(agentId, SERVICE_HASH, verifier);
        assertEq(verification.activeAgentDiffVerifierCount(agentId), 2);
        assertEq(verification.activeServiceDiffVerifierCount(agentId, SERVICE_HASH), 1);
        _assertLatest(agentId, SERVICE_HASH, verifier, IAntseedVerification.Verdict.UNKNOWN);

        verification.clearVerifierVerdict(agentId, OTHER_SERVICE_HASH, verifier);
        assertEq(verification.activeAgentDiffVerifierCount(agentId), 1);
        assertEq(verification.activeServiceDiffVerifierCount(agentId, OTHER_SERVICE_HASH), 0);
    }

    function test_revokedVerifierCannotSubmitAndHistoricalVerdictRemains() public {
        _submit(
            verifier, keccak256("diff"), _oneResult(agentId, SERVICE_HASH, IAntseedVerification.Verdict.DIFF, 2_000)
        );
        verification.setVerifier(verifier, false);

        assertEq(verification.activeAgentDiffVerifierCount(agentId), 1);
        _assertLatest(agentId, SERVICE_HASH, verifier, IAntseedVerification.Verdict.DIFF);
        vm.prank(verifier);
        vm.expectRevert(AntseedVerification.NotApprovedVerifier.selector);
        verification.submitVerificationBundle(
            keccak256("retracted-after-revocation"),
            "",
            _oneResult(agentId, SERVICE_HASH, IAntseedVerification.Verdict.SAME, 0)
        );
    }

    function test_onlyOwnerCanRemediateAndUnknownVerdictCannotBeCleared() public {
        _submit(
            verifier, keccak256("diff"), _oneResult(agentId, SERVICE_HASH, IAntseedVerification.Verdict.DIFF, 2_000)
        );

        vm.prank(address(0xBAD));
        vm.expectRevert();
        verification.clearVerifierVerdict(agentId, SERVICE_HASH, verifier);

        verification.clearVerifierVerdict(agentId, SERVICE_HASH, verifier);
        vm.expectRevert(AntseedVerification.NoStoredVerdict.selector);
        verification.clearVerifierVerdict(agentId, SERVICE_HASH, verifier);
    }

    function test_rejectsDuplicateEvidenceUnknownSelfDuplicateResultAndInvalidInputs() public {
        bytes32 evidenceHash = keccak256("validation");
        _submit(verifier, evidenceHash, _oneResult(agentId, SERVICE_HASH, IAntseedVerification.Verdict.SAME, 0));
        assertTrue(verification.isVerificationSubmitted(evidenceHash));

        vm.prank(verifier);
        vm.expectRevert(AntseedVerification.VerificationAlreadySubmitted.selector);
        verification.submitVerificationBundle(
            evidenceHash, "", _oneResult(agentId, SERVICE_HASH, IAntseedVerification.Verdict.SAME, 0)
        );

        vm.prank(verifier);
        vm.expectRevert(AntseedVerification.UnknownAgent.selector);
        verification.submitVerificationBundle(
            keccak256("unknown-evidence"), "", _oneResult(999, SERVICE_HASH, IAntseedVerification.Verdict.SAME, 0)
        );

        verification.setVerifier(seller, true);
        vm.prank(seller);
        vm.expectRevert(AntseedVerification.SelfAudit.selector);
        verification.submitVerificationBundle(
            keccak256("self-evidence"), "", _oneResult(agentId, SERVICE_HASH, IAntseedVerification.Verdict.SAME, 0)
        );

        vm.prank(verifier);
        vm.expectRevert(AntseedVerification.InvalidModelShare.selector);
        verification.submitVerificationBundle(
            keccak256("bad-share-evidence"), "", _oneResult(agentId, SERVICE_HASH, IAntseedVerification.Verdict.SAME, 1)
        );
    }

    function _submit(address caller, bytes32 evidenceHash, IAntseedVerification.VerificationResult[] memory results)
        private
    {
        _submitWithUri(caller, evidenceHash, "", results);
    }

    function _submitWithUri(
        address caller,
        bytes32 evidenceHash,
        string memory evidenceUri,
        IAntseedVerification.VerificationResult[] memory results
    ) private {
        vm.prank(caller);
        verification.submitVerificationBundle(evidenceHash, evidenceUri, results);
    }

    function _oneResult(
        uint256 targetAgentId,
        bytes32 serviceHash,
        IAntseedVerification.Verdict verdict,
        uint16 modelShareBps
    ) private pure returns (IAntseedVerification.VerificationResult[] memory results) {
        results = new IAntseedVerification.VerificationResult[](1);
        results[0] = _result(targetAgentId, serviceHash, verdict, modelShareBps);
    }

    function _result(
        uint256 targetAgentId,
        bytes32 serviceHash,
        IAntseedVerification.Verdict verdict,
        uint16 modelShareBps
    ) private pure returns (IAntseedVerification.VerificationResult memory) {
        return IAntseedVerification.VerificationResult({
            agentId: targetAgentId,
            serviceHash: serviceHash,
            verdict: verdict,
            modelShareBps: modelShareBps
        });
    }

    function _assertLatest(
        uint256 targetAgentId,
        bytes32 serviceHash,
        address targetVerifier,
        IAntseedVerification.Verdict expectedVerdict
    ) private view {
        assertEq(verification.latestVerifierVerdict(targetAgentId, serviceHash, targetVerifier), uint8(expectedVerdict));
    }

    function _register(address owner) private returns (uint256 registeredAgentId) {
        vm.prank(owner);
        registeredAgentId = identityRegistry.register();
    }
}
