// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";

import { IAntseedPointsModifier } from "../interfaces/IAntseedPointsModifier.sol";
import { AntseedPointsPolicyRegistry } from "../policies/AntseedPointsPolicyRegistry.sol";

contract MockPointsModifier is IAntseedPointsModifier {
    bytes32 internal immutable _category;
    uint16 internal immutable _sellerMultiplierBps;
    uint16 internal immutable _buyerMultiplierBps;
    bool internal immutable _reverts;

    constructor(bytes32 category_, uint16 sellerMultiplierBps_, uint16 buyerMultiplierBps_, bool reverts_) {
        _category = category_;
        _sellerMultiplierBps = sellerMultiplierBps_;
        _buyerMultiplierBps = buyerMultiplierBps_;
        _reverts = reverts_;
    }

    function modifierCategory() external view returns (bytes32) {
        return _category;
    }

    function pointsMultiplierBps(bytes32, address, address, uint256)
        external
        view
        returns (uint16 sellerMultiplierBps, uint16 buyerMultiplierBps)
    {
        if (_reverts) revert("policy failure");
        return (_sellerMultiplierBps, _buyerMultiplierBps);
    }
}

contract InvalidPointsModifier { }

contract MalformedPointsModifier {
    function modifierCategory() external pure returns (bytes32) {
        return keccak256("malformed");
    }
}

contract PointsPolicyRegistryTest is Test {
    bytes32 internal constant CHANNEL_ID = bytes32(uint256(7));
    address internal constant BUYER = address(0xB0B);
    address internal constant SELLER = address(0xA11CE);
    bytes32 internal constant CATEGORY_A = keccak256("category-a");
    bytes32 internal constant CATEGORY_B = keccak256("category-b");

    AntseedPointsPolicyRegistry internal registry;

    function setUp() public {
        registry = new AntseedPointsPolicyRegistry(address(this));
    }

    function test_emptyRegistryPassesRawPointsThrough() public view {
        (uint256 sellerPoints, uint256 buyerPoints) = registry.points(CHANNEL_ID, BUYER, SELLER, 1_000);
        assertEq(sellerPoints, 1_000);
        assertEq(buyerPoints, 1_000);
    }

    function test_sameCategoryUsesStrongestModifierPerSide() public {
        registry.registerPolicy(address(new MockPointsModifier(CATEGORY_A, 9_000, 12_000, false)));
        registry.registerPolicy(address(new MockPointsModifier(CATEGORY_A, 7_000, 10_500, false)));

        (uint256 sellerPoints, uint256 buyerPoints) = registry.points(CHANNEL_ID, BUYER, SELLER, 1_000);
        assertEq(sellerPoints, 700);
        assertEq(buyerPoints, 1_200);
    }

    function test_sameCategoryTieUsesLowerMultiplier() public {
        registry.registerPolicy(address(new MockPointsModifier(CATEGORY_A, 12_000, 10_000, false)));
        registry.registerPolicy(address(new MockPointsModifier(CATEGORY_A, 8_000, 10_000, false)));

        (uint256 sellerPoints,) = registry.points(CHANNEL_ID, BUYER, SELLER, 1_000);
        assertEq(sellerPoints, 800);
    }

    function test_differentCategoriesCombineReductionsAndBoosts() public {
        registry.registerPolicy(address(new MockPointsModifier(CATEGORY_A, 9_000, 12_000, false)));
        registry.registerPolicy(address(new MockPointsModifier(CATEGORY_B, 13_000, 9_500, false)));

        (uint256 sellerPoints, uint256 buyerPoints) = registry.points(CHANNEL_ID, BUYER, SELLER, 1_000);
        assertEq(sellerPoints, 1_200);
        assertEq(buyerPoints, 1_150);
    }

    function test_combinedModifiersRespectFloorAndCeiling() public {
        registry.registerPolicy(address(new MockPointsModifier(CATEGORY_A, 2_000, 18_000, false)));
        registry.registerPolicy(address(new MockPointsModifier(CATEGORY_B, 6_000, 15_000, false)));

        (uint256 sellerPoints, uint256 buyerPoints) = registry.points(CHANNEL_ID, BUYER, SELLER, 1_000);
        assertEq(sellerPoints, 100);
        assertEq(buyerPoints, 2_000);
    }

    function test_hardVetoReducesOnlyAffectedSideToZero() public {
        registry.registerPolicy(address(new MockPointsModifier(CATEGORY_A, 0, 12_500, false)));

        (uint256 sellerPoints, uint256 buyerPoints) = registry.points(CHANNEL_ID, BUYER, SELLER, 1_000);
        assertEq(sellerPoints, 0);
        assertEq(buyerPoints, 1_250);
    }

    function test_registrationRemovalAndOrdering() public {
        MockPointsModifier first = new MockPointsModifier(CATEGORY_A, 9_900, 9_900, false);
        MockPointsModifier second = new MockPointsModifier(CATEGORY_B, 10_200, 10_200, false);
        registry.registerPolicy(address(first));
        registry.registerPolicy(address(second));

        assertEq(registry.policyCount(), 2);
        assertTrue(registry.isPolicyRegistered(address(first)));
        (address policy, bytes32 category) = registry.policyAt(1);
        assertEq(policy, address(second));
        assertEq(category, CATEGORY_B);

        registry.removePolicy(address(first));
        assertEq(registry.policyCount(), 1);
        assertFalse(registry.isPolicyRegistered(address(first)));
        (policy, category) = registry.policyAt(0);
        assertEq(policy, address(second));
        assertEq(category, CATEGORY_B);
    }

    function test_registrationRejectsInvalidAndDuplicatePolicies() public {
        vm.expectRevert(AntseedPointsPolicyRegistry.InvalidPolicy.selector);
        registry.registerPolicy(address(0));
        vm.expectRevert(AntseedPointsPolicyRegistry.InvalidPolicy.selector);
        registry.registerPolicy(address(0xBEEF));
        InvalidPointsModifier invalidPolicy = new InvalidPointsModifier();
        vm.expectRevert(AntseedPointsPolicyRegistry.InvalidPolicy.selector);
        registry.registerPolicy(address(invalidPolicy));

        MockPointsModifier policy = new MockPointsModifier(CATEGORY_A, 10_000, 10_000, false);
        registry.registerPolicy(address(policy));
        vm.expectRevert(
            abi.encodeWithSelector(AntseedPointsPolicyRegistry.PolicyAlreadyRegistered.selector, address(policy))
        );
        registry.registerPolicy(address(policy));
    }

    function test_registrationEnforcesPolicyLimit() public {
        for (uint256 index = 0; index < registry.MAX_POLICIES(); ++index) {
            registry.registerPolicy(address(new MockPointsModifier(bytes32(index + 1), 10_000, 10_000, false)));
        }
        MockPointsModifier overflowPolicy = new MockPointsModifier(bytes32(uint256(9)), 10_000, 10_000, false);
        vm.expectRevert(AntseedPointsPolicyRegistry.TooManyPolicies.selector);
        registry.registerPolicy(address(overflowPolicy));
    }

    function test_policyFailureBubbles() public {
        MockPointsModifier revertingPolicy = new MockPointsModifier(CATEGORY_A, 10_000, 10_000, true);
        registry.registerPolicy(address(revertingPolicy));

        vm.expectRevert("policy failure");
        registry.points(CHANNEL_ID, BUYER, SELLER, 1_000);
    }

    function test_malformedPolicyRevertsEvaluation() public {
        registry.registerPolicy(address(new MalformedPointsModifier()));

        vm.expectRevert();
        registry.points(CHANNEL_ID, BUYER, SELLER, 1_000);
    }

    function test_multiplierAboveMaximumRevertsEvaluation() public {
        MockPointsModifier policy = new MockPointsModifier(CATEGORY_A, 20_001, 10_000, false);
        registry.registerPolicy(address(policy));

        vm.expectRevert(
            abi.encodeWithSelector(
                AntseedPointsPolicyRegistry.InvalidPointsMultiplier.selector,
                address(policy),
                uint256(0),
                uint256(20_001),
                uint256(10_000)
            )
        );
        registry.points(CHANNEL_ID, BUYER, SELLER, 1_000);
    }
}
