// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

import { AntseedWashTradingRegistry } from "../integrity/AntseedWashTradingRegistry.sol";
import { AntseedWashTradingPointsPolicy } from "../policies/AntseedWashTradingPointsPolicy.sol";
import { IRiscZeroVerifier } from "../interfaces/IRiscZeroVerifier.sol";
import { IBlockhashSource } from "../interfaces/IBlockhashSource.sol";

contract DigestOnlyVerifier is IRiscZeroVerifier {
    bytes32 public immutable expectedDigest;

    error InvalidSeal();

    constructor(bytes32 digest) {
        expectedDigest = digest;
    }

    function verify(bytes calldata, bytes32, bytes32 journalDigest) external view {
        if (journalDigest != expectedDigest) revert InvalidSeal();
    }
}

contract StaticBlockhashSource is IBlockhashSource {
    mapping(uint256 => bytes32) public hashes;

    function set(uint256 number, bytes32 h) external {
        hashes[number] = h;
    }

    function blockHash(uint256 number) external view returns (bytes32) {
        return hashes[number];
    }
}

/// @notice Cross-language compatibility: `GUEST_JOURNAL` below is an exact
///         byte string committed by the RISC Zero guest. This test proves the
///         Solidity side decodes those bytes, reproduces the digest the
///         verifier receives, and accepts the finding end-to-end.
contract AntseedWashTradingJournalCompatTest is Test {
    // Output of the loop-proof fixture (journal ABI hex).
    bytes internal constant GUEST_JOURNAL =
        hex"000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000002105000000000000000000000000833589fcd6edb6e08f4c7c32d4f71b54bda02913000000000000000000000000ba66d3b4fbcf472f6f11d6f9f96aace96516f09d0000000000000000000000000f7a3a8f4da01637d1202bb5443fcf7f88f99fd20000000000000000000000000329c5d3920e301740f78d6e17b8d1a11cca9b2c000000000000000000000000d27016b0490a41de9267949913089fd6035b20fa000000000000000000000000d0b2386859bad9106670bb779ae8ff6af2b30b760000000000000000000000000000000000000000000000000000000000000003000000000000000000000000000000000000000000000000000000000e4e1c00000000000000000000000000000000000000000000000000000000000098968000000000000000000000000000000000000000000000000000000000001e19b40000000000000000000000000000000000000000000000000000000002cf98ca00000000000000000000000000000000000000000000000000000000000001c000000000000000000000000000000000000000000000000000000000000000070000000000000000000000000000000000000000000000000000000002c36fab93c12cea6d03ab36561937469f0b8b3ba736bf474843d48ba44c4f978ca49f220000000000000000000000000000000000000000000000000000000002c370b7079852c479313f777a016e2a3b9043cb500305dc4e7125cba5623a79de7fb51e0000000000000000000000000000000000000000000000000000000002c3720ee488c0cfbe97682bae768a03c5d797cb95a43451b477888528e3defc60932f960000000000000000000000000000000000000000000000000000000002cf98ca0e6a53456a103ef2c2c180e70ed2bc05c6d5973364d0c18fa839dbf84aa507ac0000000000000000000000000000000000000000000000000000000002cf9cf73b1b29f0fb63b13d0656748449850db056234c396977969d0d407fc4ce16dad10000000000000000000000000000000000000000000000000000000002cf9d18e360d7036e75a5dd69f5fab2154fcecae59759acbc2f92ba6291064192d848770000000000000000000000000000000000000000000000000000000002cf9d38ab413135fb1d58c17df54c4ff1b27ae3becbfa26fdd69389c507d782277d7faa";

    bytes32 internal constant GUEST_DIGEST = 0xa365c5870f45ba870b77ee4a05b51fc6998a9707d16ec4c18a33f57e26aa1813;

    address internal constant SELLER = 0x0329c5D3920E301740f78D6E17B8d1a11ccA9B2C;
    address internal constant BUYER = 0xd27016b0490a41de9267949913089fd6035b20FA;
    address internal constant FUNDER = 0xd0B2386859bAd9106670bb779ae8FF6Af2b30b76;

    function test_solidityReproducesGuestDigest() public pure {
        assertEq(sha256(GUEST_JOURNAL), GUEST_DIGEST);
    }

    function test_decodesGuestJournal() public pure {
        AntseedWashTradingRegistry.LoopJournal memory j =
            abi.decode(GUEST_JOURNAL, (AntseedWashTradingRegistry.LoopJournal));
        assertEq(j.predicateVersion, 1);
        assertEq(j.chainId, 8453);
        assertEq(j.usdc, 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913);
        assertEq(j.channels, 0xBA66d3b4fbCf472F6F11D6F9F96aaCE96516F09d);
        assertEq(j.deposits, 0x0F7a3a8f4Da01637d1202bb5443fcF7F88F99fD2);
        assertEq(j.seller, SELLER);
        assertEq(j.buyer, BUYER);
        assertEq(j.funder, FUNDER);
        assertEq(j.hopCount, 3);
        assertEq(j.sellerOutflowRaw, 240_000_000); // $240.00
        assertEq(j.fundedRaw, 10_000_000); // $10.00
        assertEq(j.settledAfterFundingRaw, 1_972_660); // $1.972660
        assertEq(j.fundingBlock, 47159498);
        assertEq(j.blockRefs.length, 7);
        assertEq(j.blockRefs[0].number, 46362539);
        assertEq(j.blockRefs[6].number, 47160632);
    }

    function test_registryAcceptsGuestJournalEndToEnd() public {
        AntseedWashTradingRegistry.LoopJournal memory j =
            abi.decode(GUEST_JOURNAL, (AntseedWashTradingRegistry.LoopJournal));

        DigestOnlyVerifier verifier = new DigestOnlyVerifier(GUEST_DIGEST);
        StaticBlockhashSource source = new StaticBlockhashSource();
        for (uint256 i = 0; i < j.blockRefs.length; i++) {
            source.set(j.blockRefs[i].number, j.blockRefs[i].blockHash);
        }
        vm.chainId(8453);
        AntseedWashTradingRegistry registry = new AntseedWashTradingRegistry(
            address(verifier), bytes32(uint256(1)), address(source), j.usdc, j.channels, j.deposits
        );
        AntseedWashTradingPointsPolicy policy = new AntseedWashTradingPointsPolicy(address(registry));

        registry.submitLoopFinding(bytes("seal"), GUEST_JOURNAL);

        assertTrue(registry.isFlagged(BUYER, SELLER));
        (uint16 sellerPenaltyBps, uint16 buyerPenaltyBps) = policy.penaltyBps(bytes32(0), BUYER, SELLER, 12345);
        assertEq(sellerPenaltyBps, 10_000);
        assertEq(buyerPenaltyBps, 10_000);
    }
}
