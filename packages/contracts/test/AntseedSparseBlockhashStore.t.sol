// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

import { AntseedSparseBlockhashStore } from "../integrity/AntseedSparseBlockhashStore.sol";

contract SparseChainlinkBlockhashStoreMock {
    mapping(uint256 blockNumber => bytes32 blockHash) public getBlockhash;

    function set(uint256 blockNumber, bytes32 blockHash) external {
        getBlockhash[blockNumber] = blockHash;
    }

    function storeVerifyHeader(uint256, bytes calldata) external { }
}

contract AntseedSparseBlockhashStoreTest is Test {
    bytes32 internal constant SESSION = keccak256("session");
    bytes32 internal constant TERMINAL_PARENT = bytes32(uint256(77));

    SparseChainlinkBlockhashStoreMock internal chainlink;
    AntseedSparseBlockhashStore internal store;

    function setUp() public {
        chainlink = new SparseChainlinkBlockhashStoreMock();
        store = new AntseedSparseBlockhashStore(address(chainlink));
    }

    function test_verifiesChainAndStoresOnlySelectedParents() public {
        bytes memory second = _shortHeader(TERMINAL_PARENT);
        bytes32 secondHash = keccak256(second);
        bytes memory first = _longHeader(secondHash);
        chainlink.set(100, keccak256(first));

        bytes[] memory headers = new bytes[](2);
        headers[0] = first;
        headers[1] = second;
        store.verifyHeaderBatch(SESSION, 100, headers, hex"02");

        assertEq(store.localBlockhash(99), bytes32(0));
        assertEq(store.localBlockhash(98), TERMINAL_PARENT);
        (uint64 anchorBlock, uint64 nextHeaderBlock, bytes32 expectedHeaderHash) =
            store.frontiers(store.frontierKey(address(this), SESSION));
        assertEq(anchorBlock, 100);
        assertEq(nextHeaderBlock, 98);
        assertEq(expectedHeaderHash, TERMINAL_PARENT);
    }

    function test_resumesFromPersistedFrontier() public {
        bytes memory second = _shortHeader(TERMINAL_PARENT);
        bytes32 secondHash = keccak256(second);
        bytes memory first = _shortHeader(secondHash);
        chainlink.set(100, keccak256(first));

        bytes[] memory firstBatch = new bytes[](1);
        firstBatch[0] = first;
        store.verifyHeaderBatch(SESSION, 100, firstBatch, hex"00");

        bytes[] memory secondBatch = new bytes[](1);
        secondBatch[0] = second;
        store.verifyHeaderBatch(SESSION, 100, secondBatch, hex"01");

        assertEq(store.localBlockhash(98), TERMINAL_PARENT);
    }

    function test_verifiesMultipleCompleteRangesWithoutFrontiers() public {
        bytes memory firstHeader = _shortHeader(bytes32(uint256(91)));
        bytes memory secondHeader = _shortHeader(bytes32(uint256(81)));
        chainlink.set(100, keccak256(firstHeader));
        chainlink.set(90, keccak256(secondHeader));

        AntseedSparseBlockhashStore.CompleteHeaderBatch[] memory batches =
            new AntseedSparseBlockhashStore.CompleteHeaderBatch[](2);
        bytes[] memory firstHeaders = new bytes[](1);
        firstHeaders[0] = firstHeader;
        batches[0] = AntseedSparseBlockhashStore.CompleteHeaderBatch(100, firstHeaders, hex"01");
        bytes[] memory secondHeaders = new bytes[](1);
        secondHeaders[0] = secondHeader;
        batches[1] = AntseedSparseBlockhashStore.CompleteHeaderBatch(90, secondHeaders, hex"01");

        store.verifyCompleteHeaderBatches(batches);

        assertEq(store.localBlockhash(99), bytes32(uint256(91)));
        assertEq(store.localBlockhash(89), bytes32(uint256(81)));
        (,, bytes32 expectedHeaderHash) = store.frontiers(store.frontierKey(address(this), SESSION));
        assertEq(expectedHeaderHash, bytes32(0));
    }

    function test_namespacesPersistentFrontiersBySubmitter() public {
        address attacker = address(0xBAD);
        bytes memory victimSecond = _shortHeader(TERMINAL_PARENT);
        bytes memory victimFirst = _shortHeader(keccak256(victimSecond));
        bytes memory attackerHeader = _shortHeader(bytes32(uint256(88)));
        chainlink.set(100, keccak256(victimFirst));
        chainlink.set(101, keccak256(attackerHeader));
        bytes[] memory attackerHeaders = new bytes[](1);
        attackerHeaders[0] = attackerHeader;

        vm.prank(attacker);
        store.verifyHeaderBatch(SESSION, 101, attackerHeaders, hex"00");

        bytes[] memory victimHeaders = new bytes[](1);
        victimHeaders[0] = victimFirst;
        store.verifyHeaderBatch(SESSION, 100, victimHeaders, hex"00");
        victimHeaders[0] = victimSecond;
        store.verifyHeaderBatch(SESSION, 100, victimHeaders, hex"01");

        (uint64 attackerAnchor, uint64 attackerNext,) = store.frontiers(store.frontierKey(attacker, SESSION));
        (uint64 callerAnchor, uint64 callerNext,) = store.frontiers(store.frontierKey(address(this), SESSION));
        assertEq(attackerAnchor, 101);
        assertEq(attackerNext, 100);
        assertEq(callerAnchor, 100);
        assertEq(callerNext, 98);
        assertEq(store.localBlockhash(98), TERMINAL_PARENT);
    }

    function test_returnsLocalOrChainlinkHash() public {
        bytes memory header = _shortHeader(TERMINAL_PARENT);
        chainlink.set(100, keccak256(header));
        chainlink.set(80, bytes32(uint256(81)));
        bytes[] memory headers = new bytes[](1);
        headers[0] = header;
        store.verifyHeaderBatch(SESSION, 100, headers, hex"01");

        assertEq(store.getBlockhash(99), TERMINAL_PARENT);
        assertEq(store.getBlockhash(80), bytes32(uint256(81)));
    }

    function test_rejectsTamperedHeaderAndInvalidBitmap() public {
        bytes memory header = _shortHeader(TERMINAL_PARENT);
        chainlink.set(100, keccak256(header));
        bytes[] memory headers = new bytes[](1);
        headers[0] = _shortHeader(bytes32(uint256(88)));

        vm.expectRevert(abi.encodeWithSelector(AntseedSparseBlockhashStore.HeaderHashMismatch.selector, uint64(100)));
        store.verifyHeaderBatch(SESSION, 100, headers, hex"01");

        headers[0] = header;
        vm.expectRevert(AntseedSparseBlockhashStore.InvalidStoreBitmap.selector);
        store.verifyHeaderBatch(SESSION, 100, headers, hex"02");
    }

    function test_rejectsAnchorChangeForExistingSession() public {
        bytes memory header = _shortHeader(TERMINAL_PARENT);
        bytes32 headerHash = keccak256(header);
        chainlink.set(100, headerHash);
        chainlink.set(101, headerHash);
        bytes[] memory headers = new bytes[](1);
        headers[0] = header;
        store.verifyHeaderBatch(SESSION, 100, headers, hex"00");

        vm.expectRevert(abi.encodeWithSelector(AntseedSparseBlockhashStore.AnchorMismatch.selector, 100, 101));
        store.verifyHeaderBatch(SESSION, 101, headers, hex"00");
    }

    function _shortHeader(bytes32 parentHash) internal pure returns (bytes memory) {
        return bytes.concat(hex"e2a0", parentHash, hex"01");
    }

    function _longHeader(bytes32 parentHash) internal pure returns (bytes memory) {
        return bytes.concat(hex"f85ba0", parentHash, hex"b838", new bytes(56));
    }
}
