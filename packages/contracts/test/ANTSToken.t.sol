// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../ANTSToken.sol";

contract ANTSTokenTest is Test {
    ANTSToken public token;
    address public owner;
    address public emissions;
    address public user1;
    address public user2;

    event EmissionsContractSet(address indexed emissionsContract);
    event TransfersEnabled();

    function setUp() public {
        owner = address(this);
        emissions = address(1);
        user1 = address(2);
        user2 = address(3);
        token = new ANTSToken();
    }

    function test_initialState() public view {
        assertEq(token.totalSupply(), 0);
        assertEq(token.name(), "AntSeed");
        assertEq(token.symbol(), "ANTS");
        assertEq(token.owner(), owner);
        assertFalse(token.transfersEnabled());
    }

    function test_setEmissionsContract() public {
        vm.expectEmit(true, false, false, false);
        emit EmissionsContractSet(emissions);
        token.setEmissionsContract(emissions);
        assertEq(token.emissionsContract(), emissions);
        assertTrue(token.emissionsContractSet());
    }

    function test_setEmissionsContract_revert_notOwner() public {
        vm.prank(user1);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", user1));
        token.setEmissionsContract(emissions);
    }

    function test_setEmissionsContract_revert_alreadySet() public {
        token.setEmissionsContract(emissions);
        vm.expectRevert(ANTSToken.EmissionsAlreadySet.selector);
        token.setEmissionsContract(address(4));
    }

    function test_setEmissionsContract_revert_zeroAddress() public {
        vm.expectRevert(ANTSToken.InvalidAddress.selector);
        token.setEmissionsContract(address(0));
    }

    function test_mint() public {
        token.setEmissionsContract(emissions);
        vm.prank(emissions);
        token.mint(user1, 1000 ether);
        assertEq(token.balanceOf(user1), 1000 ether);
        assertEq(token.totalSupply(), 1000 ether);
    }

    function test_mint_revert_notEmissions() public {
        token.setEmissionsContract(emissions);
        vm.prank(user1);
        vm.expectRevert(ANTSToken.NotEmissionsContract.selector);
        token.mint(user1, 100 ether);
    }

    function test_mint_revert_beforeSet() public {
        // emissionsContract == address(0), so any caller (including address(0)) fails
        vm.prank(user1);
        vm.expectRevert(ANTSToken.NotEmissionsContract.selector);
        token.mint(user1, 100 ether);
    }

    function test_mint_revert_zeroAddress() public {
        token.setEmissionsContract(emissions);
        vm.prank(emissions);
        vm.expectRevert(ANTSToken.InvalidAddress.selector);
        token.mint(address(0), 100 ether);
    }

    function test_mint_worksWhenTransfersDisabled() public {
        assertFalse(token.transfersEnabled());
        token.setEmissionsContract(emissions);
        vm.prank(emissions);
        token.mint(user1, 500 ether);
        assertEq(token.balanceOf(user1), 500 ether);
    }

    function test_transfer_revert_transfersDisabled() public {
        token.setEmissionsContract(emissions);
        vm.prank(emissions);
        token.mint(user1, 100 ether);

        vm.prank(user1);
        vm.expectRevert(ANTSToken.TransfersNotEnabled.selector);
        token.transfer(user2, 50 ether);
    }

    function test_transferFrom_revert_transfersDisabled() public {
        token.setEmissionsContract(emissions);
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
        token.setEmissionsContract(emissions);
        vm.prank(emissions);
        token.mint(user1, 100 ether);
        token.enableTransfers();

        vm.prank(user1);
        token.transfer(user2, 40 ether);
        assertEq(token.balanceOf(user1), 60 ether);
        assertEq(token.balanceOf(user2), 40 ether);
    }

    function test_approve_transferFrom_afterEnabled() public {
        token.setEmissionsContract(emissions);
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
}
