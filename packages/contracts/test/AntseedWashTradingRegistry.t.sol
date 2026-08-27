// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";

import { AntseedWashTradingRegistry } from "../integrity/AntseedWashTradingRegistry.sol";
import { ISP1Verifier } from "../interfaces/ISP1Verifier.sol";

contract WashTradingVerifierMock is ISP1Verifier {
    bytes32 public rejectedJournalDigest;
    mapping(bytes32 journalDigest => bytes32 vkey) public expectedVKey;

    function reject(bytes32 journalDigest) external {
        rejectedJournalDigest = journalDigest;
    }

    function expectVKey(bytes32 journalDigest, bytes32 vkey) external {
        expectedVKey[journalDigest] = vkey;
    }

    function verifyProof(bytes32 programVKey, bytes calldata publicValues, bytes calldata) external view {
        bytes32 journalDigest = sha256(publicValues);
        require(journalDigest != rejectedJournalDigest, "invalid proof");
        bytes32 requiredVKey = expectedVKey[journalDigest];
        require(requiredVKey == bytes32(0) || requiredVKey == programVKey, "wrong vkey");
    }
}

contract BlockhashStoreMock {
    mapping(uint256 blockNumber => bytes32 blockHash) public getBlockhash;

    function set(uint256 blockNumber, bytes32 blockHash) external {
        getBlockhash[blockNumber] = blockHash;
    }

    function store(uint256) external { }
    function storeVerifyHeader(uint256, bytes calldata) external { }
}

contract AntseedWashTradingRegistryTest is Test {
    bytes32 internal constant CLOSED_LOOP_VKEY = bytes32(uint256(1));
    bytes32 internal constant RECIPROCAL_VKEY = bytes32(uint256(2));
    uint64 internal constant BLOCK_NUMBER = 44_471_575;
    bytes32 internal constant BLOCK_HASH = keccak256("canonical Base block");
    address internal constant SELLER = address(0xBEEF);

    WashTradingVerifierMock internal verifier;
    BlockhashStoreMock internal blockhashStore;

    function setUp() public {
        verifier = new WashTradingVerifierMock();
        blockhashStore = new BlockhashStoreMock();
        blockhashStore.set(BLOCK_NUMBER, BLOCK_HASH);
    }

    function test_successfulBatchRecordsAllClaimsAndCompletesAtomically() public {
        bytes[] memory publicValues = new bytes[](2);
        publicValues[0] = _journal(bytes32(uint256(1)), SELLER, 3, 10, 1, BLOCK_NUMBER, BLOCK_HASH);
        publicValues[1] = _journal(bytes32(uint256(2)), address(0xCAFE), 7, 10, 2, BLOCK_NUMBER, BLOCK_HASH);
        AntseedWashTradingRegistry registry = _deploy(publicValues);

        registry.submitBatch(publicValues, _proofs(2));

        assertTrue(registry.backfillComplete());
        assertEq(registry.claimJournalDigest(bytes32(uint256(1))), sha256(publicValues[0]));
        assertEq(registry.claimJournalDigest(bytes32(uint256(2))), sha256(publicValues[1]));
        assertEq(registry.washRatioBps(SELLER), 3_000);
        assertEq(registry.washRatioBps(address(0xCAFE)), 7_000);
    }

    function test_individualSubmissionRejectedBeforeBatch() public {
        bytes[] memory publicValues = _one(_journal(bytes32(uint256(1)), SELLER, 1, 2, 1, BLOCK_NUMBER, BLOCK_HASH));
        AntseedWashTradingRegistry registry = _deploy(publicValues);

        vm.expectRevert(AntseedWashTradingRegistry.BackfillIncomplete.selector);
        registry.submit(publicValues[0], "");
    }

    function test_wrongBatchCountOrderAndDigestRevert() public {
        bytes[] memory publicValues = new bytes[](2);
        publicValues[0] = _journal(bytes32(uint256(1)), SELLER, 1, 2, 1, BLOCK_NUMBER, BLOCK_HASH);
        publicValues[1] = _journal(bytes32(uint256(2)), address(0xCAFE), 1, 4, 2, BLOCK_NUMBER, BLOCK_HASH);
        AntseedWashTradingRegistry registry = _deploy(publicValues);

        vm.expectRevert(AntseedWashTradingRegistry.InvalidBatch.selector);
        registry.submitBatch(_one(publicValues[0]), _proofs(1));

        bytes[] memory reversed = new bytes[](2);
        reversed[0] = publicValues[1];
        reversed[1] = publicValues[0];
        vm.expectRevert(AntseedWashTradingRegistry.InvalidBatch.selector);
        registry.submitBatch(reversed, _proofs(2));

        AntseedWashTradingRegistry wrongDigestRegistry = new AntseedWashTradingRegistry(
            address(verifier),
            address(blockhashStore),
            CLOSED_LOOP_VKEY,
            RECIPROCAL_VKEY,
            2,
            bytes32(uint256(123))
        );
        vm.expectRevert(
            abi.encodeWithSelector(
                AntseedWashTradingRegistry.InvalidBatchDigest.selector,
                bytes32(uint256(123)),
                _batchDigest(publicValues)
            )
        );
        wrongDigestRegistry.submitBatch(publicValues, _proofs(2));
    }

    function test_oneInvalidProofRevertsEntireBatch() public {
        bytes[] memory publicValues = new bytes[](2);
        publicValues[0] = _journal(bytes32(uint256(1)), SELLER, 1, 2, 1, BLOCK_NUMBER, BLOCK_HASH);
        publicValues[1] = _journal(bytes32(uint256(2)), address(0xCAFE), 1, 2, 2, BLOCK_NUMBER, BLOCK_HASH);
        AntseedWashTradingRegistry registry = _deploy(publicValues);
        verifier.reject(sha256(publicValues[1]));

        vm.expectRevert("invalid proof");
        registry.submitBatch(publicValues, _proofs(2));

        assertFalse(registry.backfillComplete());
        assertEq(registry.claimJournalDigest(bytes32(uint256(1))), bytes32(0));
        assertEq(registry.washRatioBps(SELLER), 0);
    }

    function test_missingOrMismatchedBlockhashReverts() public {
        bytes memory missing = _journal(bytes32(uint256(1)), SELLER, 1, 2, 1, BLOCK_NUMBER + 1, BLOCK_HASH);
        bytes[] memory missingBatch = _one(missing);
        AntseedWashTradingRegistry missingRegistry = _deploy(missingBatch);
        vm.expectRevert(
            abi.encodeWithSelector(AntseedWashTradingRegistry.NonCanonicalBlock.selector, BLOCK_NUMBER + 1)
        );
        missingRegistry.submitBatch(missingBatch, _proofs(1));

        bytes32 wrongHash = keccak256("wrong hash");
        bytes[] memory mismatchBatch =
            _one(_journal(bytes32(uint256(1)), SELLER, 1, 2, 1, BLOCK_NUMBER, wrongHash));
        AntseedWashTradingRegistry mismatchRegistry = _deploy(mismatchBatch);
        vm.expectRevert(abi.encodeWithSelector(AntseedWashTradingRegistry.NonCanonicalBlock.selector, BLOCK_NUMBER));
        mismatchRegistry.submitBatch(mismatchBatch, _proofs(1));
    }

    function test_wrongVKeyPeriodAndPredicateRevert() public {
        bytes memory valid = _journal(bytes32(uint256(1)), SELLER, 1, 2, 1, BLOCK_NUMBER, BLOCK_HASH);
        bytes[] memory validBatch = _one(valid);
        AntseedWashTradingRegistry wrongVKeyRegistry = _deploy(validBatch);
        verifier.expectVKey(sha256(valid), RECIPROCAL_VKEY);
        vm.expectRevert("wrong vkey");
        wrongVKeyRegistry.submitBatch(validBatch, _proofs(1));

        bytes memory wrongPeriod = _journalWithPeriod(bytes32(uint256(2)), 8_453, 44_471_576, 49_936_172);
        bytes[] memory wrongPeriodBatch = _one(wrongPeriod);
        AntseedWashTradingRegistry wrongPeriodRegistry = _deploy(wrongPeriodBatch);
        vm.expectRevert(AntseedWashTradingRegistry.WrongPeriod.selector);
        wrongPeriodRegistry.submitBatch(wrongPeriodBatch, _proofs(1));

        bytes memory wrongPredicate = _journal(bytes32(uint256(3)), SELLER, 1, 2, 3, BLOCK_NUMBER, BLOCK_HASH);
        bytes[] memory wrongPredicateBatch = _one(wrongPredicate);
        AntseedWashTradingRegistry wrongPredicateRegistry = _deploy(wrongPredicateBatch);
        vm.expectRevert(abi.encodeWithSelector(AntseedWashTradingRegistry.InvalidPredicate.selector, uint8(3)));
        wrongPredicateRegistry.submitBatch(wrongPredicateBatch, _proofs(1));
    }

    function test_exactReplayIsIdempotentButDifferentJournalIsRejected() public {
        bytes memory original = _journal(bytes32(uint256(1)), SELLER, 1, 2, 1, BLOCK_NUMBER, BLOCK_HASH);
        bytes[] memory batch = _one(original);
        AntseedWashTradingRegistry registry = _deploy(batch);
        registry.submitBatch(batch, _proofs(1));

        registry.submit(original, "");
        assertEq(registry.washRatioBps(SELLER), 5_000);

        bytes memory changed = _journal(bytes32(uint256(1)), SELLER, 3, 4, 1, BLOCK_NUMBER, BLOCK_HASH);
        vm.expectRevert(
            abi.encodeWithSelector(
                AntseedWashTradingRegistry.ClaimDigestMismatch.selector,
                bytes32(uint256(1)),
                sha256(original),
                sha256(changed)
            )
        );
        registry.submit(changed, "");
    }

    function test_overlappingClaimsRetainOnlyStrictlyGreaterRatio() public {
        bytes[] memory batch = _one(_journal(bytes32(uint256(1)), SELLER, 1, 2, 1, BLOCK_NUMBER, BLOCK_HASH));
        AntseedWashTradingRegistry registry = _deploy(batch);
        registry.submitBatch(batch, _proofs(1));

        registry.submit(_journal(bytes32(uint256(2)), SELLER, 2, 5, 1, BLOCK_NUMBER, BLOCK_HASH), "");
        _assertRecord(registry, 1, 2, 5_000);

        registry.submit(_journal(bytes32(uint256(3)), SELLER, 50, 100, 1, BLOCK_NUMBER, BLOCK_HASH), "");
        _assertRecord(registry, 1, 2, 5_000);

        registry.submit(_journal(bytes32(uint256(4)), SELLER, 3, 4, 1, BLOCK_NUMBER, BLOCK_HASH), "");
        _assertRecord(registry, 3, 4, 7_500);
    }

    function test_zeroDenominatorAndAboveDenominatorClampToFullRatio() public {
        bytes[] memory batch = _one(_journal(bytes32(uint256(1)), SELLER, 1, 4, 1, BLOCK_NUMBER, BLOCK_HASH));
        AntseedWashTradingRegistry registry = _deploy(batch);
        registry.submitBatch(batch, _proofs(1));

        registry.submit(_journal(bytes32(uint256(2)), SELLER, 1, 0, 1, BLOCK_NUMBER, BLOCK_HASH), "");
        _assertRecord(registry, 1, 0, 10_000);

        registry.submit(_journal(bytes32(uint256(3)), SELLER, 5, 4, 1, BLOCK_NUMBER, BLOCK_HASH), "");
        _assertRecord(registry, 1, 0, 10_000);
    }

    function _deploy(bytes[] memory publicValues) internal returns (AntseedWashTradingRegistry) {
        return new AntseedWashTradingRegistry(
            address(verifier),
            address(blockhashStore),
            CLOSED_LOOP_VKEY,
            RECIPROCAL_VKEY,
            uint32(publicValues.length),
            _batchDigest(publicValues)
        );
    }

    function _batchDigest(bytes[] memory publicValues) internal view returns (bytes32 digest) {
        digest = keccak256(
            abi.encode(
                keccak256("ANTSEED_AIP4_BACKFILL_V1"),
                uint64(8_453),
                CLOSED_LOOP_VKEY,
                RECIPROCAL_VKEY,
                address(blockhashStore),
                publicValues.length
            )
        );
        for (uint256 index = 0; index < publicValues.length; ++index) {
            AntseedWashTradingRegistry.WashJournal memory journal =
                abi.decode(publicValues[index], (AntseedWashTradingRegistry.WashJournal));
            digest = keccak256(abi.encode(digest, journal.claimId, sha256(publicValues[index])));
        }
    }

    function _journal(
        bytes32 claimId,
        address subject,
        uint128 wash,
        uint128 settled,
        uint8 predicateId,
        uint64 blockNumber,
        bytes32 blockHash
    ) internal pure returns (bytes memory) {
        AntseedWashTradingRegistry.SubjectRecord[] memory subjects =
            new AntseedWashTradingRegistry.SubjectRecord[](1);
        subjects[0] = AntseedWashTradingRegistry.SubjectRecord(subject, wash, settled);
        AntseedWashTradingRegistry.BlockRef[] memory refs = new AntseedWashTradingRegistry.BlockRef[](1);
        refs[0] = AntseedWashTradingRegistry.BlockRef(blockNumber, blockHash);
        return abi.encode(
            AntseedWashTradingRegistry.WashJournal({
                predicateId: predicateId,
                chainId: 8_453,
                periodStartBlock: 44_471_575,
                periodEndBlock: 49_936_172,
                claimId: claimId,
                subjects: subjects,
                blockRefs: refs
            })
        );
    }

    function _journalWithPeriod(bytes32 claimId, uint64 chainId, uint64 startBlock, uint64 endBlock)
        internal
        pure
        returns (bytes memory)
    {
        AntseedWashTradingRegistry.SubjectRecord[] memory subjects =
            new AntseedWashTradingRegistry.SubjectRecord[](1);
        subjects[0] = AntseedWashTradingRegistry.SubjectRecord(SELLER, 1, 2);
        AntseedWashTradingRegistry.BlockRef[] memory refs = new AntseedWashTradingRegistry.BlockRef[](1);
        refs[0] = AntseedWashTradingRegistry.BlockRef(BLOCK_NUMBER, BLOCK_HASH);
        return abi.encode(
            AntseedWashTradingRegistry.WashJournal({
                predicateId: 1,
                chainId: chainId,
                periodStartBlock: startBlock,
                periodEndBlock: endBlock,
                claimId: claimId,
                subjects: subjects,
                blockRefs: refs
            })
        );
    }

    function _one(bytes memory value) internal pure returns (bytes[] memory values) {
        values = new bytes[](1);
        values[0] = value;
    }

    function _proofs(uint256 count) internal pure returns (bytes[] memory proofs) {
        proofs = new bytes[](count);
    }

    function _assertRecord(
        AntseedWashTradingRegistry registry,
        uint128 expectedWash,
        uint128 expectedSettled,
        uint16 expectedRatio
    ) internal view {
        (uint128 wash, uint128 settled) = registry.washRecords(SELLER);
        assertEq(wash, expectedWash);
        assertEq(settled, expectedSettled);
        assertEq(registry.washRatioBps(SELLER), expectedRatio);
    }
}
