// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

import {ANTSToken} from "../ANTSToken.sol";
import {AntseedRegistry} from "../AntseedRegistry.sol";

/**
 * @title ANTSTokenGateFuzz
 * @notice Fuzz tests for the ANTSToken mint authorization, supply cap, and one-way transfer gate.
 *         The test contract registers itself as `emissions` so it can mint. Structural/safety
 *         properties, independent of emission economics.
 */
contract ANTSTokenGateFuzz is Test {
    AntseedRegistry registry;
    ANTSToken ants;

    address alice = address(0xA11CE);
    address bob = address(0xB0B);

    function setUp() public {
        registry = new AntseedRegistry();
        ants = new ANTSToken();
        ants.setRegistry(address(registry));
        registry.setEmissions(address(this)); // test contract == emissions minter
    }

    function _mint(address to, uint256 amount) internal {
        ants.mint(to, amount); // msg.sender == this == registry.emissions()
    }

    // ── mint authorization ─────────────────────────────────────────────────────
    function testFuzz_mint_onlyEmissions(address caller, uint256 amount) public {
        vm.assume(caller != address(this));
        amount = bound(amount, 1, ants.MAX_SUPPLY());

        vm.prank(caller);
        vm.expectRevert(ANTSToken.NotEmissionsContract.selector);
        ants.mint(alice, amount);
    }

    function test_mint_toZeroRejected() public {
        vm.expectRevert(ANTSToken.InvalidAddress.selector);
        ants.mint(address(0), 1);
    }

    // ── supply cap ──────────────────────────────────────────────────────────────
    function testFuzz_mint_respectsMaxSupply(uint256 amount) public {
        uint256 cap = ants.MAX_SUPPLY();
        amount = bound(amount, cap + 1, type(uint256).max);

        vm.expectRevert(ANTSToken.MaxSupplyExceeded.selector);
        ants.mint(alice, amount);
    }

    function testFuzz_mint_uptoCapThenRejects(uint256 first) public {
        uint256 cap = ants.MAX_SUPPLY();
        first = bound(first, 1, cap);
        _mint(alice, first);
        assertEq(ants.totalSupply(), first);

        // Exactly filling the cap is fine; one more wei reverts.
        uint256 remaining = cap - first;
        if (remaining > 0) _mint(alice, remaining);
        assertEq(ants.totalSupply(), cap);

        vm.expectRevert(ANTSToken.MaxSupplyExceeded.selector);
        _mint(alice, 1);
    }

    // ── transfer gate ───────────────────────────────────────────────────────────
    function testFuzz_transferBlockedBeforeEnable(uint256 amount) public {
        amount = bound(amount, 1, ants.MAX_SUPPLY());
        _mint(alice, amount); // minting (from == 0) is always allowed

        vm.prank(alice);
        vm.expectRevert(ANTSToken.TransfersNotEnabled.selector);
        ants.transfer(bob, amount);
    }

    function testFuzz_transferAllowedAfterEnable(uint256 amount) public {
        amount = bound(amount, 1, ants.MAX_SUPPLY());
        _mint(alice, amount);

        ants.enableTransfers();

        vm.prank(alice);
        ants.transfer(bob, amount);
        assertEq(ants.balanceOf(bob), amount);
    }

    function testFuzz_whitelistedCanTransferBeforeEnable(uint256 amount) public {
        amount = bound(amount, 1, ants.MAX_SUPPLY());
        _mint(alice, amount);

        ants.setTransferWhitelist(alice, true);

        vm.prank(alice);
        ants.transfer(bob, amount); // allowed despite transfers not globally enabled
        assertEq(ants.balanceOf(bob), amount);
    }

    /// @notice Receiving (mint, from == 0) is always allowed even pre-enable; the gate only
    ///         restricts the sender.
    function testFuzz_mintIsAlwaysAllowed(uint256 amount) public {
        amount = bound(amount, 1, ants.MAX_SUPPLY());
        _mint(bob, amount);
        assertEq(ants.balanceOf(bob), amount);
        assertFalse(ants.transfersEnabled());
    }

    // ── one-way enable ────────────────────────────────────────────────────────────
    function test_enableTransfers_isOneWay() public {
        ants.enableTransfers();
        assertTrue(ants.transfersEnabled());

        vm.expectRevert(ANTSToken.TransfersAlreadyEnabled.selector);
        ants.enableTransfers();
    }

    function test_enableTransfers_onlyOwner() public {
        vm.prank(alice);
        vm.expectRevert(); // Ownable: caller is not the owner
        ants.enableTransfers();
    }

    function test_setTransferWhitelist_onlyOwner() public {
        vm.prank(alice);
        vm.expectRevert();
        ants.setTransferWhitelist(bob, true);
    }
}
