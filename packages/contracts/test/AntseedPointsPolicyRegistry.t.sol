// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

import { IAntseedPointsPenaltyPolicy } from "../interfaces/IAntseedPointsPenaltyPolicy.sol";
import { AntseedPointsPolicyRegistry } from "../policies/AntseedPointsPolicyRegistry.sol";

contract FixedPointsPenaltyPolicy is IAntseedPointsPenaltyPolicy {
    bytes32 private immutable _category;
    uint16 private immutable _sellerPenaltyBps;
    uint16 private immutable _buyerPenaltyBps;

    constructor(bytes32 category_, uint16 sellerPenaltyBps_, uint16 buyerPenaltyBps_) {
        _category = category_;
        _sellerPenaltyBps = sellerPenaltyBps_;
        _buyerPenaltyBps = buyerPenaltyBps_;
    }

    function penaltyCategory() external view returns (bytes32) {
        return _category;
    }

    function penaltyBps(bytes32, address, address, uint256) external view returns (uint16, uint16) {
        return (_sellerPenaltyBps, _buyerPenaltyBps);
    }
}

contract RevertingPointsPenaltyPolicy is IAntseedPointsPenaltyPolicy {
    function penaltyCategory() external pure returns (bytes32) {
        return keccak256("reverting");
    }

    function penaltyBps(bytes32, address, address, uint256) external pure returns (uint16, uint16) {
        revert("policy broken");
    }
}

contract GasBurningPointsPenaltyPolicy is IAntseedPointsPenaltyPolicy {
    function penaltyCategory() external pure returns (bytes32) {
        return keccak256("gas-burning");
    }

    function penaltyBps(bytes32, address, address, uint256) external view returns (uint16, uint16) {
        while (gasleft() > 0) { }
        return (0, 0);
    }
}

contract InvalidPointsPenaltyPolicy is IAntseedPointsPenaltyPolicy {
    function penaltyCategory() external pure returns (bytes32) {
        return keccak256("invalid-penalty");
    }

    function penaltyBps(bytes32, address, address, uint256) external pure returns (uint16, uint16) {
        return (10_001, 0);
    }
}

contract MalformedPointsPenaltyPolicy {
    function penaltyCategory() external pure returns (bytes32) {
        return keccak256("malformed");
    }

    fallback() external {
        assembly {
            mstore(0, 1)
            return(0, 32)
        }
    }
}

contract MissingPointsPenaltyPolicy {
    function penaltyCategory() external pure returns (bytes32) {
        return keccak256("missing");
    }
}

contract AntseedPointsPolicyRegistryTest is Test {
    bytes32 internal constant VERIFICATION_CATEGORY = keccak256("verification");
    bytes32 internal constant SYBIL_CATEGORY = keccak256("sybil");
    bytes32 internal constant WASH_TRADING_CATEGORY = keccak256("wash-trading");

    AntseedPointsPolicyRegistry internal registry;

    function setUp() public {
        registry = new AntseedPointsPolicyRegistry(address(this));
    }

    function _policy(bytes32 category, uint16 sellerPenaltyBps, uint16 buyerPenaltyBps)
        internal
        returns (FixedPointsPenaltyPolicy)
    {
        return new FixedPointsPenaltyPolicy(category, sellerPenaltyBps, buyerPenaltyBps);
    }

    function test_emptyRegistryPassesRawPointsThrough() public view {
        (uint256 sellerPoints, uint256 buyerPoints) =
            registry.points(keccak256("channel"), address(0xB0B), address(0xA11CE), 1_000);

        assertEq(sellerPoints, 1_000);
        assertEq(buyerPoints, 1_000);
        assertEq(registry.policyCount(), 0);
    }

    function test_addsPenaltiesAcrossDistinctCategories() public {
        registry.registerPolicy(address(_policy(VERIFICATION_CATEGORY, 1_000, 2_000)));
        registry.registerPolicy(address(_policy(SYBIL_CATEGORY, 2_000, 1_000)));

        (uint256 sellerPoints, uint256 buyerPoints) =
            registry.points(keccak256("channel"), address(0xB0B), address(0xA11CE), 1_000);

        assertEq(sellerPoints, 700);
        assertEq(buyerPoints, 700);
    }

    function test_usesMaximumPenaltyWithinEachCategory() public {
        registry.registerPolicy(address(_policy(VERIFICATION_CATEGORY, 1_000, 4_000)));
        registry.registerPolicy(address(_policy(VERIFICATION_CATEGORY, 3_000, 2_000)));

        (uint256 sellerPoints, uint256 buyerPoints) =
            registry.points(keccak256("channel"), address(0xB0B), address(0xA11CE), 1_000);

        assertEq(sellerPoints, 700);
        assertEq(buyerPoints, 600);
    }

    function test_penaltyAggregationIsOrderIndependent() public {
        FixedPointsPenaltyPolicy verificationPolicy = _policy(VERIFICATION_CATEGORY, 1_000, 4_000);
        FixedPointsPenaltyPolicy sybilPolicy = _policy(SYBIL_CATEGORY, 3_000, 2_000);
        registry.registerPolicy(address(verificationPolicy));
        registry.registerPolicy(address(sybilPolicy));

        AntseedPointsPolicyRegistry reverseRegistry = new AntseedPointsPolicyRegistry(address(this));
        reverseRegistry.registerPolicy(address(sybilPolicy));
        reverseRegistry.registerPolicy(address(verificationPolicy));

        (uint256 sellerPoints, uint256 buyerPoints) =
            registry.points(keccak256("channel"), address(0xB0B), address(0xA11CE), 1_000);
        (uint256 reverseSellerPoints, uint256 reverseBuyerPoints) =
            reverseRegistry.points(keccak256("channel"), address(0xB0B), address(0xA11CE), 1_000);

        assertEq(sellerPoints, reverseSellerPoints);
        assertEq(buyerPoints, reverseBuyerPoints);
        assertEq(sellerPoints, 600);
        assertEq(buyerPoints, 400);
    }

    function test_softPenaltiesCapAtNineThousandBps() public {
        registry.registerPolicy(address(_policy(VERIFICATION_CATEGORY, 6_000, 7_000)));
        registry.registerPolicy(address(_policy(SYBIL_CATEGORY, 6_000, 7_000)));

        (uint256 sellerPoints, uint256 buyerPoints) =
            registry.points(keccak256("channel"), address(0xB0B), address(0xA11CE), 1_000);

        assertEq(sellerPoints, 100);
        assertEq(buyerPoints, 100);
    }

    function test_tenThousandBpsIsAHardVeto() public {
        registry.registerPolicy(address(_policy(VERIFICATION_CATEGORY, 2_000, 3_000)));
        registry.registerPolicy(address(_policy(WASH_TRADING_CATEGORY, 10_000, 10_000)));
        registry.registerPolicy(address(_policy(SYBIL_CATEGORY, 4_000, 1_000)));

        (uint256 sellerPoints, uint256 buyerPoints) =
            registry.points(keccak256("channel"), address(0xB0B), address(0xA11CE), 1_000);

        assertEq(sellerPoints, 0);
        assertEq(buyerPoints, 0);
    }

    function test_removePreservesOrderAndReregisterMovesPolicyToEnd() public {
        FixedPointsPenaltyPolicy firstPolicy = _policy(VERIFICATION_CATEGORY, 1_000, 2_000);
        FixedPointsPenaltyPolicy middlePolicy = _policy(SYBIL_CATEGORY, 2_000, 1_000);
        FixedPointsPenaltyPolicy lastPolicy = _policy(WASH_TRADING_CATEGORY, 0, 0);
        registry.registerPolicy(address(firstPolicy));
        registry.registerPolicy(address(middlePolicy));
        registry.registerPolicy(address(lastPolicy));

        registry.removePolicy(address(middlePolicy));

        assertEq(registry.policyCount(), 2);
        assertEq(registry.policyAt(0), address(firstPolicy));
        assertEq(registry.policyAt(1), address(lastPolicy));
        assertEq(registry.policyCategory(address(firstPolicy)), VERIFICATION_CATEGORY);
        assertFalse(registry.isPolicyRegistered(address(middlePolicy)));

        registry.registerPolicy(address(middlePolicy));
        assertEq(registry.policyAt(2), address(middlePolicy));
    }

    function test_registrationValidationAndOwnerChecks() public {
        address outsider = makeAddr("outsider");
        FixedPointsPenaltyPolicy validPolicy = _policy(VERIFICATION_CATEGORY, 1_000, 2_000);

        vm.prank(outsider);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", outsider));
        registry.registerPolicy(address(validPolicy));

        vm.expectRevert(AntseedPointsPolicyRegistry.InvalidPolicy.selector);
        registry.registerPolicy(address(0));
        vm.expectRevert(AntseedPointsPolicyRegistry.InvalidPolicy.selector);
        registry.registerPolicy(address(registry));
        vm.expectRevert(AntseedPointsPolicyRegistry.InvalidPolicy.selector);
        registry.registerPolicy(makeAddr("eoa"));
        address zeroCategoryPolicy = address(_policy(bytes32(0), 0, 0));
        vm.expectRevert(AntseedPointsPolicyRegistry.InvalidPolicy.selector);
        registry.registerPolicy(zeroCategoryPolicy);

        registry.registerPolicy(address(validPolicy));
        assertTrue(registry.isPolicyRegistered(address(validPolicy)));

        vm.expectRevert(
            abi.encodeWithSelector(AntseedPointsPolicyRegistry.PolicyAlreadyRegistered.selector, address(validPolicy))
        );
        registry.registerPolicy(address(validPolicy));

        vm.prank(outsider);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", outsider));
        registry.removePolicy(address(validPolicy));

        address unknownPolicy = address(_policy(SYBIL_CATEGORY, 0, 0));
        vm.expectRevert(abi.encodeWithSelector(AntseedPointsPolicyRegistry.PolicyNotRegistered.selector, unknownPolicy));
        registry.removePolicy(unknownPolicy);
    }

    function test_registryRejectsMoreThanEightPolicies() public {
        for (uint256 i = 0; i < registry.MAX_POLICIES(); ++i) {
            registry.registerPolicy(address(_policy(bytes32(i + 1), 0, 0)));
        }

        assertEq(registry.policyCount(), 8);
        address ninthPolicy = address(_policy(bytes32(uint256(9)), 0, 0));
        vm.expectRevert(AntseedPointsPolicyRegistry.TooManyPolicies.selector);
        registry.registerPolicy(ninthPolicy);
    }

    function test_revertingPolicyFailsTheCompleteEvaluation() public {
        address brokenPolicy = address(new RevertingPointsPenaltyPolicy());
        registry.registerPolicy(brokenPolicy);

        vm.expectRevert(
            abi.encodeWithSelector(AntseedPointsPolicyRegistry.PolicyEvaluationFailed.selector, brokenPolicy, 0)
        );
        registry.points(keccak256("channel"), address(0xB0B), address(0xA11CE), 1_000);
    }

    function test_gasBurningPolicyIsBoundedAndFailsTheCompleteEvaluation() public {
        address brokenPolicy = address(new GasBurningPointsPenaltyPolicy());
        registry.registerPolicy(brokenPolicy);

        vm.expectRevert(
            abi.encodeWithSelector(AntseedPointsPolicyRegistry.PolicyEvaluationFailed.selector, brokenPolicy, 0)
        );
        registry.points(keccak256("channel"), address(0xB0B), address(0xA11CE), 1_000);
    }

    function test_malformedOrMissingPolicyReturnFailsTheCompleteEvaluation() public {
        address malformedPolicy = address(new MalformedPointsPenaltyPolicy());
        registry.registerPolicy(malformedPolicy);

        vm.expectRevert(
            abi.encodeWithSelector(AntseedPointsPolicyRegistry.PolicyEvaluationFailed.selector, malformedPolicy, 0)
        );
        registry.points(keccak256("channel"), address(0xB0B), address(0xA11CE), 1_000);

        registry.removePolicy(malformedPolicy);
        address missingPolicy = address(new MissingPointsPenaltyPolicy());
        registry.registerPolicy(missingPolicy);

        vm.expectRevert(
            abi.encodeWithSelector(AntseedPointsPolicyRegistry.PolicyEvaluationFailed.selector, missingPolicy, 0)
        );
        registry.points(keccak256("channel"), address(0xB0B), address(0xA11CE), 1_000);
    }

    function test_penaltyAboveTenThousandBpsFailsTheCompleteEvaluation() public {
        address invalidPolicy = address(new InvalidPointsPenaltyPolicy());
        registry.registerPolicy(invalidPolicy);

        vm.expectRevert(
            abi.encodeWithSelector(
                AntseedPointsPolicyRegistry.InvalidPenaltyBps.selector, invalidPolicy, 0, uint256(10_001), uint256(0)
            )
        );
        registry.points(keccak256("channel"), address(0xB0B), address(0xA11CE), 1_000);
    }

    function test_policyEvaluationGasSnapshots() public {
        vm.startSnapshotGas("points-policy-registry", "evaluate-zero-policies");
        registry.points(keccak256("zero"), address(0xB0B), address(0xA11CE), 1_000);
        uint256 zeroPolicyGas = vm.stopSnapshotGas();

        registry.registerPolicy(address(_policy(bytes32(uint256(1)), 100, 200)));
        vm.startSnapshotGas("points-policy-registry", "evaluate-one-policy");
        registry.points(keccak256("one"), address(0xB0B), address(0xA11CE), 1_000);
        uint256 onePolicyGas = vm.stopSnapshotGas();

        for (uint256 i = 1; i < registry.MAX_POLICIES(); ++i) {
            registry.registerPolicy(address(_policy(bytes32(i + 1), 100, 200)));
        }
        vm.startSnapshotGas("points-policy-registry", "evaluate-eight-policies");
        registry.points(keccak256("eight"), address(0xB0B), address(0xA11CE), 1_000);
        uint256 eightPolicyGas = vm.stopSnapshotGas();

        assertGt(onePolicyGas, zeroPolicyGas);
        assertGt(eightPolicyGas, onePolicyGas);
    }
}
