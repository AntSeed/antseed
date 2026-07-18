// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

import { AntseedRegistry } from "../../core/AntseedRegistry.sol";
import { AntseedVerifierRegistry } from "../../verification/AntseedVerifierRegistry.sol";
import { IAntseedVerifierRegistry } from "../../interfaces/IAntseedVerifierRegistry.sol";
import { MockERC8004Registry } from "../mocks/MockERC8004Registry.sol";
import { ResponseAuthFixture } from "./ResponseAuthFixture.sol";

contract MockAnchoringEpochClock {
    uint256 public currentEpoch;

    function setCurrentEpoch(uint256 epoch) external {
        currentEpoch = epoch;
    }
}

/// @dev Transparent-audits anchoring flow: commit → anchor → attest → reveal.
///      Covers the on-chain Merkle root recomputation (`anchorExchangeBatch`
///      + `computeBatchRoot`), ON-CHAIN ResponseAuth signature verification
///      of every anchored record (signer must be the ERC-8004 owner of the
///      record's agentId; the payload's embedded hashes must match the
///      anchored ones), anchor-time delegate-credit accrual from the buyer
///      named inside each signed payload, the batch binding required by
///      `submitAttestation`, and the on-chain-verified probe-set opening
///      (`revealProbeSet`).
///
///      NOTE (cross-language fixtures): `computeBatchRoot`,
///      `responseAuthDigest` and `parseResponseAuthPayload` are public pure
///      precisely so the TypeScript mirrors (packages/node
///      src/verification/exchange-batch.ts and response-auth.ts) can be
///      cross-checked against the contract via `eth_call`. The pinned Merkle
///      roots (test_computeBatchRootMatchesPinnedCrossLanguageRoots) and the
///      pinned signing payload (test_pinnedCrossLanguageSigningPayload) are
///      replicated byte-for-byte on both sides — never change one without
///      re-pinning both.
contract AntseedVerifierAnchoringTest is Test, ResponseAuthFixture {
    AntseedRegistry registry;
    MockERC8004Registry identity;
    MockAnchoringEpochClock clock;
    AntseedVerifierRegistry verifierRegistry;

    address verifier = address(0x1001);
    address otherVerifier = address(0x1002);
    address outsider = address(0x1003);
    address sellerOwner = address(0x2001);
    address carrierX = address(0xCAB1);
    address carrierY = address(0xCAB2);

    /// @dev Signing keys for the sellers whose exchanges get anchored. The
    ///      registered ERC-8004 owner of each record agent is vm.addr(key).
    uint256 constant SELLER_A_KEY = 0xA11CE;
    uint256 constant SELLER_B_KEY = 0xB0B2;
    uint256 agentA;
    uint256 agentB;

    uint256 agentId; // attestation target
    bytes32 constant SERVICE_HASH = keccak256("anthropic/claude-opus-4");
    bytes32 constant EVIDENCE_HASH = keccak256("evidence");

    /// @dev Exact canonical probe-set JSON bytes, as produced by
    ///      canonicalJsonStringify({service, probes, nonce}) in
    ///      packages/fingerprints (keys sorted, no whitespace). The on-chain
    ///      commitment is a PLAIN sha256 over these UTF-8 bytes — no prefix.
    bytes constant PROBE_SET_JSON =
        '{"nonce":"9b1de2a4c0ffee00","probes":[{"consensus":42,"domain":"math","name":"probe-1","range":[40,44],"template":"How many ___ are there?","tolerance":{"mode":"abs","value":1}}],"service":"model:gpt-99"}';

    event ExchangeBatchAnchored(
        address indexed verifier,
        bytes32 indexed probeCommitment,
        bytes32 indexed batchRoot,
        uint32 recordCount,
        uint32 probeCount
    );
    event ProbeSetRevealed(address indexed verifier, bytes32 indexed probeCommitment, string packUri);
    event DelegateCreditsAccrued(
        address indexed verifier,
        bytes32 indexed probeCommitment,
        address indexed buyer,
        uint256 agentId,
        bytes32 serviceHash,
        uint32 credits
    );

    /// @dev Delegate target key of `agentId` under the fixture service.
    function _keyOf(uint256 agentId) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(agentId, SERVICE_HASH));
    }

    /// @dev Optional on-chain pointer to the off-chain response pack.
    string constant PACK_URI = "ipfs://bafyPackPointerForTransparentAudit";

    function setUp() public {
        vm.warp(1_700_000_000);

        registry = new AntseedRegistry();
        identity = new MockERC8004Registry();
        clock = new MockAnchoringEpochClock();
        clock.setCurrentEpoch(5);
        registry.setIdentityRegistry(address(identity));
        registry.setEmissions(address(clock));

        verifierRegistry = new AntseedVerifierRegistry(address(registry));
        verifierRegistry.setVerifier(verifier, true);
        verifierRegistry.setVerifier(otherVerifier, true);

        agentA = identity.register();
        identity.setOwner(agentA, vm.addr(SELLER_A_KEY));
        agentB = identity.register();
        identity.setOwner(agentB, vm.addr(SELLER_B_KEY));
        agentId = agentA;
    }

    // ─── Helpers ─────────────────────────────────────────────────────

    /// @dev Deterministic batch of `n` FULLY SIGNED exchange records for
    ///      agentA, self-carried by `verifier` (buyer == verifier → no
    ///      delegate accrual), one probe declared per record.
    function _signedBatch(uint256 n, bytes32 salt)
        internal
        view
        returns (
            IAntseedVerifierRegistry.ExchangeRecord[] memory records,
            bytes[] memory payloads,
            uint32[] memory counts
        )
    {
        (records, payloads, counts) = makeSignedBatch(n, agentA, SELLER_A_KEY, address(0x1001), salt);
    }

    /// @dev Synthetic (UNSIGNED) records — only for `computeBatchRoot` pure
    ///      tests and for reverts that fire before signature verification.
    function _records(uint256 n) internal pure returns (IAntseedVerifierRegistry.ExchangeRecord[] memory records) {
        records = new IAntseedVerifierRegistry.ExchangeRecord[](n);
        for (uint256 i = 0; i < n; i++) {
            records[i] = IAntseedVerifierRegistry.ExchangeRecord({
                agentId: i + 1,
                requestHash: keccak256(abi.encodePacked("request", i)),
                responseHash: keccak256(abi.encodePacked("response", i)),
                responseAuthSig: abi.encodePacked(
                    keccak256(abi.encodePacked("sig-r", i)),
                    keccak256(abi.encodePacked("sig-s", i)),
                    uint8(27 + (i % 2))
                )
            });
        }
    }

    function _ones(uint256 n) internal pure returns (uint32[] memory counts) {
        counts = new uint32[](n);
        for (uint256 i = 0; i < n; i++) {
            counts[i] = 1;
        }
    }

    function _emptyPayloads(uint256 n) internal pure returns (bytes[] memory payloads) {
        payloads = new bytes[](n);
    }

    function _leaf(IAntseedVerifierRegistry.ExchangeRecord memory record) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(record.agentId, record.requestHash, record.responseHash, keccak256(record.responseAuthSig))
        );
    }

    /// @dev Independent reference root: recursive level-by-level fold,
    ///      structured differently from the contract's in-place loop, so a
    ///      shared implementation bug cannot hide.
    function _referenceRoot(bytes32[] memory level) internal pure returns (bytes32) {
        if (level.length == 1) return level[0];
        bytes32[] memory next = new bytes32[]((level.length + 1) / 2);
        for (uint256 i = 0; i < next.length; i++) {
            uint256 left = 2 * i;
            uint256 right = left + 1;
            next[i] = right < level.length ? keccak256(bytes.concat(level[left], level[right])) : level[left];
        }
        return _referenceRoot(next);
    }

    function _referenceRootOf(IAntseedVerifierRegistry.ExchangeRecord[] memory records)
        internal
        pure
        returns (bytes32)
    {
        bytes32[] memory leaves = new bytes32[](records.length);
        for (uint256 i = 0; i < records.length; i++) {
            leaves[i] = _leaf(records[i]);
        }
        return _referenceRoot(leaves);
    }

    function _commit(address verifier_, bytes32 commitment) internal {
        vm.prank(verifier_);
        verifierRegistry.commitProbeSet(commitment);
    }

    /// @dev Anchor a fresh `n`-record signed batch (1 probe per record).
    function _anchorSigned(address verifier_, bytes32 commitment, uint256 n, bytes32 salt)
        internal
        returns (bytes32 root)
    {
        (
            IAntseedVerifierRegistry.ExchangeRecord[] memory records,
            bytes[] memory payloads,
            uint32[] memory counts
        ) = _signedBatch(n, salt);
        vm.prank(verifier_);
        root = verifierRegistry.anchorExchangeBatch(commitment, records, payloads, counts);
    }

    /// @dev Unpacked `batchAnchors` getter for assertion convenience.
    function _anchorOf(address verifier_, bytes32 root)
        internal
        view
        returns (uint64 anchoredAt, uint32 recordCount, uint32 probeCount)
    {
        (anchoredAt, recordCount, probeCount) = verifierRegistry.batchAnchors(verifier_, root);
    }

    function _attest(address verifier_, bytes32 commitment, bytes32 batchRoot) internal {
        vm.prank(verifier_);
        verifierRegistry.submitAttestation(agentId, SERVICE_HASH, 1, EVIDENCE_HASH, commitment, batchRoot, 10, 3);
    }

    // ─── Happy path ──────────────────────────────────────────────────

    function test_happyPathCommitAnchorAttestReveal() public {
        bytes32 commitment = sha256(PROBE_SET_JSON);
        assertTrue(commitment != bytes32(0));

        // 1. Commit (seal the probe set before it runs).
        _commit(verifier, commitment);
        assertEq(verifierRegistry.probeCommittedAt(verifier, commitment), uint64(block.timestamp));
        vm.warp(block.timestamp + 1);

        // 2. Anchor the exchange batch; the contract recomputes the root,
        //    verifies every seller signature, sums the per-record probe
        //    declarations (10 records bundling 24 probes) and accrues the
        //    carried probes to the carrier named in each signed payload.
        //    Records 0-4 (3+3+3+3+2 = 14 probes) are carried by carrierX;
        //    records 5-9 (2 probes each) are self-carried by the verifier
        //    and accrue nothing.
        IAntseedVerifierRegistry.ExchangeRecord[] memory records =
            new IAntseedVerifierRegistry.ExchangeRecord[](10);
        bytes[] memory payloads = new bytes[](10);
        uint32[] memory counts = new uint32[](10);
        for (uint256 i = 0; i < 10; i++) {
            address buyer = i < 5 ? carrierX : verifier;
            (records[i], payloads[i]) =
                makeSignedRecord(agentA, SELLER_A_KEY, buyer, keccak256(abi.encode("happy", i)));
            counts[i] = i < 4 ? 3 : 2;
        }
        bytes32 expectedRoot = _referenceRootOf(records);
        vm.expectEmit(true, true, true, true);
        emit DelegateCreditsAccrued(verifier, commitment, carrierX, agentA, SERVICE_HASH, 14);
        vm.expectEmit(true, true, true, true);
        emit ExchangeBatchAnchored(verifier, commitment, expectedRoot, 10, 24);
        vm.prank(verifier);
        bytes32 root = verifierRegistry.anchorExchangeBatch(commitment, records, payloads, counts);
        assertEq(root, expectedRoot, "returned root");
        (uint64 anchoredAt, uint32 recordCount, uint32 probeCount) = _anchorOf(verifier, root);
        assertEq(anchoredAt, uint64(block.timestamp), "anchoredAt");
        assertEq(verifierRegistry.commitmentBatchRoot(verifier, commitment), root, "batch commitment");
        assertEq(recordCount, 10, "record count");
        assertEq(probeCount, 24, "summed probe count");
        assertEq(
            verifierRegistry.commitmentDelegateAccrued(verifier, commitment, _keyOf(agentA), carrierX),
            14,
            "carrier accrual"
        );
        assertEq(
            verifierRegistry.commitmentDelegateAccrued(verifier, commitment, _keyOf(agentA), verifier),
            0,
            "self accrual"
        );

        // 3. Attest referencing the anchored batch (same second is allowed).
        _attest(verifier, commitment, root);
        assertTrue(verifierRegistry.commitmentAttested(verifier, commitment));

        // 4. Reveal the exact canonical probe-set bytes; on-chain opening.
        //    The event carries the on-chain pointer to the off-chain pack.
        vm.warp(block.timestamp + 1);
        vm.expectEmit(true, true, false, true);
        emit ProbeSetRevealed(verifier, commitment, PACK_URI);
        vm.prank(verifier);
        verifierRegistry.revealProbeSet(commitment, PROBE_SET_JSON, PACK_URI);
        assertEq(verifierRegistry.probeRevealedAt(verifier, commitment), uint64(block.timestamp), "revealedAt");
    }

    function test_multipleTargetsInBatchGrowCommitmentCount() public {
        bytes32 commitment = sha256(PROBE_SET_JSON);
        _commit(verifier, commitment);
        vm.warp(block.timestamp + 1);
        IAntseedVerifierRegistry.ExchangeRecord[] memory records = new IAntseedVerifierRegistry.ExchangeRecord[](20);
        bytes[] memory payloads = new bytes[](20);
        uint32[] memory counts = new uint32[](20);
        for (uint256 i = 0; i < 10; i++) {
            (records[i], payloads[i]) = makeSignedRecord(agentA, SELLER_A_KEY, verifier, keccak256(abi.encode("a", i)));
            (records[i + 10], payloads[i + 10]) =
                makeSignedRecord(agentB, SELLER_B_KEY, verifier, keccak256(abi.encode("b", i)));
            counts[i] = 1;
            counts[i + 10] = 1;
        }
        vm.prank(verifier);
        bytes32 root = verifierRegistry.anchorExchangeBatch(commitment, records, payloads, counts);

        vm.prank(verifier);
        verifierRegistry.submitAttestation(agentA, SERVICE_HASH, 1, EVIDENCE_HASH, commitment, root, 10, 3);
        vm.prank(verifier);
        verifierRegistry.submitAttestation(agentB, SERVICE_HASH, 2, EVIDENCE_HASH, commitment, root, 10, 3);
        assertTrue(verifierRegistry.commitmentAttested(verifier, commitment));
    }

    function test_attestationTargetMustAppearInSignedBatch() public {
        bytes32 commitment = _committed();
        bytes32 root = _anchorSigned(verifier, commitment, 10, "target-binding");
        uint256 unrelatedAgent = identity.register();
        identity.setOwner(unrelatedAgent, sellerOwner);

        vm.prank(verifier);
        vm.expectRevert(AntseedVerifierRegistry.TargetNotInBatch.selector);
        verifierRegistry.submitAttestation(unrelatedAgent, SERVICE_HASH, 1, EVIDENCE_HASH, commitment, root, 10, 3);
    }

    function test_batchTargetCanOnlyBeAttestedOnce() public {
        bytes32 commitment = _committed();
        bytes32 root = _anchorSigned(verifier, commitment, 10, "duplicate-target");

        vm.prank(verifier);
        verifierRegistry.submitAttestation(agentA, SERVICE_HASH, 1, EVIDENCE_HASH, commitment, root, 10, 3);
        vm.prank(verifier);
        vm.expectRevert(AntseedVerifierRegistry.TargetAlreadyAttested.selector);
        verifierRegistry.submitAttestation(agentA, SERVICE_HASH, 1, EVIDENCE_HASH, commitment, root, 10, 3);
    }

    // ─── anchorExchangeBatch reverts ─────────────────────────────────

    function test_anchorOnlyApprovedVerifier() public {
        (
            IAntseedVerifierRegistry.ExchangeRecord[] memory records,
            bytes[] memory payloads,
            uint32[] memory counts
        ) = _signedBatch(1, "x");
        vm.prank(outsider);
        vm.expectRevert(AntseedVerifierRegistry.NotApprovedVerifier.selector);
        verifierRegistry.anchorExchangeBatch(keccak256("c"), records, payloads, counts);
    }

    function test_anchorEmptyBatchReverts() public {
        bytes32 commitment = sha256(PROBE_SET_JSON);
        _commit(verifier, commitment);
        vm.warp(block.timestamp + 1);

        vm.prank(verifier);
        vm.expectRevert(AntseedVerifierRegistry.EmptyBatch.selector);
        verifierRegistry.anchorExchangeBatch(commitment, _records(0), _emptyPayloads(0), _ones(0));
    }

    function test_anchorTooLargeBatchReverts() public {
        bytes32 commitment = sha256(PROBE_SET_JSON);
        _commit(verifier, commitment);
        vm.warp(block.timestamp + 1);

        // The size gate fires before any signature work, so synthetic
        // records suffice here.
        IAntseedVerifierRegistry.ExchangeRecord[] memory records = _records(4097);
        vm.prank(verifier);
        vm.expectRevert(AntseedVerifierRegistry.BatchTooLarge.selector);
        verifierRegistry.anchorExchangeBatch(commitment, records, _emptyPayloads(4097), _ones(4097));
    }

    function test_anchorArrayLengthMismatchReverts() public {
        bytes32 commitment = sha256(PROBE_SET_JSON);
        _commit(verifier, commitment);
        vm.warp(block.timestamp + 1);

        (
            IAntseedVerifierRegistry.ExchangeRecord[] memory records,
            bytes[] memory payloads,
            uint32[] memory counts
        ) = _signedBatch(2, "mismatch");

        vm.prank(verifier);
        vm.expectRevert(AntseedVerifierRegistry.ArrayLengthMismatch.selector);
        verifierRegistry.anchorExchangeBatch(commitment, records, _emptyPayloads(1), counts);

        vm.prank(verifier);
        vm.expectRevert(AntseedVerifierRegistry.ArrayLengthMismatch.selector);
        verifierRegistry.anchorExchangeBatch(commitment, records, payloads, _ones(3));
    }

    function test_anchorUncommittedReverts() public {
        (
            IAntseedVerifierRegistry.ExchangeRecord[] memory records,
            bytes[] memory payloads,
            uint32[] memory counts
        ) = _signedBatch(1, "u");
        vm.prank(verifier);
        vm.expectRevert(AntseedVerifierRegistry.ProbeSetNotCommitted.selector);
        verifierRegistry.anchorExchangeBatch(keccak256("never-committed"), records, payloads, counts);
    }

    function test_anchorOtherVerifiersCommitmentReverts() public {
        bytes32 commitment = sha256(PROBE_SET_JSON);
        _commit(otherVerifier, commitment);
        vm.warp(block.timestamp + 1);

        // Commitments are per-verifier: another verifier's commit is invisible.
        (
            IAntseedVerifierRegistry.ExchangeRecord[] memory records,
            bytes[] memory payloads,
            uint32[] memory counts
        ) = _signedBatch(1, "o");
        vm.prank(verifier);
        vm.expectRevert(AntseedVerifierRegistry.ProbeSetNotCommitted.selector);
        verifierRegistry.anchorExchangeBatch(commitment, records, payloads, counts);
    }

    function test_anchorSameSecondAsCommitReverts() public {
        bytes32 commitment = sha256(PROBE_SET_JSON);
        _commit(verifier, commitment);
        // No warp: commit must be STRICTLY before anchor.
        (
            IAntseedVerifierRegistry.ExchangeRecord[] memory records,
            bytes[] memory payloads,
            uint32[] memory counts
        ) = _signedBatch(1, "s");
        vm.prank(verifier);
        vm.expectRevert(AntseedVerifierRegistry.ProbeSetTooRecent.selector);
        verifierRegistry.anchorExchangeBatch(commitment, records, payloads, counts);
    }

    function test_anchorDoubleAnchorSameRootReverts() public {
        bytes32 commitment = sha256(PROBE_SET_JSON);
        _commit(verifier, commitment);
        vm.warp(block.timestamp + 1);
        (
            IAntseedVerifierRegistry.ExchangeRecord[] memory records,
            bytes[] memory payloads,
            uint32[] memory counts
        ) = _signedBatch(4, "double");
        vm.prank(verifier);
        verifierRegistry.anchorExchangeBatch(commitment, records, payloads, counts);

        // Identical records → identical root → rejected under the same
        // commitment...
        vm.prank(verifier);
        vm.expectRevert(AntseedVerifierRegistry.CommitmentBatchAlreadyAnchored.selector);
        verifierRegistry.anchorExchangeBatch(commitment, records, payloads, counts);

        // ...and under a different commitment as well: every exchange is
        // anchorable once, globally, so the replay dies on its first record.
        bytes32 secondCommitment = keccak256("second-commitment");
        _commit(verifier, secondCommitment);
        vm.warp(block.timestamp + 1);
        vm.prank(verifier);
        vm.expectRevert(abi.encodeWithSelector(AntseedVerifierRegistry.ExchangeAlreadyAnchored.selector, 0));
        verifierRegistry.anchorExchangeBatch(secondCommitment, records, payloads, counts);
    }

    function test_anchorSameRecordsByOtherVerifierReverts() public {
        // A seller-signed exchange is anchorable exactly ONCE network-wide:
        // a second verifier that merely witnessed the same exchanges (the
        // organic-traffic laundering vector) cannot re-anchor them to mint
        // its own accrual/attestation evidence.
        bytes32 commitment = sha256(PROBE_SET_JSON);
        _commit(verifier, commitment);
        _commit(otherVerifier, commitment);
        vm.warp(block.timestamp + 1);

        (
            IAntseedVerifierRegistry.ExchangeRecord[] memory records,
            bytes[] memory payloads,
            uint32[] memory counts
        ) = _signedBatch(4, "shared");
        vm.prank(verifier);
        bytes32 rootA = verifierRegistry.anchorExchangeBatch(commitment, records, payloads, counts);
        assertEq(verifierRegistry.anchoredExchangeBy(records[0].requestHash), verifier);

        vm.prank(otherVerifier);
        vm.expectRevert(abi.encodeWithSelector(AntseedVerifierRegistry.ExchangeAlreadyAnchored.selector, 0));
        verifierRegistry.anchorExchangeBatch(commitment, records, payloads, counts);

        (uint64 anchoredAtA,,) = _anchorOf(verifier, rootA);
        assertGt(anchoredAtA, 0);
    }

    function test_anchorReusedExchangeUnderFreshCommitmentReverts() public {
        bytes32 firstCommitment = keccak256("first-replay-commitment");
        _commit(verifier, firstCommitment);
        vm.warp(block.timestamp + 1);

        uint256 responseStartedAt = block.timestamp * 1000;
        IAntseedVerifierRegistry.ExchangeRecord[] memory records = new IAntseedVerifierRegistry.ExchangeRecord[](2);
        bytes[] memory payloads = new bytes[](2);
        uint32[] memory counts = _ones(2);
        for (uint256 i = 0; i < 2; i++) {
            (records[i], payloads[i]) = makeSignedRecordForServiceAndTiming(
                agentA,
                SELLER_A_KEY,
                carrierX,
                keccak256(abi.encode("replay", i)),
                "anthropic/claude-opus-4",
                responseStartedAt,
                responseStartedAt + 1_500
            );
        }
        vm.prank(verifier);
        verifierRegistry.anchorExchangeBatch(firstCommitment, records, payloads, counts);

        vm.warp(block.timestamp + 1);
        bytes32 secondCommitment = keccak256("second-replay-commitment");
        _commit(verifier, secondCommitment);
        vm.warp(block.timestamp + 1);

        (records[0], records[1]) = (records[1], records[0]);
        (payloads[0], payloads[1]) = (payloads[1], payloads[0]);
        vm.prank(verifier);
        // The global anchored-exchange registry rejects the reuse before the
        // commit-timing check even runs.
        vm.expectRevert(abi.encodeWithSelector(AntseedVerifierRegistry.ExchangeAlreadyAnchored.selector, 0));
        verifierRegistry.anchorExchangeBatch(secondCommitment, records, payloads, counts);
    }

    function test_anchorExchangePredatingCommitmentReverts() public {
        bytes32 commitment = keccak256("stale-exchange-commitment");
        _commit(verifier, commitment);
        (
            IAntseedVerifierRegistry.ExchangeRecord memory record,
            bytes memory payload
        ) = makeSignedRecordForServiceAndTiming(
            agentA,
            SELLER_A_KEY,
            carrierX,
            "stale-exchange",
            "anthropic/claude-opus-4",
            block.timestamp * 1000 - 1,
            block.timestamp * 1000
        );
        vm.warp(block.timestamp + 1);

        IAntseedVerifierRegistry.ExchangeRecord[] memory records = new IAntseedVerifierRegistry.ExchangeRecord[](1);
        records[0] = record;
        bytes[] memory payloads = new bytes[](1);
        payloads[0] = payload;
        vm.prank(verifier);
        vm.expectRevert(abi.encodeWithSelector(AntseedVerifierRegistry.ExchangePredatesCommitment.selector, 0));
        verifierRegistry.anchorExchangeBatch(commitment, records, payloads, _ones(1));
    }

    function test_anchorResponseCompletionBeforeStartReverts() public {
        bytes32 commitment = keccak256("invalid-timing-commitment");
        _commit(verifier, commitment);
        uint256 startedAt = block.timestamp * 1000;
        (
            IAntseedVerifierRegistry.ExchangeRecord memory record,
            bytes memory payload
        ) = makeSignedRecordForServiceAndTiming(
            agentA,
            SELLER_A_KEY,
            carrierX,
            "invalid-timing",
            "anthropic/claude-opus-4",
            startedAt,
            startedAt - 1
        );
        vm.warp(block.timestamp + 1);

        IAntseedVerifierRegistry.ExchangeRecord[] memory records = new IAntseedVerifierRegistry.ExchangeRecord[](1);
        records[0] = record;
        bytes[] memory payloads = new bytes[](1);
        payloads[0] = payload;
        vm.prank(verifier);
        vm.expectRevert(abi.encodeWithSelector(AntseedVerifierRegistry.InvalidResponseTiming.selector, 0));
        verifierRegistry.anchorExchangeBatch(commitment, records, payloads, _ones(1));
    }

    // ─── On-chain ResponseAuth verification ──────────────────────────

    /// @dev Committed + warped fixture commitment, ready to anchor against.
    function _committed() internal returns (bytes32 commitment) {
        commitment = sha256(PROBE_SET_JSON);
        _commit(verifier, commitment);
        vm.warp(block.timestamp + 1);
    }

    function test_anchorWrongSignerReverts() public {
        bytes32 commitment = _committed();

        // Payload + signature from seller B, but the record claims agentA —
        // the recovered signer must be agentA's ERC-8004 owner.
        (IAntseedVerifierRegistry.ExchangeRecord[] memory records, bytes[] memory payloads, uint32[] memory counts)
        = makeSignedBatch(1, agentA, SELLER_B_KEY, verifier, "wrong-signer");
        vm.prank(verifier);
        vm.expectRevert(abi.encodeWithSelector(AntseedVerifierRegistry.RecordSignerMismatch.selector, 0));
        verifierRegistry.anchorExchangeBatch(commitment, records, payloads, counts);
    }

    function test_anchorGarbageSignatureReverts() public {
        bytes32 commitment = _committed();
        (
            IAntseedVerifierRegistry.ExchangeRecord[] memory records,
            bytes[] memory payloads,
            uint32[] memory counts
        ) = _signedBatch(1, "garbage");

        // 65 garbage bytes.
        records[0].responseAuthSig = abi.encodePacked(keccak256("r"), keccak256("s"), uint8(27));
        vm.prank(verifier);
        vm.expectRevert(abi.encodeWithSelector(AntseedVerifierRegistry.RecordSignerMismatch.selector, 0));
        verifierRegistry.anchorExchangeBatch(commitment, records, payloads, counts);

        // Wrong length.
        records[0].responseAuthSig = hex"aa";
        vm.prank(verifier);
        vm.expectRevert(abi.encodeWithSelector(AntseedVerifierRegistry.RecordSignerMismatch.selector, 0));
        verifierRegistry.anchorExchangeBatch(commitment, records, payloads, counts);
    }

    function test_anchorTamperedRecordHashReverts() public {
        bytes32 commitment = _committed();
        (
            IAntseedVerifierRegistry.ExchangeRecord[] memory records,
            bytes[] memory payloads,
            uint32[] memory counts
        ) = _signedBatch(2, "tamper-record");

        // The signature still verifies (it covers the payload), but the
        // anchored record no longer matches the hash the seller signed.
        bytes32 original = records[1].requestHash;
        records[1].requestHash = keccak256("substituted-request");
        vm.prank(verifier);
        vm.expectRevert(abi.encodeWithSelector(AntseedVerifierRegistry.RecordHashMismatch.selector, 1));
        verifierRegistry.anchorExchangeBatch(commitment, records, payloads, counts);

        records[1].requestHash = original;
        records[1].responseHash = keccak256("substituted-response");
        vm.prank(verifier);
        vm.expectRevert(abi.encodeWithSelector(AntseedVerifierRegistry.RecordHashMismatch.selector, 1));
        verifierRegistry.anchorExchangeBatch(commitment, records, payloads, counts);
    }

    function test_anchorTamperedPayloadReverts() public {
        bytes32 commitment = _committed();
        (
            IAntseedVerifierRegistry.ExchangeRecord[] memory records,
            bytes[] memory payloads,
            uint32[] memory counts
        ) = _signedBatch(1, "tamper-payload");

        // Flip one byte inside the signed payload: the digest changes, the
        // signature no longer recovers the seller.
        payloads[0][60] ^= 0x01;
        vm.prank(verifier);
        vm.expectRevert(abi.encodeWithSelector(AntseedVerifierRegistry.RecordSignerMismatch.selector, 0));
        verifierRegistry.anchorExchangeBatch(commitment, records, payloads, counts);
    }

    function test_anchorSellerSignedMalformedPayloadReverts() public {
        bytes32 commitment = _committed();

        // A validly SIGNED but structurally malformed payload (not 13
        // length-prefixed fields) passes signature recovery and must then
        // fail parsing.
        bytes memory malformed = bytes("not-a-response-auth-payload");
        IAntseedVerifierRegistry.ExchangeRecord[] memory records = new IAntseedVerifierRegistry.ExchangeRecord[](1);
        records[0] = IAntseedVerifierRegistry.ExchangeRecord({
            agentId: agentA,
            requestHash: keccak256("req"),
            responseHash: keccak256("res"),
            responseAuthSig: signResponseAuth(SELLER_A_KEY, malformed)
        });
        bytes[] memory payloads = new bytes[](1);
        payloads[0] = malformed;

        vm.prank(verifier);
        vm.expectRevert(AntseedVerifierRegistry.MalformedSigningPayload.selector);
        verifierRegistry.anchorExchangeBatch(commitment, records, payloads, _ones(1));
    }

    function test_anchorUnknownAgentReverts() public {
        bytes32 commitment = _committed();

        // agentId 999 was never registered.
        (IAntseedVerifierRegistry.ExchangeRecord[] memory records, bytes[] memory payloads, uint32[] memory counts)
        = makeSignedBatch(1, 999, SELLER_A_KEY, verifier, "unknown-agent");
        vm.prank(verifier);
        vm.expectRevert(AntseedVerifierRegistry.UnknownAgent.selector);
        verifierRegistry.anchorExchangeBatch(commitment, records, payloads, counts);
    }

    function test_anchorWithUnsetIdentityRegistryReverts() public {
        AntseedRegistry bareRegistry = new AntseedRegistry();
        bareRegistry.setEmissions(address(clock));
        AntseedVerifierRegistry bareVerifierRegistry = new AntseedVerifierRegistry(address(bareRegistry));
        bareVerifierRegistry.setVerifier(verifier, true);

        vm.prank(verifier);
        bareVerifierRegistry.commitProbeSet(keccak256("c"));
        vm.warp(block.timestamp + 1);

        (
            IAntseedVerifierRegistry.ExchangeRecord[] memory records,
            bytes[] memory payloads,
            uint32[] memory counts
        ) = _signedBatch(1, "bare");
        vm.prank(verifier);
        vm.expectRevert(AntseedVerifierRegistry.UnknownAgent.selector);
        bareVerifierRegistry.anchorExchangeBatch(keccak256("c"), records, payloads, counts);
    }

    function test_anchorRecordProbeCountZeroReverts() public {
        bytes32 commitment = _committed();
        (
            IAntseedVerifierRegistry.ExchangeRecord[] memory records,
            bytes[] memory payloads,
            uint32[] memory counts
        ) = _signedBatch(3, "zero-count");
        counts[2] = 0;

        vm.prank(verifier);
        vm.expectRevert(abi.encodeWithSelector(AntseedVerifierRegistry.RecordProbeCountZero.selector, 2));
        verifierRegistry.anchorExchangeBatch(commitment, records, payloads, counts);
    }

    function test_anchorRecordProbeCountAboveProtocolMaxReverts() public {
        bytes32 commitment = _committed();
        (
            IAntseedVerifierRegistry.ExchangeRecord[] memory records,
            bytes[] memory payloads,
            uint32[] memory counts
        ) = _signedBatch(2, "overflow");
        counts[0] = 4;

        vm.prank(verifier);
        vm.expectRevert(abi.encodeWithSelector(AntseedVerifierRegistry.RecordProbeCountTooHigh.selector, 0));
        verifierRegistry.anchorExchangeBatch(commitment, records, payloads, counts);
    }

    // ─── Delegate accrual at anchor time ─────────────────────────────

    function test_anchorAccruesPerBuyerAggregated() public {
        bytes32 commitment = _committed();

        // Buyers per record: X, Y, X, verifier, sellerA-as-buyer, X with
        // probe counts 1,2,3,1,2,3. Expected accrual: X = 1+3+3 = 7, Y = 2;
        // the verifier-carried and seller-carried records accrue nothing.
        address sellerA = vm.addr(SELLER_A_KEY);
        address[6] memory buyers = [carrierX, carrierY, carrierX, verifier, sellerA, carrierX];
        IAntseedVerifierRegistry.ExchangeRecord[] memory records = new IAntseedVerifierRegistry.ExchangeRecord[](6);
        bytes[] memory payloads = new bytes[](6);
        uint32[] memory counts = new uint32[](6);
        for (uint256 i = 0; i < 6; i++) {
            (records[i], payloads[i]) =
                makeSignedRecord(agentA, SELLER_A_KEY, buyers[i], keccak256(abi.encode("accrue", i)));
            counts[i] = uint32((i % 3) + 1);
        }

        // Aggregated per distinct (buyer, target): exactly one event per
        // buyer here — all records probe the same target agentA.
        vm.expectEmit(true, true, true, true);
        emit DelegateCreditsAccrued(verifier, commitment, carrierX, agentA, SERVICE_HASH, 7);
        vm.expectEmit(true, true, true, true);
        emit DelegateCreditsAccrued(verifier, commitment, carrierY, agentA, SERVICE_HASH, 2);
        vm.prank(verifier);
        bytes32 root = verifierRegistry.anchorExchangeBatch(commitment, records, payloads, counts);

        (,, uint32 probeCount) = _anchorOf(verifier, root);
        bytes32 key = _keyOf(agentA);
        assertEq(probeCount, 12, "summed declared probes");
        assertEq(verifierRegistry.commitmentDelegateAccrued(verifier, commitment, key, carrierX), 7);
        assertEq(verifierRegistry.commitmentDelegateAccrued(verifier, commitment, key, carrierY), 2);
        assertEq(verifierRegistry.commitmentDelegateAccrued(verifier, commitment, key, verifier), 0, "self-carry");
        assertEq(verifierRegistry.commitmentDelegateAccrued(verifier, commitment, key, sellerA), 0, "seller-carry");
    }

    function test_anchorSecondBatchForCommitmentReverts() public {
        bytes32 commitment = _committed();

        (IAntseedVerifierRegistry.ExchangeRecord[] memory records, bytes[] memory payloads, uint32[] memory counts)
        = makeSignedBatch(3, agentA, SELLER_A_KEY, carrierX, "acc-1");
        vm.prank(verifier);
        verifierRegistry.anchorExchangeBatch(commitment, records, payloads, counts);
        assertEq(verifierRegistry.commitmentDelegateAccrued(verifier, commitment, _keyOf(agentA), carrierX), 3);

        (records, payloads, counts) = makeSignedBatch(2, agentA, SELLER_A_KEY, carrierX, "acc-2");
        vm.prank(verifier);
        vm.expectRevert(AntseedVerifierRegistry.CommitmentBatchAlreadyAnchored.selector);
        verifierRegistry.anchorExchangeBatch(commitment, records, payloads, counts);
        assertEq(verifierRegistry.commitmentDelegateAccrued(verifier, commitment, _keyOf(agentA), carrierX), 3);
    }

    function test_anchorDuplicateRequestHashReverts() public {
        bytes32 commitment = _committed();
        (IAntseedVerifierRegistry.ExchangeRecord[] memory records, bytes[] memory payloads, uint32[] memory counts)
        = makeSignedBatch(2, agentA, SELLER_A_KEY, carrierX, "duplicate");
        records[1] = records[0];
        payloads[1] = payloads[0];

        vm.prank(verifier);
        vm.expectRevert(abi.encodeWithSelector(AntseedVerifierRegistry.ExchangeAlreadyAnchored.selector, 1));
        verifierRegistry.anchorExchangeBatch(commitment, records, payloads, counts);
    }

    // ─── parseResponseAuthPayload / responseAuthDigest ───────────────

    function test_parsePayloadExtractsBoundFields() public view {
        (, bytes memory payload) = makeSignedRecord(agentA, SELLER_A_KEY, carrierX, "parse");
        (
            address buyer,
            bytes32 advertisedServiceHash,
            bytes32 requestHash,
            bytes32 responseHash,
            uint64 responseStartedAt,
            uint64 responseCompletedAt
        ) = verifierRegistry.parseResponseAuthPayload(payload);
        assertEq(buyer, carrierX);
        assertEq(advertisedServiceHash, SERVICE_HASH);
        assertEq(requestHash, keccak256(abi.encode("request", bytes32("parse"))));
        assertEq(responseHash, keccak256(abi.encode("response", bytes32("parse"))));
        assertEq(responseStartedAt, block.timestamp * 1000);
        assertEq(responseCompletedAt, block.timestamp * 1000 + 1_500);
    }

    function test_parsePayloadMalformedReverts() public {
        (, bytes memory payload) = makeSignedRecord(agentA, SELLER_A_KEY, carrierX, "malformed");

        // Truncated payload (last byte cut).
        bytes memory truncated = new bytes(payload.length - 1);
        for (uint256 i = 0; i < truncated.length; i++) {
            truncated[i] = payload[i];
        }
        vm.expectRevert(AntseedVerifierRegistry.MalformedSigningPayload.selector);
        verifierRegistry.parseResponseAuthPayload(truncated);

        // Trailing garbage after the 13th field.
        vm.expectRevert(AntseedVerifierRegistry.MalformedSigningPayload.selector);
        verifierRegistry.parseResponseAuthPayload(bytes.concat(payload, hex"00"));

        // Wrong domain field.
        bytes memory wrongDomain = buildSigningPayload(
            ResponseAuthFields({
                requestId: "r",
                channelId: "",
                buyer: carrierX,
                seller: vm.addr(SELLER_A_KEY),
                advertisedService: "svc",
                provider: "p",
                statusCode: 200,
                requestHash: keccak256("a"),
                responseHash: keccak256("b"),
                responseStartedAt: 1,
                responseCompletedAt: 2
            })
        );
        // Corrupt the domain text (field 0 starts at offset 4).
        wrongDomain[4] = "X";
        vm.expectRevert(AntseedVerifierRegistry.MalformedSigningPayload.selector);
        verifierRegistry.parseResponseAuthPayload(wrongDomain);

        // Empty payload.
        vm.expectRevert(AntseedVerifierRegistry.MalformedSigningPayload.selector);
        verifierRegistry.parseResponseAuthPayload("");

        // Timestamp fields are strict unsigned decimal integers.
        bytes memory badTimestamp = payload;
        badTimestamp[badTimestamp.length - 30] = "x";
        vm.expectRevert(AntseedVerifierRegistry.MalformedSigningPayload.selector);
        verifierRegistry.parseResponseAuthPayload(badTimestamp);
    }

    function test_parsePayloadBadHexReverts() public {
        (, bytes memory payload) = makeSignedRecord(agentA, SELLER_A_KEY, carrierX, "badhex");
        // The buyer field (field 4) starts after the 4 length prefixes and
        // contents of fields 0-3 plus its own prefix. Field 0 is 24 bytes,
        // field 1 is 1 byte ("1"), field 2 is 70 bytes ("req-0x" + 64),
        // field 3 is 0 bytes → offset = 4+24 + 4+1 + 4+70 + 4+0 + 4 = 115.
        payload[115] = "z"; // not a hex digit
        vm.expectRevert(AntseedVerifierRegistry.MalformedSigningPayload.selector);
        verifierRegistry.parseResponseAuthPayload(payload);
    }

    function test_parsePayloadAcceptsPrefixedAndUppercaseHex() public view {
        // The protocol writes peer ids unprefixed-lowercase and hashes
        // 0x-prefixed-lowercase, but the parser tolerates a 0x prefix and
        // uppercase digits on any hex field (the signature already binds
        // the exact bytes; leniency only affects extraction).
        bytes memory payload = bytes.concat(
            _lpx("antseed-response-auth-v1"),
            _lpx("1"),
            _lpx("req-1"),
            _lpx(""),
            _lpx("0xCAB1000000000000000000000000000000000000"), // 0x + uppercase
            _lpx("e05fcc23807536bee418f142d19fa0d21bb0cff7"),
            _lpx("svc"),
            _lpx("prov"),
            _lpx("200"),
            _lpx("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"), // no 0x, uppercase
            _lpx("0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
            _lpx("1"),
            _lpx("2")
        );
        (
            address buyer,
            bytes32 advertisedServiceHash,
            bytes32 requestHash,
            bytes32 responseHash,
            uint64 responseStartedAt,
            uint64 responseCompletedAt
        ) = verifierRegistry.parseResponseAuthPayload(payload);
        assertEq(buyer, address(0xCAB1000000000000000000000000000000000000));
        assertEq(advertisedServiceHash, keccak256("svc"));
        assertEq(requestHash, bytes32(uint256(type(uint256).max / 15 * 10))); // 0xaaa...a
        assertEq(responseHash, bytes32(uint256(type(uint256).max / 15 * 11))); // 0xbbb...b
        assertEq(responseStartedAt, 1);
        assertEq(responseCompletedAt, 2);
    }

    function _lpx(bytes memory field) private pure returns (bytes memory) {
        return abi.encodePacked(uint32(field.length), field);
    }

    // ─── Cross-language pinned signing payload ───────────────────────

    // Pinned by scratchpad/gen-response-auth-fixture.mjs (2026-07-14), which
    // byte-mirrors packages/node/src/verification/response-auth.ts
    // buildResponseAuthSigningBytes + packages/node/src/p2p/identity.ts
    // signData. If any assertion here drifts, one side's byte derivation
    // changed — re-pin BOTH sides together, deliberately.
    uint256 constant PINNED_SELLER_KEY = 0xA11CE;
    address constant PINNED_SELLER = 0xe05fcC23807536bEe418f142D19fa0d21BB0cfF7;
    address constant PINNED_BUYER = 0x0376AAc07Ad725E01357B1725B5ceC61aE10473c;
    bytes32 constant PINNED_DIGEST = 0x7f596ef2fa83ddb0f4a53aafbf4fafc6559857c2cd75b673342c427909a1340a;
    bytes32 constant PINNED_PAYLOAD_KECCAK = 0xdc8d7f95a6382164f1bed67a4c72aa68fcbaa773094b77d0d5792185784efc9c;
    bytes constant PINNED_SIG =
        hex"9d15bca7e971dbf030ca81c9405c433791da72e7a66cad436630c6f885c474b753d9da47753a3868c6f397d5a60d78c2144b09ecbcad5e988162d2317c7f87291c";

    function _pinnedFields() internal pure returns (ResponseAuthFields memory) {
        return ResponseAuthFields({
            requestId: "11111111-2222-4333-8444-555555555555",
            channelId: "",
            buyer: PINNED_BUYER,
            seller: PINNED_SELLER,
            advertisedService: "anthropic/claude-opus-4",
            provider: "claude-oauth",
            statusCode: 200,
            requestHash: keccak256("fixture-request-body"),
            responseHash: keccak256("fixture-response-body"),
            responseStartedAt: 1_752_444_000_000,
            responseCompletedAt: 1_752_444_001_500
        });
    }

    function test_pinnedCrossLanguageSigningPayload() public view {
        assertEq(vm.addr(PINNED_SELLER_KEY), PINNED_SELLER, "pinned seller key");

        bytes memory payload = buildSigningPayload(_pinnedFields());
        assertEq(payload.length, 389, "pinned payload length");
        assertEq(keccak256(payload), PINNED_PAYLOAD_KECCAK, "pinned payload bytes");
        assertEq(verifierRegistry.responseAuthDigest(payload), PINNED_DIGEST, "pinned digest");
        assertEq(signResponseAuth(PINNED_SELLER_KEY, payload), PINNED_SIG, "pinned signature (RFC 6979)");

        (
            address buyer,
            bytes32 advertisedServiceHash,
            bytes32 requestHash,
            bytes32 responseHash,
            uint64 responseStartedAt,
            uint64 responseCompletedAt
        ) = verifierRegistry.parseResponseAuthPayload(payload);
        assertEq(buyer, PINNED_BUYER, "pinned buyer");
        assertEq(advertisedServiceHash, SERVICE_HASH, "pinned serviceHash");
        assertEq(requestHash, keccak256("fixture-request-body"), "pinned requestHash");
        assertEq(responseHash, keccak256("fixture-response-body"), "pinned responseHash");
        assertEq(responseStartedAt, 1_752_444_000_000, "pinned responseStartedAt");
        assertEq(responseCompletedAt, 1_752_444_001_500, "pinned responseCompletedAt");
    }

    function test_pinnedPayloadAnchorsEndToEnd() public {
        uint256 pinnedAgent = identity.register();
        identity.setOwner(pinnedAgent, PINNED_SELLER);

        bytes32 commitment = _committed();
        bytes memory payload = buildSigningPayload(_pinnedFields());
        IAntseedVerifierRegistry.ExchangeRecord[] memory records = new IAntseedVerifierRegistry.ExchangeRecord[](1);
        records[0] = IAntseedVerifierRegistry.ExchangeRecord({
            agentId: pinnedAgent,
            requestHash: keccak256("fixture-request-body"),
            responseHash: keccak256("fixture-response-body"),
            responseAuthSig: PINNED_SIG
        });
        bytes[] memory payloads = new bytes[](1);
        payloads[0] = payload;
        uint32[] memory counts = new uint32[](1);
        counts[0] = 3;

        vm.prank(verifier);
        bytes32 root = verifierRegistry.anchorExchangeBatch(commitment, records, payloads, counts);
        (,, uint32 probeCount) = _anchorOf(verifier, root);
        assertEq(probeCount, 3);
        assertEq(verifierRegistry.commitmentDelegateAccrued(verifier, commitment, _keyOf(pinnedAgent), PINNED_BUYER), 3);
    }

    // ─── submitAttestation batch binding ─────────────────────────────

    function test_attestUnanchoredRootReverts() public {
        bytes32 commitment = sha256(PROBE_SET_JSON);
        _commit(verifier, commitment);
        vm.warp(block.timestamp + 1);

        vm.prank(verifier);
        vm.expectRevert(AntseedVerifierRegistry.BatchNotAnchored.selector);
        verifierRegistry.submitAttestation(
            agentId, SERVICE_HASH, 1, EVIDENCE_HASH, commitment, keccak256("no-such-root"), 10, 3
        );
    }

    function test_attestForeignRootReverts() public {
        bytes32 commitment = sha256(PROBE_SET_JSON);
        _commit(verifier, commitment);
        _commit(otherVerifier, commitment);
        vm.warp(block.timestamp + 1);

        // Root anchored by ANOTHER verifier does not satisfy the binding —
        // anchors are keyed per verifier.
        bytes32 foreignRoot = _anchorSigned(otherVerifier, commitment, 10, "foreign");
        vm.prank(verifier);
        vm.expectRevert(AntseedVerifierRegistry.BatchNotAnchored.selector);
        verifierRegistry.submitAttestation(agentId, SERVICE_HASH, 1, EVIDENCE_HASH, commitment, foreignRoot, 10, 3);
    }

    function test_attestRootBoundToDifferentCommitmentReverts() public {
        bytes32 commitmentA = sha256(PROBE_SET_JSON);
        bytes32 commitmentB = keccak256("other-probe-set");
        _commit(verifier, commitmentA);
        _commit(verifier, commitmentB);
        vm.warp(block.timestamp + 1);

        bytes32 root = _anchorSigned(verifier, commitmentA, 10, "bound");
        vm.prank(verifier);
        vm.expectRevert(AntseedVerifierRegistry.BatchCommitmentMismatch.selector);
        verifierRegistry.submitAttestation(agentId, SERVICE_HASH, 1, EVIDENCE_HASH, commitmentB, root, 10, 3);
    }

    // ─── revealProbeSet ──────────────────────────────────────────────

    /// @dev Full commit → anchor → attest run over PROBE_SET_JSON's commitment.
    function _runAuditOverFixture() internal returns (bytes32 commitment) {
        commitment = sha256(PROBE_SET_JSON);
        _commit(verifier, commitment);
        vm.warp(block.timestamp + 1);
        bytes32 root = _anchorSigned(verifier, commitment, 10, "audit");
        _attest(verifier, commitment, root);
    }

    /// L-1: reveal is NOT onlyApprovedVerifier. A verifier removed from the
    /// whitelist after committing + attesting must still be able to open its
    /// own commitment — the self-authenticating sha256 opening keeps those
    /// (most-scrutinised) audits re-runnable rather than permanently sealed.
    function test_revealByDeWhitelistedVerifierSucceeds() public {
        bytes32 commitment = _runAuditOverFixture();

        // Remove the verifier from the whitelist entirely.
        verifierRegistry.setVerifier(verifier, false);
        assertFalse(verifierRegistry.approvedVerifiers(verifier));

        // It can still reveal the valid opening for its own past audit; the
        // pack pointer is optional, so an empty URI is accepted here.
        vm.expectEmit(true, true, false, true);
        emit ProbeSetRevealed(verifier, commitment, "");
        vm.prank(verifier);
        verifierRegistry.revealProbeSet(commitment, PROBE_SET_JSON, "");
        assertGt(verifierRegistry.probeRevealedAt(verifier, commitment), 0);
    }

    function test_revealUncommittedReverts() public {
        // Never committed by this verifier (including a commitment only the
        // OTHER verifier holds).
        bytes32 commitment = sha256(PROBE_SET_JSON);
        vm.prank(verifier);
        vm.expectRevert(AntseedVerifierRegistry.ProbeSetNotCommitted.selector);
        verifierRegistry.revealProbeSet(commitment, PROBE_SET_JSON, PACK_URI);

        _commit(otherVerifier, commitment);
        vm.prank(verifier);
        vm.expectRevert(AntseedVerifierRegistry.ProbeSetNotCommitted.selector);
        verifierRegistry.revealProbeSet(commitment, PROBE_SET_JSON, PACK_URI);
    }

    function test_revealBeforeAttestReverts() public {
        bytes32 commitment = sha256(PROBE_SET_JSON);
        _commit(verifier, commitment);
        vm.warp(block.timestamp + 1);
        _anchorSigned(verifier, commitment, 3, "pre-attest");

        // Committed AND anchored, but no attestation has referenced the
        // commitment yet — revealing now would allow reveal-then-probe.
        vm.prank(verifier);
        vm.expectRevert(AntseedVerifierRegistry.RevealBeforeAttest.selector);
        verifierRegistry.revealProbeSet(commitment, PROBE_SET_JSON, PACK_URI);
    }

    function test_revealWrongBytesReverts() public {
        bytes32 commitment = _runAuditOverFixture();

        // Same length, one byte off.
        bytes memory tampered = bytes(PROBE_SET_JSON);
        tampered[13] = "X";
        vm.prank(verifier);
        vm.expectRevert(AntseedVerifierRegistry.RevealMismatch.selector);
        verifierRegistry.revealProbeSet(commitment, tampered, PACK_URI);

        // Empty bytes.
        vm.prank(verifier);
        vm.expectRevert(AntseedVerifierRegistry.RevealMismatch.selector);
        verifierRegistry.revealProbeSet(commitment, "", PACK_URI);

        // The exact bytes still open the commitment afterward.
        vm.prank(verifier);
        verifierRegistry.revealProbeSet(commitment, PROBE_SET_JSON, PACK_URI);
        assertGt(verifierRegistry.probeRevealedAt(verifier, commitment), 0);
    }

    function test_revealTwiceReverts() public {
        bytes32 commitment = _runAuditOverFixture();
        vm.prank(verifier);
        verifierRegistry.revealProbeSet(commitment, PROBE_SET_JSON, PACK_URI);

        vm.prank(verifier);
        vm.expectRevert(AntseedVerifierRegistry.AlreadyRevealed.selector);
        verifierRegistry.revealProbeSet(commitment, PROBE_SET_JSON, PACK_URI);
    }

    // ─── M-1: commitment sealed once revealed ────────────────────────

    /// After reveal the probes are public; no NEW batch may be anchored under
    /// the same commitment (else: reveal, then anchor against a seller that
    /// has now seen the probes — reveal-then-probe laundering).
    function test_anchorAfterRevealReverts() public {
        bytes32 commitment = _runAuditOverFixture();
        vm.prank(verifier);
        verifierRegistry.revealProbeSet(commitment, PROBE_SET_JSON, PACK_URI);

        (
            IAntseedVerifierRegistry.ExchangeRecord[] memory records,
            bytes[] memory payloads,
            uint32[] memory counts
        ) = _signedBatch(10, "post-reveal");
        vm.prank(verifier);
        vm.expectRevert(AntseedVerifierRegistry.AlreadyRevealed.selector);
        verifierRegistry.anchorExchangeBatch(commitment, records, payloads, counts);
    }

    /// Likewise no NEW verdict may credit against a revealed commitment, even
    /// against a batch that was anchored (and left un-attested) before reveal.
    function test_attestAfterRevealReverts() public {
        bytes32 commitment = sha256(PROBE_SET_JSON);
        _commit(verifier, commitment);
        vm.warp(block.timestamp + 1);
        // Anchor and attest once to open the reveal gate.
        bytes32 firstRoot = _anchorSigned(verifier, commitment, 10, "first");
        _attest(verifier, commitment, firstRoot);

        vm.prank(verifier);
        verifierRegistry.revealProbeSet(commitment, PROBE_SET_JSON, PACK_URI);

        uint256 freshAgent = identity.register();
        identity.setOwner(freshAgent, sellerOwner);
        vm.prank(verifier);
        vm.expectRevert(AntseedVerifierRegistry.AlreadyRevealed.selector);
        verifierRegistry.submitAttestation(freshAgent, SERVICE_HASH, 1, EVIDENCE_HASH, commitment, firstRoot, 10, 3);
    }

    // ─── M-2: probeCount bounded by the anchor-time sum ──────────────

    function test_attestProbeCountExceedingDeclaredProbesReverts() public {
        bytes32 commitment = _committed();
        // 12 records declaring 2 probes each — the batch bundles 24 probes.
        (
            IAntseedVerifierRegistry.ExchangeRecord[] memory records,
            bytes[] memory payloads,
            uint32[] memory counts
        ) = _signedBatch(12, "cap");
        for (uint256 i = 0; i < counts.length; i++) {
            counts[i] = 2;
        }
        vm.prank(verifier);
        bytes32 root = verifierRegistry.anchorExchangeBatch(commitment, records, payloads, counts);

        // 25 probes claimed against a 24-probe batch → rejected.
        vm.prank(verifier);
        vm.expectRevert(AntseedVerifierRegistry.ProbeCountExceedsBatch.selector);
        verifierRegistry.submitAttestation(agentId, SERVICE_HASH, 1, EVIDENCE_HASH, commitment, root, 25, 3);

        // Exactly 24 (== summed probe count) is accepted.
        vm.prank(verifier);
        verifierRegistry.submitAttestation(agentId, SERVICE_HASH, 1, EVIDENCE_HASH, commitment, root, 24, 3);
        assertEq(verifierRegistry.latestAttestation(agentId, SERVICE_HASH).probeCount, 24);
        assertEq(verifierRegistry.latestAttestation(agentId, SERVICE_HASH).batchRoot, root);
    }

    /// Regression for the record-vs-probe unit mismatch: the client anchors
    /// one record per SIGNED REQUEST, each bundling several probes, so a
    /// legitimate small-cohort audit has probeCount > recordCount (e.g. 24
    /// probes over 8 requests). The cap must be the summed probe count, not
    /// the record count.
    function test_attestProbeCountAboveRecordCountWithinDeclarationSucceeds() public {
        bytes32 commitment = _committed();
        // 8 anchored requests bundling 24 probes — the defaults' shape.
        (
            IAntseedVerifierRegistry.ExchangeRecord[] memory records,
            bytes[] memory payloads,
            uint32[] memory counts
        ) = _signedBatch(8, "bundle");
        for (uint256 i = 0; i < counts.length; i++) {
            counts[i] = 3;
        }
        vm.prank(verifier);
        bytes32 root = verifierRegistry.anchorExchangeBatch(commitment, records, payloads, counts);

        vm.prank(verifier);
        verifierRegistry.submitAttestation(agentId, SERVICE_HASH, 1, EVIDENCE_HASH, commitment, root, 24, 3);
        assertEq(verifierRegistry.latestAttestation(agentId, SERVICE_HASH).probeCount, 24);
    }

    // ─── Root determinism ────────────────────────────────────────────

    function test_computeBatchRootMatchesReferenceImplementation() public view {
        // Even, odd, power-of-two and deep-odd shapes: the in-place loop in
        // the contract and the recursive reference fold must agree everywhere.
        uint256[8] memory sizes = [uint256(1), 2, 3, 4, 5, 7, 8, 33];
        for (uint256 i = 0; i < sizes.length; i++) {
            IAntseedVerifierRegistry.ExchangeRecord[] memory records = _records(sizes[i]);
            assertEq(
                verifierRegistry.computeBatchRoot(records),
                _referenceRootOf(records),
                string.concat("root mismatch at size ", vm.toString(sizes[i]))
            );
        }
    }

    function test_singleRecordRootIsLeaf() public view {
        IAntseedVerifierRegistry.ExchangeRecord[] memory records = _records(1);
        assertEq(verifierRegistry.computeBatchRoot(records), _leaf(records[0]));
    }

    function test_threeRecordRootHasOddNodePromoted() public view {
        // Manual expansion: root = H( H(l0 || l1) || l2 ) — the odd third
        // leaf is promoted unchanged to the second level.
        IAntseedVerifierRegistry.ExchangeRecord[] memory records = _records(3);
        bytes32 l0 = _leaf(records[0]);
        bytes32 l1 = _leaf(records[1]);
        bytes32 l2 = _leaf(records[2]);
        bytes32 expected = keccak256(bytes.concat(keccak256(bytes.concat(l0, l1)), l2));
        assertEq(verifierRegistry.computeBatchRoot(records), expected);
    }

    function test_rootBindsSignatureBytes() public view {
        IAntseedVerifierRegistry.ExchangeRecord[] memory records = _records(2);
        bytes32 original = verifierRegistry.computeBatchRoot(records);

        // Flipping a single signature byte must change the root — the sig is
        // part of the leaf via keccak256(responseAuthSig).
        records[1].responseAuthSig[10] ^= 0x01;
        assertTrue(verifierRegistry.computeBatchRoot(records) != original);
    }

    function test_computeBatchRootEmptyReverts() public {
        vm.expectRevert(AntseedVerifierRegistry.EmptyBatch.selector);
        verifierRegistry.computeBatchRoot(_records(0));
    }

    // ─── Cross-language pinned fixture ───────────────────────────────

    /// @dev Byte-for-byte replica of `buildFixtureRecords` in
    ///      packages/node/src/verification/exchange-batch.ts: record i has
    ///      agentId i+1, requestHash = keccak256("req-i"),
    ///      responseHash = keccak256("res-i") and a synthetic 65-byte
    ///      signature keccak256("sig-i") ‖ keccak256("sig-i-s") ‖ 0x1b
    ///      (i rendered in decimal). Frozen with the TS side — never change
    ///      one without re-pinning both.
    function _fixtureRecords(uint256 n)
        internal
        pure
        returns (IAntseedVerifierRegistry.ExchangeRecord[] memory records)
    {
        records = new IAntseedVerifierRegistry.ExchangeRecord[](n);
        for (uint256 i = 0; i < n; i++) {
            string memory idx = vm.toString(i);
            records[i] = IAntseedVerifierRegistry.ExchangeRecord({
                agentId: i + 1,
                requestHash: keccak256(bytes(string.concat("req-", idx))),
                responseHash: keccak256(bytes(string.concat("res-", idx))),
                responseAuthSig: abi.encodePacked(
                    keccak256(bytes(string.concat("sig-", idx))),
                    keccak256(bytes(string.concat("sig-", idx, "-s"))),
                    uint8(0x1b)
                )
            });
        }
    }

    /// @dev The pinned roots below are generated by the TypeScript mirror
    ///      (packages/node/tests/exchange-batch.test.ts pins the SAME
    ///      values). If this test ever disagrees, one side's leaf/root
    ///      derivation drifted — re-pin BOTH suites together, deliberately.
    function test_computeBatchRootMatchesPinnedCrossLanguageRoots() public view {
        bytes32[4] memory pinnedRoots = [
            bytes32(0x4e2518cd3642ea7a18329b21f42d11c5236a5ff9d63ee20e791ac0bcb07a380e),
            bytes32(0xb5f671cd8da3fa71c98304904f9c1402a834de3c55580792894e55f1ec42fc38),
            bytes32(0xb85932b50baae5041129b6c74572dae0f3b15c907cc5bf5269857e69a4721705),
            bytes32(0xccb6374afccfe2dbddf6e11aebeb79a3b44120c8305d735f2aaaa4849a11b241)
        ];
        uint256[4] memory sizes = [uint256(1), 2, 3, 5];
        for (uint256 i = 0; i < sizes.length; i++) {
            assertEq(
                verifierRegistry.computeBatchRoot(_fixtureRecords(sizes[i])),
                pinnedRoots[i],
                string.concat("cross-language root mismatch at size ", vm.toString(sizes[i]))
            );
        }
    }

    // ─── Gas ─────────────────────────────────────────────────────────

    /// @dev Realistic mixed batch: `n` signed records spread across three
    ///      sellers (exercising the agentId→owner cache) and two carrier
    ///      buyers plus verifier-direct records (two accrual stores/events).
    function _realisticBatch(uint256 n, bytes32 salt)
        internal
        view
        returns (
            IAntseedVerifierRegistry.ExchangeRecord[] memory records,
            bytes[] memory payloads,
            uint32[] memory counts
        )
    {
        records = new IAntseedVerifierRegistry.ExchangeRecord[](n);
        payloads = new bytes[](n);
        counts = new uint32[](n);
        for (uint256 i = 0; i < n; i++) {
            uint256 agent = agentA;
            uint256 key = SELLER_A_KEY;
            if (i % 3 == 1) {
                agent = agentB;
                key = SELLER_B_KEY;
            }
            address buyer = i % 3 == 0 ? carrierX : (i % 3 == 1 ? carrierY : verifier);
            (records[i], payloads[i]) = makeSignedRecord(agent, key, buyer, keccak256(abi.encode(salt, i)));
            counts[i] = 3;
        }
    }

    function _anchorGas(uint256 n, bytes32 salt) internal returns (uint256 gasUsed) {
        bytes32 commitment = keccak256(abi.encode("gas-commitment", salt));
        _commit(verifier, commitment);
        vm.warp(block.timestamp + 1);
        (
            IAntseedVerifierRegistry.ExchangeRecord[] memory records,
            bytes[] memory payloads,
            uint32[] memory counts
        ) = _realisticBatch(n, salt);
        vm.prank(verifier);
        uint256 gasBefore = gasleft();
        verifierRegistry.anchorExchangeBatch(commitment, records, payloads, counts);
        gasUsed = gasBefore - gasleft();
    }

    /// @dev THE gas gate this feature shipped under: the design target for
    ///      the per-record marginal execution overhead of on-chain signature
    ///      verification + payload parsing was ~25k gas. MEASURED 2026-07-14
    ///      (solc 0.8.24, via-ir, 200 runs): ~42k marginal per record after
    ///      binding each target/service pair to its declared probe count and
    ///      validating the signed exchange timestamps.
    ///      The breakdown is roughly
    ///      hex-field decoding + payload walk ~10k, EIP-191 digest ~2.5k,
    ///      ecrecover ~3.5k, Merkle leaf/root ~3.5k, agent lookup + accrual
    ///      + memory growth the rest. The asserts below are regression
    ///      guards with headroom, not the target.
    function test_anchor24RecordsGasGate() public {
        uint256 gas24 = _anchorGas(24, "g24");
        uint256 gas48 = _anchorGas(48, "g48");
        uint256 marginalPerRecord = (gas48 - gas24) / 24;

        emit log_named_uint("anchor 24 signed records: total execution gas", gas24);
        emit log_named_uint("anchor 48 signed records: total execution gas", gas48);
        emit log_named_uint("marginal execution gas per record", marginalPerRecord);

        // ~42k crypto/parse work + ~22k for the global anchored-exchange
        // registry write (one cold zero→nonzero SSTORE per record — the
        // price of network-wide exchange replay protection).
        assertLt(marginalPerRecord, 70_000, "per-record marginal execution gas regressed (was ~64k)");
        assertLt(gas24, 1_800_000, "24-record anchor execution gas regressed (was ~1.7M)");
    }

    /// @dev Practical batch-size ceiling. Memory growth is quadratic in
    ///      batch size (every record's digest/recover path allocates), so
    ///      per-record cost rises with the batch: ~64k marginal at 24-48
    ///      records (incl. the ~22k global anti-replay SSTORE each). 256
    ///      records is a sane per-transaction ceiling on Base (execution
    ///      ~18M plus ~2-3M tx-intrinsic calldata). The protocol caps one
    ///      commitment's sole batch at 256 records, and the global
    ///      anchored-exchange registry means a signed exchange can never be
    ///      replayed across roots, commitments, or verifiers to multiply
    ///      delegate accrual.
    function test_anchor256RecordsGasUnder20M() public {
        uint256 gasUsed = _anchorGas(256, "g256");
        emit log_named_uint("anchor 256 signed records: total execution gas", gasUsed);
        assertLt(gasUsed, 20_000_000, "anchor of 256 records must stay under 20M execution gas");
    }
}
