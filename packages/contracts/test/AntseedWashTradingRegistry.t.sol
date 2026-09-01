// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

import { AntseedWashTradingRegistry } from "../integrity/AntseedWashTradingRegistry.sol";
import { AntseedBlockhashStoreBatcher } from "../integrity/AntseedBlockhashStoreBatcher.sol";
import { IAntseedWashTradingRegistry } from "../interfaces/IAntseedWashTradingRegistry.sol";
import { ISP1Verifier } from "../interfaces/ISP1Verifier.sol";

contract MockSP1Verifier is ISP1Verifier {
    bytes32 public expectedVKey;
    bytes32 public expectedValuesHash;
    bytes32 public expectedProofHash;

    function expect(bytes32 vKey, bytes memory values, bytes memory proof) external {
        expectedVKey = vKey;
        expectedValuesHash = keccak256(values);
        expectedProofHash = keccak256(proof);
    }

    function verifyProof(bytes32 vKey, bytes calldata values, bytes calldata proof) external view {
        require(
            vKey == expectedVKey && keccak256(values) == expectedValuesHash && keccak256(proof) == expectedProofHash,
            "unexpected proof"
        );
    }
}

contract MockBlockhashStore {
    mapping(uint256 blockNumber => bytes32 blockHash) public getBlockhash;

    function set(uint64 blockNumber, bytes32 blockHash) external {
        getBlockhash[blockNumber] = blockHash;
    }

    function storeVerifyHeader(uint256, bytes calldata) external { }
}

contract RecordingBlockhashStore {
    uint256[] public blockNumbers;
    bytes32[] public headerDigests;

    function getBlockhash(uint256) external pure returns (bytes32) {
        return bytes32(0);
    }

    function storeVerifyHeader(uint256 blockNumber, bytes calldata header) external {
        blockNumbers.push(blockNumber);
        headerDigests.push(keccak256(header));
    }
}

contract AntseedWashTradingRegistryTest is Test {
    bytes32 internal constant AGGREGATOR_VKEY = bytes32(uint256(11));
    bytes32 internal constant CLOSED_VKEY = bytes32(uint256(12));
    bytes32 internal constant RECIPROCAL_VKEY = bytes32(uint256(13));
    bytes32 internal constant BLOCK_HASH_A = bytes32(uint256(44));
    bytes32 internal constant BLOCK_HASH_B = bytes32(uint256(55));
    uint64 internal constant BLOCK_A = 120;
    uint64 internal constant BLOCK_B = 150;
    address internal constant SELLER_A = address(0xA11CE);

    MockSP1Verifier internal verifier;
    MockBlockhashStore internal blockhashStore;
    AntseedWashTradingRegistry internal registry;

    function setUp() public {
        verifier = new MockSP1Verifier();
        blockhashStore = new MockBlockhashStore();
        blockhashStore.set(BLOCK_A, BLOCK_HASH_A);
        blockhashStore.set(BLOCK_B, BLOCK_HASH_B);
        registry = new AntseedWashTradingRegistry(
            address(verifier), address(blockhashStore), AGGREGATOR_VKEY, CLOSED_VKEY, RECIPROCAL_VKEY, 100, 199
        );
    }

    function test_blockAuthenticationLeafMatchesRustAbi() public pure {
        IAntseedWashTradingRegistry.BlockRef[] memory refs = new IAntseedWashTradingRegistry.BlockRef[](1);
        refs[0] = IAntseedWashTradingRegistry.BlockRef(123, bytes32(uint256(type(uint256).max / 0xff * 0xaa)));
        assertEq(
            keccak256(abi.encode(uint32(0), refs)), 0x30527e2a947e958d4041ae91f69cf216b960961be3a4610a31d765da7989b11a
        );
    }

    function test_permissionlessSellerProofStagesAuthenticatesAndFinalizes() public {
        bytes32 proofId = _stage(_journal(300, bytes32(uint256(71))));
        assertTrue(registry.proofStaged(proofId));
        assertFalse(registry.proofFinalized(proofId));
        assertEq(registry.provenWashVolume(SELLER_A), 0);

        _authenticate(proofId, 1, BLOCK_B, BLOCK_HASH_B, _leaf(0, BLOCK_A, BLOCK_HASH_A));
        vm.expectRevert(AntseedWashTradingRegistry.IncompleteBlockAuthentication.selector);
        registry.finalizeSellerProof(proofId);
        _authenticate(proofId, 0, BLOCK_A, BLOCK_HASH_A, _leaf(1, BLOCK_B, BLOCK_HASH_B));
        registry.finalizeSellerProof(proofId);

        assertTrue(registry.proofFinalized(proofId));
        assertEq(registry.proofAuthenticatedBlockReferenceCount(proofId), 2);
        assertEq(registry.proofAuthenticatedBlockChunkCount(proofId), 2);
        assertEq(registry.provenWashVolume(SELLER_A), 300);
        assertEq(registry.sellerEvidenceDigest(SELLER_A), bytes32(uint256(71)));
        assertTrue(registry.isProvenWashTrader(SELLER_A));
    }

    function test_onlyStrictlyStrongerVolumeCanReplaceSellerResult() public {
        _finalize(_journal(300, bytes32(uint256(71))));

        bytes32 weaker = _stage(_journal(299, bytes32(uint256(72))));
        _authenticateAll(weaker);
        vm.expectRevert(AntseedWashTradingRegistry.StrongerResultRequired.selector);
        registry.finalizeSellerProof(weaker);

        bytes32 equal = _stage(_journal(300, bytes32(uint256(73))));
        _authenticateAll(equal);
        vm.expectRevert(AntseedWashTradingRegistry.StrongerResultRequired.selector);
        registry.finalizeSellerProof(equal);

        bytes32 stronger = _stage(_journal(450, bytes32(uint256(74))));
        _authenticateAll(stronger);
        registry.finalizeSellerProof(stronger);
        assertEq(registry.provenWashVolume(SELLER_A), 450);
        assertEq(registry.sellerEvidenceDigest(SELLER_A), bytes32(uint256(74)));
    }

    function test_rejectsWrongProgramIdentityAndPeriod() public {
        AntseedWashTradingRegistry.SellerJournal memory journal = _journal(300, bytes32(uint256(71)));
        journal.closedLoopProgramVKey = bytes32(uint256(999));
        _expectStageRevert(journal, AntseedWashTradingRegistry.InvalidSellerProof.selector);

        journal = _journal(300, bytes32(uint256(72)));
        journal.periodEndBlock = 200;
        _expectStageRevert(journal, AntseedWashTradingRegistry.InvalidSellerProof.selector);
    }

    function test_rejectsNonCanonicalWrongChunkAndReplay() public {
        bytes32 proofId = _stage(_journal(300, bytes32(uint256(71))));
        bytes32[] memory proof = _proof(_leaf(1, BLOCK_B, BLOCK_HASH_B));
        IAntseedWashTradingRegistry.BlockRef[] memory refs = _refs(BLOCK_A, bytes32(uint256(999)));
        vm.expectRevert(abi.encodeWithSelector(AntseedWashTradingRegistry.NonCanonicalBlock.selector, BLOCK_A));
        registry.authenticateBlockReferences(proofId, 0, refs, proof);

        refs = _refs(BLOCK_A, BLOCK_HASH_A);
        proof[0] = bytes32(uint256(999));
        vm.expectRevert(AntseedWashTradingRegistry.InvalidBlockAuthenticationChunk.selector);
        registry.authenticateBlockReferences(proofId, 0, refs, proof);

        _authenticate(proofId, 0, BLOCK_A, BLOCK_HASH_A, _leaf(1, BLOCK_B, BLOCK_HASH_B));
        vm.expectRevert(
            abi.encodeWithSelector(
                AntseedWashTradingRegistry.BlockAuthenticationChunkAlreadySubmitted.selector, proofId, 0
            )
        );
        registry.authenticateBlockReferences(
            proofId, 0, _refs(BLOCK_A, BLOCK_HASH_A), _proof(_leaf(1, BLOCK_B, BLOCK_HASH_B))
        );
    }

    function test_rejectsSameProofReplay() public {
        AntseedWashTradingRegistry.SellerJournal memory journal = _journal(300, bytes32(uint256(71)));
        bytes32 proofId = _stage(journal);
        (bytes memory values, bytes memory proof) = _submission(journal);
        vm.expectRevert(abi.encodeWithSelector(AntseedWashTradingRegistry.SellerProofAlreadyStaged.selector, proofId));
        registry.stageSellerProof(values, proof);
    }

    function _finalize(AntseedWashTradingRegistry.SellerJournal memory journal) internal returns (bytes32 proofId) {
        proofId = _stage(journal);
        _authenticateAll(proofId);
        registry.finalizeSellerProof(proofId);
    }

    function _stage(AntseedWashTradingRegistry.SellerJournal memory journal) internal returns (bytes32 proofId) {
        (bytes memory values, bytes memory proof) = _submission(journal);
        verifier.expect(AGGREGATOR_VKEY, values, proof);
        proofId = registry.stageSellerProof(values, proof);
        assertEq(proofId, keccak256(values));
    }

    function _expectStageRevert(AntseedWashTradingRegistry.SellerJournal memory journal, bytes4 selector) internal {
        (bytes memory values, bytes memory proof) = _submission(journal);
        verifier.expect(AGGREGATOR_VKEY, values, proof);
        vm.expectRevert(selector);
        registry.stageSellerProof(values, proof);
    }

    function _submission(AntseedWashTradingRegistry.SellerJournal memory journal)
        internal
        pure
        returns (bytes memory values, bytes memory proof)
    {
        values = abi.encode(journal);
        proof = hex"1234";
    }

    function _journal(uint128 washVolume, bytes32 evidenceDigest)
        internal
        pure
        returns (AntseedWashTradingRegistry.SellerJournal memory journal)
    {
        journal = AntseedWashTradingRegistry.SellerJournal({
            schemaVersion: 1,
            chainId: 8453,
            periodStartBlock: 100,
            periodEndBlock: 199,
            closedLoopProgramVKey: CLOSED_VKEY,
            reciprocalProgramVKey: RECIPROCAL_VKEY,
            seller: SELLER_A,
            provenWashVolume: washVolume,
            evidenceDigest: evidenceDigest,
            blockReferenceCount: 2,
            blockAuthenticationChunkSize: 1,
            blockAuthenticationChunkCount: 2,
            blockAuthenticationRoot: keccak256(abi.encode(_leaf(0, BLOCK_A, BLOCK_HASH_A), _leaf(1, BLOCK_B, BLOCK_HASH_B)))
        });
    }

    function _authenticateAll(bytes32 proofId) internal {
        _authenticate(proofId, 0, BLOCK_A, BLOCK_HASH_A, _leaf(1, BLOCK_B, BLOCK_HASH_B));
        _authenticate(proofId, 1, BLOCK_B, BLOCK_HASH_B, _leaf(0, BLOCK_A, BLOCK_HASH_A));
    }

    function _authenticate(bytes32 proofId, uint32 index, uint64 number, bytes32 blockHash, bytes32 sibling) internal {
        registry.authenticateBlockReferences(proofId, index, _refs(number, blockHash), _proof(sibling));
    }

    function _refs(uint64 number, bytes32 blockHash)
        internal
        pure
        returns (IAntseedWashTradingRegistry.BlockRef[] memory refs)
    {
        refs = new IAntseedWashTradingRegistry.BlockRef[](1);
        refs[0] = IAntseedWashTradingRegistry.BlockRef(number, blockHash);
    }

    function _proof(bytes32 sibling) internal pure returns (bytes32[] memory proof) {
        proof = new bytes32[](1);
        proof[0] = sibling;
    }

    function _leaf(uint32 index, uint64 number, bytes32 blockHash) internal pure returns (bytes32) {
        return keccak256(abi.encode(index, _refs(number, blockHash)));
    }
}

contract AntseedBlockhashStoreBatcherTest is Test {
    RecordingBlockhashStore internal store;
    AntseedBlockhashStoreBatcher internal batcher;

    function setUp() public {
        store = new RecordingBlockhashStore();
        batcher = new AntseedBlockhashStoreBatcher(address(store));
    }

    function test_forwardsStrictlyDescendingHeaderBatch() public {
        uint256[] memory numbers = new uint256[](3);
        numbers[0] = 12;
        numbers[1] = 11;
        numbers[2] = 10;
        bytes[] memory headers = new bytes[](3);
        headers[0] = hex"aa";
        headers[1] = hex"bb";
        headers[2] = hex"cc";

        batcher.storeVerifyHeaders(numbers, headers);

        assertEq(store.blockNumbers(0), 12);
        assertEq(store.blockNumbers(1), 11);
        assertEq(store.blockNumbers(2), 10);
        assertEq(store.headerDigests(0), keccak256(headers[0]));
        assertEq(store.headerDigests(1), keccak256(headers[1]));
        assertEq(store.headerDigests(2), keccak256(headers[2]));
    }

    function test_rejectsNonDescendingBatch() public {
        uint256[] memory numbers = new uint256[](2);
        numbers[0] = 10;
        numbers[1] = 11;
        bytes[] memory headers = new bytes[](2);
        headers[0] = hex"aa";
        headers[1] = hex"bb";

        vm.expectRevert(AntseedBlockhashStoreBatcher.BlockNumbersNotStrictlyDescending.selector);
        batcher.storeVerifyHeaders(numbers, headers);
    }
}
