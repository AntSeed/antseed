// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../AntseedIdentity.sol";

contract AntseedIdentityReputationTest is Test {
    AntseedIdentity public identity;
    address public peer1 = address(0x1);
    bytes32 public peerId1 = keccak256("peer1");
    uint256 public tokenId;

    address public client1 = address(0x10);
    address public client2 = address(0x11);
    bytes32 public tag = bytes32("quality");

    function setUp() public {
        identity = new AntseedIdentity();
        identity.setEscrowContract(address(this));
        vm.prank(peer1);
        tokenId = identity.register(peerId1, "ipfs://meta");
    }

    // ── Reputation tests ──

    function test_updateReputation_firstSign() public {
        identity.updateReputation(tokenId, AntseedIdentity.ReputationUpdate(0, 0));
        AntseedIdentity.ProvenReputation memory rep = identity.getReputation(tokenId);
        assertEq(rep.firstSignCount, 1);
    }

    function test_updateReputation_qualifiedProven() public {
        identity.updateReputation(tokenId, AntseedIdentity.ReputationUpdate(1, 10000));
        AntseedIdentity.ProvenReputation memory rep = identity.getReputation(tokenId);
        assertEq(rep.qualifiedProvenSignCount, 1);
        assertEq(rep.totalQualifiedTokenVolume, 10000);
        assertEq(rep.lastProvenAt, block.timestamp);
    }

    function test_updateReputation_unqualifiedProven() public {
        identity.updateReputation(tokenId, AntseedIdentity.ReputationUpdate(2, 0));
        AntseedIdentity.ProvenReputation memory rep = identity.getReputation(tokenId);
        assertEq(rep.unqualifiedProvenSignCount, 1);
    }

    function test_updateReputation_ghost() public {
        identity.updateReputation(tokenId, AntseedIdentity.ReputationUpdate(3, 0));
        AntseedIdentity.ProvenReputation memory rep = identity.getReputation(tokenId);
        assertEq(rep.ghostCount, 1);
    }

    function test_updateReputation_revert_notEscrow() public {
        vm.prank(peer1);
        vm.expectRevert(AntseedIdentity.NotAuthorized.selector);
        identity.updateReputation(tokenId, AntseedIdentity.ReputationUpdate(0, 0));
    }

    function test_updateReputation_revert_invalidToken() public {
        vm.expectRevert(AntseedIdentity.InvalidToken.selector);
        identity.updateReputation(999, AntseedIdentity.ReputationUpdate(0, 0));
    }

    function test_getReputation_allFields() public {
        // 2 firstSigns
        identity.updateReputation(tokenId, AntseedIdentity.ReputationUpdate(0, 0));
        identity.updateReputation(tokenId, AntseedIdentity.ReputationUpdate(0, 0));
        // 3 qualifiedProven with volumes
        identity.updateReputation(tokenId, AntseedIdentity.ReputationUpdate(1, 5000));
        identity.updateReputation(tokenId, AntseedIdentity.ReputationUpdate(1, 3000));
        identity.updateReputation(tokenId, AntseedIdentity.ReputationUpdate(1, 2000));
        // 1 unqualifiedProven
        identity.updateReputation(tokenId, AntseedIdentity.ReputationUpdate(2, 0));
        // 4 ghosts
        identity.updateReputation(tokenId, AntseedIdentity.ReputationUpdate(3, 0));
        identity.updateReputation(tokenId, AntseedIdentity.ReputationUpdate(3, 0));
        identity.updateReputation(tokenId, AntseedIdentity.ReputationUpdate(3, 0));
        identity.updateReputation(tokenId, AntseedIdentity.ReputationUpdate(3, 0));

        AntseedIdentity.ProvenReputation memory rep = identity.getReputation(tokenId);
        assertEq(rep.firstSignCount, 2);
        assertEq(rep.qualifiedProvenSignCount, 3);
        assertEq(rep.unqualifiedProvenSignCount, 1);
        assertEq(rep.ghostCount, 4);
        assertEq(rep.totalQualifiedTokenVolume, 10000);
        assertEq(rep.lastProvenAt, block.timestamp);
    }

    // ── ERC-8004 Feedback tests ──

    function test_giveFeedback() public {
        vm.prank(client1);
        identity.giveFeedback(tokenId, 85, 0, tag, bytes32(0));

        (uint256 count, int256 summaryValue,) = identity.getSummary(tokenId, tag);
        assertEq(count, 1);
        assertEq(summaryValue, 85);
    }

    function test_giveFeedback_multipleTags() public {
        bytes32 tag2 = bytes32("speed");

        vm.prank(client1);
        identity.giveFeedback(tokenId, 80, 0, tag, bytes32(0));
        vm.prank(client1);
        identity.giveFeedback(tokenId, 95, 0, tag2, bytes32(0));

        (uint256 count1, int256 val1,) = identity.getSummary(tokenId, tag);
        (uint256 count2, int256 val2,) = identity.getSummary(tokenId, tag2);
        assertEq(count1, 1);
        assertEq(val1, 80);
        assertEq(count2, 1);
        assertEq(val2, 95);
    }

    function test_giveFeedback_multipleClients() public {
        vm.prank(client1);
        identity.giveFeedback(tokenId, 80, 0, tag, bytes32(0));
        vm.prank(client2);
        identity.giveFeedback(tokenId, 90, 0, tag, bytes32(0));

        (uint256 count, int256 summaryValue,) = identity.getSummary(tokenId, tag);
        assertEq(count, 2);
        assertEq(summaryValue, 170);
    }

    function test_giveFeedback_revert_invalidAgent() public {
        vm.prank(client1);
        vm.expectRevert(AntseedIdentity.InvalidToken.selector);
        identity.giveFeedback(999, 85, 0, tag, bytes32(0));
    }

    function test_getSummary() public {
        vm.prank(client1);
        identity.giveFeedback(tokenId, 80, 0, tag, bytes32(0));
        vm.prank(client1);
        identity.giveFeedback(tokenId, 90, 0, tag, bytes32(0));
        vm.prank(client1);
        identity.giveFeedback(tokenId, 70, 0, tag, bytes32(0));

        (uint256 count, int256 summaryValue,) = identity.getSummary(tokenId, tag);
        assertEq(count, 3);
        assertEq(summaryValue, 240);
    }

    function test_readFeedback() public {
        vm.prank(client1);
        identity.giveFeedback(tokenId, 85, 0, tag, bytes32(0));

        AntseedIdentity.FeedbackEntry memory entry = identity.readFeedback(tokenId, client1, 0);
        assertEq(entry.client, client1);
        assertEq(entry.value, 85);
        assertEq(entry.valueDecimals, 0);
        assertEq(entry.tag1, tag);
        assertEq(entry.tag2, bytes32(0));
        assertFalse(entry.revoked);
    }

    function test_revokeFeedback() public {
        vm.prank(client1);
        identity.giveFeedback(tokenId, 85, 0, tag, bytes32(0));

        vm.prank(client1);
        identity.revokeFeedback(tokenId, 0);

        (uint256 count, int256 summaryValue,) = identity.getSummary(tokenId, tag);
        assertEq(count, 0);
        assertEq(summaryValue, 0);
    }

    function test_revokeFeedback_revert_notSubmitter() public {
        vm.prank(client1);
        identity.giveFeedback(tokenId, 85, 0, tag, bytes32(0));

        vm.prank(client2);
        vm.expectRevert(AntseedIdentity.InvalidIndex.selector);
        identity.revokeFeedback(tokenId, 0);
    }

    function test_revokeFeedback_revert_alreadyRevoked() public {
        vm.prank(client1);
        identity.giveFeedback(tokenId, 85, 0, tag, bytes32(0));

        vm.prank(client1);
        identity.revokeFeedback(tokenId, 0);

        vm.prank(client1);
        vm.expectRevert(AntseedIdentity.AlreadyRevoked.selector);
        identity.revokeFeedback(tokenId, 0);
    }

    function test_revokeFeedback_revert_invalidIndex() public {
        vm.prank(client1);
        vm.expectRevert(AntseedIdentity.InvalidIndex.selector);
        identity.revokeFeedback(tokenId, 0);
    }

    function test_getFeedbackCount() public {
        vm.prank(client1);
        identity.giveFeedback(tokenId, 80, 0, tag, bytes32(0));
        vm.prank(client1);
        identity.giveFeedback(tokenId, 90, 0, tag, bytes32(0));

        assertEq(identity.getFeedbackCount(tokenId, client1), 2);
        assertEq(identity.getFeedbackCount(tokenId, client2), 0);
    }
}
