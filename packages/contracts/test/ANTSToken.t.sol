// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../ANTSToken.sol";
import "../AntseedRegistry.sol";

contract ANTSTokenTest is Test {
    ANTSToken public token;
    AntseedRegistry public antseedRegistry;
    address public owner;
    address public emissions;
    address public user1;
    address public user2;

    event TransfersEnabled();

    function setUp() public {
        owner = address(this);
        emissions = address(1);
        user1 = address(2);
        user2 = address(3);
        token = new ANTSToken();
        antseedRegistry = new AntseedRegistry();
        antseedRegistry.setEmissions(emissions);
    }

    function test_initialState() public view {
        assertEq(token.totalSupply(), 0);
        assertEq(token.name(), "AntSeed");
        assertEq(token.symbol(), "ANTS");
        assertEq(token.owner(), owner);
        assertFalse(token.transfersEnabled());
    }

    function test_setRegistry() public {
        token.setRegistry(address(antseedRegistry));
        assertEq(address(token.registry()), address(antseedRegistry));
    }

    function test_setRegistry_revert_notOwner() public {
        vm.prank(user1);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", user1));
        token.setRegistry(address(antseedRegistry));
    }

    function test_setRegistry_revert_zeroAddress() public {
        vm.expectRevert(ANTSToken.InvalidAddress.selector);
        token.setRegistry(address(0));
    }

    function test_mint() public {
        token.setRegistry(address(antseedRegistry));
        vm.prank(emissions);
        token.mint(user1, 1000 ether);
        assertEq(token.balanceOf(user1), 1000 ether);
        assertEq(token.totalSupply(), 1000 ether);
    }

    function test_mint_revert_notEmissions() public {
        token.setRegistry(address(antseedRegistry));
        vm.prank(user1);
        vm.expectRevert(ANTSToken.NotEmissionsContract.selector);
        token.mint(user1, 100 ether);
    }

    function test_mint_revert_beforeRegistrySet() public {
        // registry not set, so registry.emissions() will revert
        vm.prank(user1);
        vm.expectRevert();
        token.mint(user1, 100 ether);
    }

    function test_mint_revert_zeroAddress() public {
        token.setRegistry(address(antseedRegistry));
        vm.prank(emissions);
        vm.expectRevert(ANTSToken.InvalidAddress.selector);
        token.mint(address(0), 100 ether);
    }

    function test_mint_worksWhenTransfersDisabled() public {
        assertFalse(token.transfersEnabled());
        token.setRegistry(address(antseedRegistry));
        vm.prank(emissions);
        token.mint(user1, 500 ether);
        assertEq(token.balanceOf(user1), 500 ether);
    }

    function test_transfer_revert_transfersDisabled() public {
        token.setRegistry(address(antseedRegistry));
        vm.prank(emissions);
        token.mint(user1, 100 ether);

        vm.prank(user1);
        vm.expectRevert(ANTSToken.TransfersNotEnabled.selector);
        token.transfer(user2, 50 ether);
    }

    function test_transferFrom_revert_transfersDisabled() public {
        token.setRegistry(address(antseedRegistry));
        vm.prank(emissions);
        token.mint(user1, 100 ether);

        vm.prank(user1);
        token.approve(user2, 50 ether);

        vm.prank(user2);
        vm.expectRevert(ANTSToken.TransfersNotEnabled.selector);
        token.transferFrom(user1, user2, 50 ether);
    }

    function test_enableTransfers() public {
        vm.expectEmit(false, false, false, false);
        emit TransfersEnabled();
        token.enableTransfers();
        assertTrue(token.transfersEnabled());
    }

    function test_enableTransfers_revert_notOwner() public {
        vm.prank(user1);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", user1));
        token.enableTransfers();
    }

    function test_enableTransfers_revert_alreadyEnabled() public {
        token.enableTransfers();
        vm.expectRevert(ANTSToken.TransfersAlreadyEnabled.selector);
        token.enableTransfers();
    }

    function test_transfer_afterEnabled() public {
        token.setRegistry(address(antseedRegistry));
        vm.prank(emissions);
        token.mint(user1, 100 ether);
        token.enableTransfers();

        vm.prank(user1);
        token.transfer(user2, 40 ether);
        assertEq(token.balanceOf(user1), 60 ether);
        assertEq(token.balanceOf(user2), 40 ether);
    }

    function test_approve_transferFrom_afterEnabled() public {
        token.setRegistry(address(antseedRegistry));
        vm.prank(emissions);
        token.mint(user1, 100 ether);
        token.enableTransfers();

        vm.prank(user1);
        token.approve(user2, 60 ether);

        vm.prank(user2);
        token.transferFrom(user1, user2, 60 ether);
        assertEq(token.balanceOf(user1), 40 ether);
        assertEq(token.balanceOf(user2), 60 ether);
    }

    function test_transferOwnership() public {
        token.transferOwnership(user1);
        assertEq(token.owner(), user1);

        // New owner can call onlyOwner functions
        vm.prank(user1);
        token.enableTransfers();
        assertTrue(token.transfersEnabled());
    }

    function test_transferOwnership_revert_notOwner() public {
        vm.prank(user1);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", user1));
        token.transferOwnership(user2);
    }

    function test_setRegistry_canUpdateEmissions() public {
        // Set registry with one emissions address
        token.setRegistry(address(antseedRegistry));

        // Create a new registry with different emissions
        address newEmissions = address(0xBB);
        AntseedRegistry newRegistry = new AntseedRegistry();
        newRegistry.setEmissions(newEmissions);

        // Can update registry (not a one-time set)
        token.setRegistry(address(newRegistry));
        assertEq(address(token.registry()), address(newRegistry));
    }
}
