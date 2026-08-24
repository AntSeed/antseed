// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import { AntseedWashTradingRegistry } from "../integrity/AntseedWashTradingRegistry.sol";
import { IBaseAnalysisStateOracle } from "../interfaces/IBaseAnalysisStateOracle.sol";
import { ISP1Verifier } from "../interfaces/ISP1Verifier.sol";

contract MockVerifier is ISP1Verifier {
    bool public shouldRevert;

    function setRevert(bool v) external { shouldRevert = v; }

    function verifyProof(bytes32, bytes calldata, bytes calldata) external view {
        require(!shouldRevert, "invalid proof");
    }
}

contract MockStateOracle is IBaseAnalysisStateOracle {
    mapping(uint64 => bytes32) public canonicalHash;
    bool public historicalCoverageComplete;

    function setCanonical(uint64 number, bytes32 blockHash) external {
        canonicalHash[number] = blockHash;
    }

    function isCanonicalBlock(uint64 number, bytes32 blockHash) external view returns (bool) {
        return blockHash != bytes32(0) && canonicalHash[number] == blockHash;
    }
}

contract AntseedWashTradingRegistryTest is Test {
    bytes32 constant CL_VKEY = bytes32(uint256(1));
    bytes32 constant RC_VKEY = bytes32(uint256(2));
    address constant SELLER = address(0xBEEF);
    address constant SELLER_B = address(0xCAFE);

    MockVerifier verifier;
    MockStateOracle oracle;
    AntseedWashTradingRegistry registry;

    function setUp() public {
        verifier = new MockVerifier();
        oracle = new MockStateOracle();
        registry = new AntseedWashTradingRegistry(address(verifier), address(oracle), CL_VKEY, RC_VKEY);
    }

    function _journal(address subject, uint128 wash, uint128 settled, uint8 predId)
        internal
        pure
        returns (bytes memory)
    {
        AntseedWashTradingRegistry.SubjectRecord[] memory subjects =
            new AntseedWashTradingRegistry.SubjectRecord[](1);
        subjects[0] = AntseedWashTradingRegistry.SubjectRecord(subject, wash, settled);

        AntseedWashTradingRegistry.BlockRef[] memory refs =
            new AntseedWashTradingRegistry.BlockRef[](1);
        refs[0] = AntseedWashTradingRegistry.BlockRef(100, bytes32(uint256(100)));

        return abi.encode(AntseedWashTradingRegistry.WashJournal({
            predicateId: predId,
            chainId: 8_453,
            periodStartBlock: 44_471_575,
            periodEndBlock: 49_936_172,
            claimId: keccak256(abi.encode(subject, predId)),
            subjects: subjects,
            blockRefs: refs
        }));
    }

    function _allow() internal {
        oracle.setCanonical(100, bytes32(uint256(100)));
    }

    function test_submit_records_wash_ratio() public {
        _allow();
        bytes memory data = _journal(SELLER, 9000e6, 10000e6, 1);
        registry.submit(data, "");
        assertTrue(registry.isSellerWashTradingFlagged(SELLER));
        assertEq(registry.washRatioBps(SELLER), 9000);
        (uint128 wash, uint128 settled) = registry.washRecords(SELLER);
        assertEq(wash, 9000e6);
        assertEq(settled, 10000e6);
    }

    function test_submit_reciprocal_flags_subject() public {
        _allow();
        bytes memory data = _journal(SELLER, 5000e6, 10000e6, 2);
        registry.submit(data, "");
        assertTrue(registry.isSellerWashTradingFlagged(SELLER));
        assertEq(registry.washRatioBps(SELLER), 5000);
    }

    function test_revert_already_claimed() public {
        _allow();
        bytes memory data = _journal(SELLER, 100, 200, 1);
        registry.submit(data, "");
        vm.expectRevert(AntseedWashTradingRegistry.AlreadyClaimed.selector);
        registry.submit(data, "");
    }

    function test_revert_wrong_chain() public {
        _allow();
        AntseedWashTradingRegistry.SubjectRecord[] memory subjects =
            new AntseedWashTradingRegistry.SubjectRecord[](1);
        subjects[0] = AntseedWashTradingRegistry.SubjectRecord(SELLER, 100, 200);
        AntseedWashTradingRegistry.BlockRef[] memory refs =
            new AntseedWashTradingRegistry.BlockRef[](1);
        refs[0] = AntseedWashTradingRegistry.BlockRef(100, bytes32(uint256(100)));
        bytes memory data = abi.encode(AntseedWashTradingRegistry.WashJournal({
            predicateId: 1, chainId: 1, periodStartBlock: 0, periodEndBlock: 0,
            claimId: bytes32(uint256(99)), subjects: subjects, blockRefs: refs
        }));
        vm.expectRevert(AntseedWashTradingRegistry.WrongChain.selector);
        registry.submit(data, "");
    }

    function test_revert_non_canonical_block() public {
        bytes memory data = _journal(SELLER, 100, 200, 1);
        vm.expectRevert(abi.encodeWithSelector(AntseedWashTradingRegistry.NonCanonicalBlock.selector, uint64(100)));
        registry.submit(data, "");
    }

    function test_revert_invalid_proof() public {
        _allow();
        verifier.setRevert(true);
        bytes memory data = _journal(SELLER, 100, 200, 1);
        vm.expectRevert("invalid proof");
        registry.submit(data, "");
    }

    function test_wash_ratio_clamped() public {
        _allow();
        bytes memory data = _journal(SELLER, 15000e6, 10000e6, 1);
        registry.submit(data, "");
        assertEq(registry.washRatioBps(SELLER), 10_000);
    }

    function test_unflagged_seller_returns_zero() public {
        assertFalse(registry.isSellerWashTradingFlagged(SELLER));
        assertEq(registry.washRatioBps(SELLER), 0);
    }

    function test_volume_accumulates_across_claims() public {
        _allow();
        bytes memory data1 = _journal(SELLER, 3000e6, 10000e6, 1);
        registry.submit(data1, "");

        oracle.setCanonical(200, bytes32(uint256(200)));
        AntseedWashTradingRegistry.SubjectRecord[] memory subjects =
            new AntseedWashTradingRegistry.SubjectRecord[](1);
        subjects[0] = AntseedWashTradingRegistry.SubjectRecord(SELLER, 2000e6, 10000e6);
        AntseedWashTradingRegistry.BlockRef[] memory refs =
            new AntseedWashTradingRegistry.BlockRef[](1);
        refs[0] = AntseedWashTradingRegistry.BlockRef(200, bytes32(uint256(200)));
        bytes memory data2 = abi.encode(AntseedWashTradingRegistry.WashJournal({
            predicateId: 1, chainId: 8_453, periodStartBlock: 44_471_575, periodEndBlock: 49_936_172,
            claimId: keccak256("second"), subjects: subjects, blockRefs: refs
        }));
        registry.submit(data2, "");

        (uint128 wash,) = registry.washRecords(SELLER);
        assertEq(wash, 5000e6);
        assertEq(registry.washRatioBps(SELLER), 5000);
    }
}
