// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";

import { AntseedSellerRewardPolicyRegistry } from "../policies/AntseedSellerRewardPolicyRegistry.sol";

contract MockSellerRewardPolicy {
    bool internal immutable _unlockedAllowed;
    uint256 internal immutable _claimableAmount;
    bool internal immutable _reverts;

    constructor(bool unlockedAllowed_, uint256 claimableAmount_, bool reverts_) {
        _unlockedAllowed = unlockedAllowed_;
        _claimableAmount = claimableAmount_;
        _reverts = reverts_;
    }

    function canClaimSellerUnlocked(address) external view returns (bool) {
        if (_reverts) revert("policy failure");
        return _unlockedAllowed;
    }

    function claimableSellerRewards(address, uint256) external view returns (uint256) {
        if (_reverts) revert("policy failure");
        return _claimableAmount;
    }
}

contract MockUnlockOnlyPolicy {
    function canClaimSellerUnlocked(address) external pure returns (bool) {
        return true;
    }
}

contract MockClaimOnlyPolicy {
    function claimableSellerRewards(address, uint256 lockedAmount) external pure returns (uint256) {
        return lockedAmount / 2;
    }
}

contract MalformedSellerRewardPolicy { }

contract InvalidBoolSellerRewardPolicy {
    function canClaimSellerUnlocked(address) external pure returns (bool) {
        assembly {
            mstore(0, 2)
            return(0, 32)
        }
    }
}

contract SellerRewardPolicyRegistryTest is Test {
    address internal constant SELLER = address(0xA11CE);
    uint256 internal constant LOCKED = 100 ether;

    AntseedSellerRewardPolicyRegistry internal registry;

    function setUp() public {
        registry = new AntseedSellerRewardPolicyRegistry(address(this));
    }

    function test_unlockedClaimsUseDenyWinsComposition() public {
        registry.registerPolicy(address(new MockSellerRewardPolicy(true, LOCKED, false)), true, false);
        registry.registerPolicy(address(new MockSellerRewardPolicy(false, LOCKED, false)), true, false);
        assertFalse(registry.canClaimSellerUnlocked(SELLER));
    }

    function test_lockedClaimsUseMinimumApplicableAmount() public {
        registry.registerPolicy(address(new MockSellerRewardPolicy(true, 80 ether, false)), false, true);
        registry.registerPolicy(address(new MockSellerRewardPolicy(true, 30 ether, false)), false, true);
        assertEq(registry.claimableSellerRewards(SELLER, LOCKED), 30 ether);
    }

    function test_applicabilityFlagsKeepRoutesIndependent() public {
        registry.registerPolicy(address(new MockUnlockOnlyPolicy()), true, false);
        registry.registerPolicy(address(new MockClaimOnlyPolicy()), false, true);
        assertTrue(registry.canClaimSellerUnlocked(SELLER));
        assertEq(registry.claimableSellerRewards(SELLER, LOCKED), LOCKED / 2);
    }

    function test_emptyApplicablePolicyListsFailClosed() public {
        assertFalse(registry.canClaimSellerUnlocked(SELLER));
        assertEq(registry.claimableSellerRewards(SELLER, LOCKED), 0);

        registry.registerPolicy(address(new MockUnlockOnlyPolicy()), true, false);
        assertEq(registry.claimableSellerRewards(SELLER, LOCKED), 0);
    }

    function test_revertingAndMalformedPoliciesFailClosed() public {
        registry.registerPolicy(address(new MockSellerRewardPolicy(true, LOCKED, true)), true, true);
        assertFalse(registry.canClaimSellerUnlocked(SELLER));
        assertEq(registry.claimableSellerRewards(SELLER, LOCKED), 0);

        AntseedSellerRewardPolicyRegistry malformedRegistry = new AntseedSellerRewardPolicyRegistry(address(this));
        malformedRegistry.registerPolicy(address(new MalformedSellerRewardPolicy()), true, true);
        assertFalse(malformedRegistry.canClaimSellerUnlocked(SELLER));
        assertEq(malformedRegistry.claimableSellerRewards(SELLER, LOCKED), 0);
    }

    function test_invalidPolicyOutputsFailClosed() public {
        registry.registerPolicy(address(new InvalidBoolSellerRewardPolicy()), true, false);
        assertFalse(registry.canClaimSellerUnlocked(SELLER));

        registry.registerPolicy(address(new MockSellerRewardPolicy(true, LOCKED + 1, false)), false, true);
        assertEq(registry.claimableSellerRewards(SELLER, LOCKED), 0);
    }

    function test_removalUpdatesCountsAndOrdering() public {
        MockSellerRewardPolicy first = new MockSellerRewardPolicy(true, LOCKED, false);
        MockSellerRewardPolicy second = new MockSellerRewardPolicy(true, LOCKED / 2, false);
        registry.registerPolicy(address(first), true, false);
        registry.registerPolicy(address(second), false, true);

        assertEq(registry.policyCount(), 2);
        assertEq(registry.unlockedClaimPolicyCount(), 1);
        assertEq(registry.lockedClaimPolicyCount(), 1);
        registry.removePolicy(address(first));
        assertEq(registry.policyCount(), 1);
        assertEq(registry.unlockedClaimPolicyCount(), 0);
        assertEq(registry.lockedClaimPolicyCount(), 1);
        assertFalse(registry.isPolicyRegistered(address(first)));
        AntseedSellerRewardPolicyRegistry.RegisteredPolicy memory registered = registry.policyAt(0);
        assertEq(registered.policy, address(second));
        assertFalse(registered.checksUnlockedClaims);
        assertTrue(registered.checksLockedClaims);
    }

    function test_registrationRejectsInvalidFlagsDuplicatesAndOverflow() public {
        MockSellerRewardPolicy policy = new MockSellerRewardPolicy(true, LOCKED, false);
        vm.expectRevert(AntseedSellerRewardPolicyRegistry.InvalidPolicy.selector);
        registry.registerPolicy(address(policy), false, false);
        registry.registerPolicy(address(policy), true, true);
        vm.expectRevert(
            abi.encodeWithSelector(AntseedSellerRewardPolicyRegistry.PolicyAlreadyRegistered.selector, address(policy))
        );
        registry.registerPolicy(address(policy), true, true);

        for (uint256 index = 1; index < registry.MAX_POLICIES(); ++index) {
            registry.registerPolicy(address(new MockSellerRewardPolicy(true, index, false)), true, true);
        }
        MockSellerRewardPolicy overflowPolicy = new MockSellerRewardPolicy(true, 9, false);
        vm.expectRevert(AntseedSellerRewardPolicyRegistry.TooManyPolicies.selector);
        registry.registerPolicy(address(overflowPolicy), true, true);
    }
}
