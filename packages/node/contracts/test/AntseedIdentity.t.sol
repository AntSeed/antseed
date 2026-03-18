// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../AntseedIdentity.sol";

contract MockEscrowForIdentity {
    mapping(address => uint256) public stakeOf;
    function setStake(address seller, uint256 amount) external { stakeOf[seller] = amount; }
    function sellers(address seller) external view returns (uint256 stake, uint256 earnings, uint256 stakedAt, uint256 tokenRate) {
        return (stakeOf[seller], 0, 0, 0);
    }
}

contract AntseedIdentityTest is Test {
    AntseedIdentity public identity;
    address public owner;
    address public peer1 = address(0x1);
    address public peer2 = address(0x2);
    address public escrow = address(0x3);

    bytes32 public peerId1 = keccak256("peer1");
    bytes32 public peerId2 = keccak256("peer2");

    function setUp() public {
        owner = address(this);
        identity = new AntseedIdentity();
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

    function test_setEscrowContract() public {
        identity.setEscrowContract(escrow);
        assertEq(identity.escrowContract(), escrow);
    }

    function test_setEscrowContract_revert_notOwner() public {
        vm.prank(peer1);
        vm.expectRevert(AntseedIdentity.NotOwner.selector);
        identity.setEscrowContract(escrow);
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
        MockEscrowForIdentity mockEscrow = new MockEscrowForIdentity();
        identity.setEscrowContract(address(mockEscrow));

        vm.prank(peer1);
        uint256 tokenId = identity.register(peerId1, "ipfs://meta1");

        // Set active stake
        mockEscrow.setStake(peer1, 100_000_000);

        vm.prank(peer1);
        vm.expectRevert(AntseedIdentity.ActiveStake.selector);
        identity.deregister(tokenId);
    }

    function test_deregister_allowedAfterUnstake() public {
        MockEscrowForIdentity mockEscrow = new MockEscrowForIdentity();
        identity.setEscrowContract(address(mockEscrow));

        vm.prank(peer1);
        uint256 tokenId = identity.register(peerId1, "ipfs://meta1");

        // No stake — deregister should succeed
        vm.prank(peer1);
        identity.deregister(tokenId);
        assertFalse(identity.isRegistered(peer1));
    }
}
