// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../AntseedIdentity.sol";
import "../MockUSDC.sol";

contract AntseedIdentityTest is Test {
    AntseedIdentity public identity;
    MockUSDC public usdc;
    address public owner;
    address public peer1 = address(0x1);
    address public peer2 = address(0x2);

    bytes32 public peerId1 = keccak256("peer1");
    bytes32 public peerId2 = keccak256("peer2");

    function setUp() public {
        owner = address(this);
        usdc = new MockUSDC();
        identity = new AntseedIdentity(address(usdc));
    }

    function test_register() public {
        vm.prank(peer1);
        uint256 tokenId = identity.register(peerId1, "ipfs://meta1");

        assertTrue(identity.isRegistered(peer1));
        assertEq(identity.getTokenId(peer1), tokenId);
        assertEq(identity.tokenURI(tokenId), "ipfs://meta1");
    }

    function test_register_revert_alreadyRegistered() public {
        vm.prank(peer1);
        identity.register(peerId1, "ipfs://meta1");

        vm.prank(peer1);
        vm.expectRevert(AntseedIdentity.AlreadyRegistered.selector);
        identity.register(peerId2, "ipfs://meta2");
    }

    function test_register_revert_duplicatePeerId() public {
        vm.prank(peer1);
        identity.register(peerId1, "ipfs://meta1");

        vm.prank(peer2);
        vm.expectRevert(AntseedIdentity.PeerIdTaken.selector);
        identity.register(peerId1, "ipfs://meta2");
    }

    function test_updateMetadata() public {
        vm.prank(peer1);
        uint256 tokenId = identity.register(peerId1, "ipfs://meta1");

        vm.prank(peer1);
        identity.updateMetadata(tokenId, "ipfs://meta1-updated");

        assertEq(identity.tokenURI(tokenId), "ipfs://meta1-updated");
    }

    function test_updateMetadata_revert_notOwner() public {
        vm.prank(peer1);
        uint256 tokenId = identity.register(peerId1, "ipfs://meta1");

        vm.prank(peer2);
        vm.expectRevert(AntseedIdentity.NotTokenOwner.selector);
        identity.updateMetadata(tokenId, "ipfs://hacked");
    }

    function test_deregister() public {
        vm.prank(peer1);
        uint256 tokenId = identity.register(peerId1, "ipfs://meta1");

        vm.prank(peer1);
        identity.deregister(tokenId);

        assertFalse(identity.isRegistered(peer1));
    }

    function test_deregister_clearsMappings() public {
        vm.prank(peer1);
        uint256 tokenId = identity.register(peerId1, "ipfs://meta1");

        vm.prank(peer1);
        identity.deregister(tokenId);

        assertEq(identity.addressToTokenId(peer1), 0);
        assertEq(identity.peerIdToTokenId(peerId1), 0);
        assertEq(identity.tokenIdToPeerId(tokenId), bytes32(0));
    }

    function test_soulbound_revert_transfer() public {
        vm.prank(peer1);
        uint256 tokenId = identity.register(peerId1, "ipfs://meta1");

        vm.prank(peer1);
        vm.expectRevert(AntseedIdentity.NonTransferable.selector);
        identity.transferFrom(peer1, peer2, tokenId);
    }

    function test_soulbound_revert_safeTransfer() public {
        vm.prank(peer1);
        uint256 tokenId = identity.register(peerId1, "ipfs://meta1");

        vm.prank(peer1);
        vm.expectRevert(AntseedIdentity.NonTransferable.selector);
        identity.safeTransferFrom(peer1, peer2, tokenId);
    }

    function test_setSessionsContract() public {
        identity.setSessionsContract(address(0x99));
        assertEq(identity.sessionsContract(), address(0x99));
    }

    function test_setSessionsContract_revert_notOwner() public {
        vm.prank(peer1);
        vm.expectRevert(AntseedIdentity.NotOwner.selector);
        identity.setSessionsContract(address(0x99));
    }

    function test_getTokenId() public {
        vm.prank(peer1);
        uint256 tokenId = identity.register(peerId1, "ipfs://meta1");

        assertEq(identity.getTokenId(peer1), tokenId);
    }

    function test_getTokenIdByPeerId() public {
        vm.prank(peer1);
        uint256 tokenId = identity.register(peerId1, "ipfs://meta1");

        assertEq(identity.getTokenIdByPeerId(peerId1), tokenId);
        assertEq(identity.getTokenIdByPeerId(peerId1), identity.getTokenId(peer1));
    }

    function test_getTokenId_unregistered() public view {
        assertEq(identity.getTokenId(peer1), 0);
    }

    function test_getPeerId() public {
        vm.prank(peer1);
        uint256 tokenId = identity.register(peerId1, "ipfs://meta1");

        assertEq(identity.getPeerId(tokenId), peerId1);
    }

    function test_deregister_revert_activeStake() public {
        uint256 stakeAmount = 10_000_000;
        usdc.mint(peer1, stakeAmount);

        vm.prank(peer1);
        uint256 tokenId = identity.register(peerId1, "ipfs://meta1");

        vm.startPrank(peer1);
        usdc.approve(address(identity), stakeAmount);
        identity.stake(stakeAmount);
        vm.stopPrank();

        vm.prank(peer1);
        vm.expectRevert(AntseedIdentity.ActiveStake.selector);
        identity.deregister(tokenId);
    }

    function test_deregister_allowedAfterUnstake() public {
        uint256 stakeAmount = 10_000_000;
        usdc.mint(peer1, stakeAmount);

        vm.prank(peer1);
        uint256 tokenId = identity.register(peerId1, "ipfs://meta1");

        // Stake then unstake
        vm.startPrank(peer1);
        usdc.approve(address(identity), stakeAmount);
        identity.stake(stakeAmount);
        identity.unstake();
        vm.stopPrank();

        // Now deregister should succeed
        vm.prank(peer1);
        identity.deregister(tokenId);
        assertFalse(identity.isRegistered(peer1));
    }

    function test_stake() public {
        uint256 stakeAmount = 10_000_000;
        usdc.mint(peer1, stakeAmount);

        vm.prank(peer1);
        identity.register(peerId1, "ipfs://meta1");

        vm.startPrank(peer1);
        usdc.approve(address(identity), stakeAmount);
        identity.stake(stakeAmount);
        vm.stopPrank();

        (uint256 stake,,) = identity.getSellerAccount(peer1);
        assertEq(stake, stakeAmount);
    }

    function test_stake_revert_notRegistered() public {
        uint256 stakeAmount = 10_000_000;
        usdc.mint(peer1, stakeAmount);

        vm.startPrank(peer1);
        usdc.approve(address(identity), stakeAmount);
        vm.expectRevert(AntseedIdentity.NotRegistered.selector);
        identity.stake(stakeAmount);
        vm.stopPrank();
    }

    function test_setTokenRate() public {
        uint256 stakeAmount = 10_000_000;
        usdc.mint(peer1, stakeAmount);

        vm.prank(peer1);
        identity.register(peerId1, "ipfs://meta1");

        vm.startPrank(peer1);
        usdc.approve(address(identity), stakeAmount);
        identity.stake(stakeAmount);
        identity.setTokenRate(100);
        vm.stopPrank();

        assertEq(identity.getTokenRate(peer1), 100);
    }
}
