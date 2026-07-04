// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

import {ANTSToken} from "../core/ANTSToken.sol";
import {AntseedRegistry} from "../core/AntseedRegistry.sol";

/**
 * @title ANTSTokenMaxSupplyFuzz
 * @notice Net-new coverage: the MAX_SUPPLY mint cap, which the existing ANTSToken.t.sol does not
 *         exercise. The test contract registers itself as `emissions` so it can mint.
 */
contract ANTSTokenMaxSupplyFuzz is Test {
    AntseedRegistry registry;
    ANTSToken ants;
    address alice = address(0xA11CE);

    function setUp() public {
        registry = new AntseedRegistry();
        ants = new ANTSToken();
        ants.setRegistry(address(registry));
        registry.setEmissions(address(this)); // test == emissions minter
    }

    function testFuzz_mint_respectsMaxSupply(uint256 amount) public {
        uint256 cap = ants.MAX_SUPPLY();
        amount = bound(amount, cap + 1, type(uint256).max);
        vm.expectRevert(ANTSToken.MaxSupplyExceeded.selector);
        ants.mint(alice, amount);
    }

    function testFuzz_mint_uptoCapThenRejects(uint256 first) public {
        uint256 cap = ants.MAX_SUPPLY();
        first = bound(first, 1, cap);
        ants.mint(alice, first);
        assertEq(ants.totalSupply(), first);

        uint256 remaining = cap - first;
        if (remaining > 0) ants.mint(alice, remaining);
        assertEq(ants.totalSupply(), cap);

        vm.expectRevert(ANTSToken.MaxSupplyExceeded.selector);
        ants.mint(alice, 1);
    }
}
