// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

import { AntseedRegistryV2 } from "../../core/AntseedRegistryV2.sol";
import { AntseedVerifierPointsPolicy } from "../../verification/AntseedVerifierPointsPolicy.sol";
import { AntseedVerifierRegistry } from "../../verification/AntseedVerifierRegistry.sol";
import { MockERC8004Registry } from "../mocks/MockERC8004Registry.sol";

contract MockEpochClock {
    uint256 public currentEpoch;

    function setCurrentEpoch(uint256 epoch) external {
        currentEpoch = epoch;
    }
}

contract MockStaking {
    mapping(address => uint256) public agentIds;
    bool public shouldRevert;

    function setAgentId(address seller, uint256 agentId) external {
        agentIds[seller] = agentId;
    }

    function setShouldRevert(bool value) external {
        shouldRevert = value;
    }

    function getAgentId(address seller) external view returns (uint256) {
        if (shouldRevert) revert("MockStaking: forced revert");
        return agentIds[seller];
    }
}

contract AntseedVerifierPointsPolicyTest is Test {
    AntseedRegistryV2 registry;
    MockERC8004Registry identity;
    MockEpochClock clock;
    MockStaking staking;
    AntseedVerifierRegistry verifierRegistry;
    AntseedVerifierPointsPolicy policy;

    address verifier = address(0x1001);
    address secondVerifier = address(0x1002);
    address outsider = address(0x1003);
    address seller = address(0x3001);
    address buyer = address(0x4001);

    uint256 agentId;
    bytes32 constant CHANNEL_ID = keccak256("channel");
    bytes32 constant SERVICE_HASH = keccak256("model:gpt-99");
    bytes32 constant EVIDENCE_HASH = keccak256("evidence");
    uint256 constant RAW_POINTS = 1_000_000;
    uint256 commitSalt;

    event DiffPenaltyBpsSet(uint16 diffPenaltyBps);
    event MinDistinctDiffVerifiersSet(uint16 minDistinctDiffVerifiers);

    function setUp() public {
        vm.warp(1_700_000_000);

        registry = new AntseedRegistryV2();
        identity = new MockERC8004Registry();
        clock = new MockEpochClock();
        staking = new MockStaking();
        clock.setCurrentEpoch(5);
        registry.setIdentityRegistry(address(identity));
        registry.setEmissions(address(clock));
        registry.setStaking(address(staking));

        verifierRegistry = new AntseedVerifierRegistry(address(registry));
        verifierRegistry.setVerifier(verifier, true);
        verifierRegistry.setVerifier(secondVerifier, true);

        policy = new AntseedVerifierPointsPolicy(address(registry), address(verifierRegistry));

        agentId = identity.register();
        identity.setOwner(agentId, seller);
        staking.setAgentId(seller, agentId);
    }

    function _commitAndAttest(uint256 agentId_, uint8 verdict) internal {
        _commitAndAttestFrom(verifier, agentId_, verdict);
    }

    function _commitAndAttestFrom(address verifier_, uint256 agentId_, uint8 verdict) internal {
        bytes32 commitment = keccak256(abi.encode(verifier_, ++commitSalt));
        vm.prank(verifier_);
        verifierRegistry.commitProbeSet(commitment);
        vm.warp(block.timestamp + 1);
        vm.prank(verifier_);
        verifierRegistry.submitAttestation(agentId_, SERVICE_HASH, verdict, EVIDENCE_HASH, commitment, 10, 3);
    }

    /// @dev DIFF standing from two distinct verifiers — the default
    ///      corroboration threshold for the penalty to fire.
    function _flagAgent() internal {
        _commitAndAttestFrom(verifier, agentId, 2);
        _commitAndAttestFrom(secondVerifier, agentId, 2);
    }

    function _points(uint256 rawPoints) internal view returns (uint256 sellerPoints, uint256 buyerPoints) {
        return policy.points(CHANNEL_ID, buyer, seller, rawPoints);
    }

    function _assertPassThrough(uint256 rawPoints) internal view {
        (uint256 sellerPoints, uint256 buyerPoints) = _points(rawPoints);
        assertEq(sellerPoints, rawPoints, "sellerPoints pass-through");
        assertEq(buyerPoints, rawPoints, "buyerPoints pass-through");
    }

    // ─── Constructor & defaults ──────────────────────────────────────

    function test_constructorZeroAddressesRevert() public {
        vm.expectRevert(AntseedVerifierPointsPolicy.InvalidAddress.selector);
        new AntseedVerifierPointsPolicy(address(0), address(verifierRegistry));
        vm.expectRevert(AntseedVerifierPointsPolicy.InvalidAddress.selector);
        new AntseedVerifierPointsPolicy(address(registry), address(0));
    }

    function test_defaults() public view {
        assertEq(policy.diffPenaltyBps(), 10_000);
        assertEq(policy.minDistinctDiffVerifiers(), 2);
        assertEq(address(policy.registry()), address(registry));
        assertEq(address(policy.verifierRegistry()), address(verifierRegistry));
        assertEq(policy.owner(), address(this));
    }

    // ─── Owner config ────────────────────────────────────────────────

    function test_setDiffPenaltyBpsOnlyOwner() public {
        vm.prank(outsider);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", outsider));
        policy.setDiffPenaltyBps(5000);
    }

    function test_setDiffPenaltyBpsBoundsAndEmits() public {
        vm.expectRevert(AntseedVerifierPointsPolicy.InvalidValue.selector);
        policy.setDiffPenaltyBps(10_001);

        vm.expectEmit(false, false, false, true);
        emit DiffPenaltyBpsSet(5000);
        policy.setDiffPenaltyBps(5000);
        assertEq(policy.diffPenaltyBps(), 5000);
    }

    function test_setMinDistinctDiffVerifiersOnlyOwner() public {
        vm.prank(outsider);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", outsider));
        policy.setMinDistinctDiffVerifiers(1);
    }

    function test_setMinDistinctDiffVerifiersBoundsAndEmits() public {
        vm.expectRevert(AntseedVerifierPointsPolicy.InvalidValue.selector);
        policy.setMinDistinctDiffVerifiers(0);

        vm.expectEmit(false, false, false, true);
        emit MinDistinctDiffVerifiersSet(3);
        policy.setMinDistinctDiffVerifiers(3);
        assertEq(policy.minDistinctDiffVerifiers(), 3);
    }

    // ─── Pass-through paths ──────────────────────────────────────────

    function test_unregisteredSellerPassesThrough() public {
        staking.setAgentId(seller, 0);
        _assertPassThrough(RAW_POINTS);
    }

    function test_cleanUnauditedAgentPassesThrough() public view {
        _assertPassThrough(RAW_POINTS);
    }

    function test_cleanAuditedAgentPassesThrough() public {
        _commitAndAttest(agentId, 1); // SAME
        _commitAndAttest(agentId, 3); // UNDETERMINED
        _assertPassThrough(RAW_POINTS);
    }

    function test_revertingStakingPassesThrough() public {
        _commitAndAttest(agentId, 2); // DIFF — would be penalized if resolvable
        staking.setShouldRevert(true);
        _assertPassThrough(RAW_POINTS);
    }

    function test_unsetStakingPassesThrough() public {
        // A registry whose staking address was never set resolves to
        // address(0) — the policy must not revert and passes through.
        AntseedRegistryV2 bareRegistry = new AntseedRegistryV2();
        AntseedVerifierPointsPolicy barePolicy =
            new AntseedVerifierPointsPolicy(address(bareRegistry), address(verifierRegistry));
        (uint256 sellerPoints, uint256 buyerPoints) = barePolicy.points(CHANNEL_ID, buyer, seller, RAW_POINTS);
        assertEq(sellerPoints, RAW_POINTS);
        assertEq(buyerPoints, RAW_POINTS);
    }

    function test_codelessStakingPassesThrough() public {
        // Staking mispointed at an EOA: the code-size guard skips the call
        // (a decode failure on empty returndata would NOT be caught by
        // try/catch) and the policy passes through.
        registry.setStaking(address(0xDEAD));
        _commitAndAttest(agentId, 2);
        _assertPassThrough(RAW_POINTS);
    }

    function test_codelessRegistryAndVerifierRegistryPassThrough() public {
        // Both constructor targets without code: never revert, pass through.
        AntseedVerifierPointsPolicy miswired =
            new AntseedVerifierPointsPolicy(address(0xBEEF), address(0xCAFE));
        (uint256 sellerPoints, uint256 buyerPoints) = miswired.points(CHANNEL_ID, buyer, seller, RAW_POINTS);
        assertEq(sellerPoints, RAW_POINTS);
        assertEq(buyerPoints, RAW_POINTS);
    }

    // ─── Diff penalty shaping ────────────────────────────────────────

    function test_corroboratedDiffZeroesSellerPointsByDefault() public {
        _flagAgent(); // DIFF from two distinct verifiers
        (uint256 sellerPoints, uint256 buyerPoints) = _points(RAW_POINTS);
        assertEq(sellerPoints, 0, "seller points zeroed");
        assertEq(buyerPoints, RAW_POINTS, "buyer points untouched");
    }

    function test_singleVerifierDiffDoesNotPenalize() public {
        // One accusation — mistaken, malicious, or fed by a colluding
        // cohort — is below the default corroboration threshold.
        _commitAndAttest(agentId, 2); // DIFF from a single verifier
        _assertPassThrough(RAW_POINTS);
    }

    function test_retractionRestoresSellerPoints() public {
        _flagAgent();
        (uint256 sellerPoints,) = _points(RAW_POINTS);
        assertEq(sellerPoints, 0, "flagged while both accusations stand");

        // One accuser re-audits and finds SAME: its standing DIFF is
        // retracted and the penalty clears — the flag is reversible, not a
        // permanent historical mark.
        _commitAndAttestFrom(secondVerifier, agentId, 1);
        _assertPassThrough(RAW_POINTS);

        // It re-fires if the accusation returns.
        _commitAndAttestFrom(secondVerifier, agentId, 2);
        (sellerPoints,) = _points(RAW_POINTS);
        assertEq(sellerPoints, 0);
    }

    function test_repeatDiffFromSameVerifierStaysBelowThreshold() public {
        // The same verifier attesting DIFF repeatedly is still one accuser.
        _commitAndAttest(agentId, 2);
        _commitAndAttest(agentId, 2);
        _commitAndAttest(agentId, 2);
        _assertPassThrough(RAW_POINTS);
    }

    function test_thresholdOneAllowsSingleVerifierPenalty() public {
        policy.setMinDistinctDiffVerifiers(1);
        _commitAndAttest(agentId, 2);
        (uint256 sellerPoints,) = _points(RAW_POINTS);
        assertEq(sellerPoints, 0);

        // Still reversible: the lone accuser retracting clears it.
        _commitAndAttest(agentId, 1);
        _assertPassThrough(RAW_POINTS);
    }

    function test_partialPenaltyAtHalfBps() public {
        policy.setDiffPenaltyBps(5000);
        _flagAgent();

        (uint256 sellerPoints, uint256 buyerPoints) = _points(RAW_POINTS);
        assertEq(sellerPoints, RAW_POINTS / 2);
        assertEq(buyerPoints, RAW_POINTS);

        // Floor rounding on amounts that do not divide evenly.
        (sellerPoints, buyerPoints) = _points(3);
        assertEq(sellerPoints, 1); // floor(3 * 5000 / 10000)
        assertEq(buyerPoints, 3);
    }

    function test_zeroPenaltyBpsPassesThroughEvenWhenFlagged() public {
        policy.setDiffPenaltyBps(0);
        _flagAgent();
        _assertPassThrough(RAW_POINTS);
    }

    function test_neverRevertsOnExtremeRawPoints() public {
        policy.setDiffPenaltyBps(5000);
        _flagAgent();

        // rawPoints * bps would overflow a naive multiplication; the policy
        // must survive the full uint256 range.
        uint256 raw = type(uint256).max;
        (uint256 sellerPoints, uint256 buyerPoints) = _points(raw);
        assertEq(buyerPoints, raw);
        assertEq(sellerPoints, (raw / 10_000) * 5000 + ((raw % 10_000) * 5000) / 10_000);
    }

    function testFuzz_neverRevertsAndBuyerAlwaysPassesThrough(
        uint256 rawPoints,
        uint16 penaltyBps,
        uint8 verdict
    ) public {
        penaltyBps = uint16(bound(penaltyBps, 0, 10_000));
        verdict = uint8(bound(verdict, 1, 3));
        policy.setDiffPenaltyBps(penaltyBps);
        // Threshold 1 keeps the penalty arithmetic exercised by a single
        // fuzzed attestation; corroboration semantics are covered above.
        policy.setMinDistinctDiffVerifiers(1);
        _commitAndAttest(agentId, verdict);

        (uint256 sellerPoints, uint256 buyerPoints) = _points(rawPoints);
        assertEq(buyerPoints, rawPoints, "buyer always passes through");
        assertLe(sellerPoints, rawPoints, "seller never exceeds raw");
        if (verdict != 2) assertEq(sellerPoints, rawPoints, "non-DIFF passes through");
    }
}
