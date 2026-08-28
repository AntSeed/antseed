// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";

import { IAntseedPointsPenaltyPolicy } from "../interfaces/IAntseedPointsPenaltyPolicy.sol";
import { AntseedPointsPolicyRegistry } from "../policies/AntseedPointsPolicyRegistry.sol";

contract MockPointsPenaltyPolicy is IAntseedPointsPenaltyPolicy {
    bytes32 internal immutable _category;
    uint16 internal immutable _sellerPenaltyBps;
    uint16 internal immutable _buyerPenaltyBps;
    bool internal immutable _reverts;

    constructor(bytes32 category_, uint16 sellerPenaltyBps_, uint16 buyerPenaltyBps_, bool reverts_) {
        _category = category_;
        _sellerPenaltyBps = sellerPenaltyBps_;
        _buyerPenaltyBps = buyerPenaltyBps_;
        _reverts = reverts_;
    }

    function penaltyCategory() external view returns (bytes32) {
        return _category;
    }

    function penaltyBps(bytes32, address, address, uint256)
        external
        view
        returns (uint16 sellerPenaltyBps, uint16 buyerPenaltyBps)
    {
        if (_reverts) revert("policy failure");
        return (_sellerPenaltyBps, _buyerPenaltyBps);
    }
}

contract MalformedPointsPenaltyPolicy {
    function penaltyCategory() external pure returns (bytes32) {
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

    function test_sameCategoryUsesLargestPenaltyPerSide() public {
        registry.registerPolicy(address(new MockPointsPenaltyPolicy(CATEGORY_A, 1_000, 2_000, false)));
        registry.registerPolicy(address(new MockPointsPenaltyPolicy(CATEGORY_A, 3_000, 500, false)));

        (uint256 sellerPoints, uint256 buyerPoints) = registry.points(CHANNEL_ID, BUYER, SELLER, 1_000);
        assertEq(sellerPoints, 700);
        assertEq(buyerPoints, 800);
    }

    function test_differentCategoriesAddPenalties() public {
        registry.registerPolicy(address(new MockPointsPenaltyPolicy(CATEGORY_A, 1_000, 2_000, false)));
        registry.registerPolicy(address(new MockPointsPenaltyPolicy(CATEGORY_B, 3_000, 500, false)));

        (uint256 sellerPoints, uint256 buyerPoints) = registry.points(CHANNEL_ID, BUYER, SELLER, 1_000);
        assertEq(sellerPoints, 600);
        assertEq(buyerPoints, 750);
    }

    function test_softPenaltiesCapAtNineThousandBps() public {
        registry.registerPolicy(address(new MockPointsPenaltyPolicy(CATEGORY_A, 8_000, 8_000, false)));
        registry.registerPolicy(address(new MockPointsPenaltyPolicy(CATEGORY_B, 3_000, 4_000, false)));

        (uint256 sellerPoints, uint256 buyerPoints) = registry.points(CHANNEL_ID, BUYER, SELLER, 1_000);
        assertEq(sellerPoints, 100);
        assertEq(buyerPoints, 100);
    }

    function test_hardVetoReducesOnlyAffectedSideToZero() public {
        registry.registerPolicy(address(new MockPointsPenaltyPolicy(CATEGORY_A, 10_000, 2_500, false)));

        (uint256 sellerPoints, uint256 buyerPoints) = registry.points(CHANNEL_ID, BUYER, SELLER, 1_000);
        assertEq(sellerPoints, 0);
        assertEq(buyerPoints, 750);
    }

    function test_registrationRemovalAndOrdering() public {
        MockPointsPenaltyPolicy first = new MockPointsPenaltyPolicy(CATEGORY_A, 100, 100, false);
        MockPointsPenaltyPolicy second = new MockPointsPenaltyPolicy(CATEGORY_B, 200, 200, false);
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

        MockPointsPenaltyPolicy policy = new MockPointsPenaltyPolicy(CATEGORY_A, 100, 100, false);
        registry.registerPolicy(address(policy));
        vm.expectRevert(
            abi.encodeWithSelector(AntseedPointsPolicyRegistry.PolicyAlreadyRegistered.selector, address(policy))
        );
        registry.registerPolicy(address(policy));
    }

    function test_registrationEnforcesPolicyLimit() public {
        for (uint256 index = 0; index < registry.MAX_POLICIES(); ++index) {
            registry.registerPolicy(
                address(new MockPointsPenaltyPolicy(bytes32(index + 1), uint16(index), uint16(index), false))
            );
        }
        MockPointsPenaltyPolicy overflowPolicy = new MockPointsPenaltyPolicy(bytes32(uint256(9)), 0, 0, false);
        vm.expectRevert(AntseedPointsPolicyRegistry.TooManyPolicies.selector);
        registry.registerPolicy(address(overflowPolicy));
    }

    function test_policyFailureAndMalformedOutputRevertEvaluation() public {
        MockPointsPenaltyPolicy revertingPolicy = new MockPointsPenaltyPolicy(CATEGORY_A, 0, 0, true);
        registry.registerPolicy(address(revertingPolicy));
        vm.expectRevert(
            abi.encodeWithSelector(
                AntseedPointsPolicyRegistry.PolicyEvaluationFailed.selector, address(revertingPolicy), uint256(0)
            )
        );
        registry.points(CHANNEL_ID, BUYER, SELLER, 1_000);

        registry.removePolicy(address(revertingPolicy));
        MalformedPointsPenaltyPolicy malformedPolicy = new MalformedPointsPenaltyPolicy();
        registry.registerPolicy(address(malformedPolicy));
        vm.expectRevert(
            abi.encodeWithSelector(
                AntseedPointsPolicyRegistry.PolicyEvaluationFailed.selector, address(malformedPolicy), uint256(0)
            )
        );
        registry.points(CHANNEL_ID, BUYER, SELLER, 1_000);
    }

    function test_penaltyAboveDenominatorRevertsEvaluation() public {
        MockPointsPenaltyPolicy policy = new MockPointsPenaltyPolicy(CATEGORY_A, 10_001, 0, false);
        registry.registerPolicy(address(policy));

        vm.expectRevert(
            abi.encodeWithSelector(
                AntseedPointsPolicyRegistry.InvalidPenaltyBps.selector,
                address(policy),
                uint256(0),
                uint256(10_001),
                uint256(0)
            )
        );
        registry.points(CHANNEL_ID, BUYER, SELLER, 1_000);
    }
}
