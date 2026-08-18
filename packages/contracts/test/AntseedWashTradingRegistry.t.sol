// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import { AntseedWashTradingRegistry } from "../integrity/AntseedWashTradingRegistry.sol";
import { AntseedBlockhashKeeper } from "../integrity/AntseedBlockhashKeeper.sol";
import { AntseedPointsPolicyRegistry } from "../policies/AntseedPointsPolicyRegistry.sol";
import { AntseedWashTradingPointsPolicy } from "../policies/AntseedWashTradingPointsPolicy.sol";
import { AntseedWashTradingSellerClaimPolicy } from
    "../policies/AntseedWashTradingSellerClaimPolicy.sol";
import { AntseedSellerRewardsPool } from "../rewards/AntseedSellerRewardsPool.sol";
import { IRiscZeroVerifier } from "../interfaces/IRiscZeroVerifier.sol";
import { IBlockhashSource } from "../interfaces/IBlockhashSource.sol";
import { IAntseedPointsPenaltyPolicy } from "../interfaces/IAntseedPointsPenaltyPolicy.sol";
import { IAntseedSellerClaimPolicy } from "../interfaces/IAntseedSellerClaimPolicy.sol";

contract MockRiscZeroVerifier is IRiscZeroVerifier {
    bytes32 public expectedSealHash;
    bytes32 public expectedImageId;
    bytes32 public expectedDigest;

    error InvalidSeal();

    function expect(bytes memory seal, bytes32 imageId, bytes32 digest) external {
        expectedSealHash = keccak256(seal);
        expectedImageId = imageId;
        expectedDigest = digest;
    }

    function verify(bytes calldata seal, bytes32 imageId, bytes32 journalDigest) external view {
        if (
            keccak256(seal) != expectedSealHash || imageId != expectedImageId
                || journalDigest != expectedDigest
        ) revert InvalidSeal();
    }
}

contract MockBlockhashSource is IBlockhashSource {
    mapping(uint256 => bytes32) public hashes;

    function set(uint256 number, bytes32 h) external {
        hashes[number] = h;
    }

    function blockHash(uint256 number) external view returns (bytes32) {
        return hashes[number];
    }
}

contract MockANTS is ERC20 {
    constructor() ERC20("ANTS", "ANTS") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract PoolRegistryStub {
    address public emissions;
    address public antsToken;

    constructor(address emissions_, address antsToken_) {
        emissions = emissions_;
        antsToken = antsToken_;
    }
}

contract HalfClaimPolicy is IAntseedSellerClaimPolicy {
    function claimableSellerRewards(address, uint256 lockedAmount) external pure returns (uint256) {
        return lockedAmount / 2;
    }
}

contract SoftPenaltyAfterWashPolicy is IAntseedPointsPenaltyPolicy {
    function penaltyCategory() external pure returns (bytes32) {
        return keccak256("verification");
    }

    function penaltyBps(bytes32, address, address, uint256) external pure returns (uint16, uint16) {
        return (2_000, 2_000);
    }
}

contract AntseedWashTradingRegistryTest is Test {
    bytes32 internal constant IMAGE_ID = bytes32(uint256(0xd09a8acf));
    address internal constant USDC = address(0x1111);
    address internal constant CHANNELS = address(0x2222);
    address internal constant DEPOSITS = address(0x3333);

    address internal seller = makeAddr("seller");
    address internal buyer = makeAddr("buyer");
    address internal funder = makeAddr("funder");
    address internal watcher = makeAddr("watcher");

    MockRiscZeroVerifier internal verifier;
    MockBlockhashSource internal source;
    AntseedWashTradingRegistry internal registry;
    AntseedWashTradingPointsPolicy internal policy;

    function setUp() public {
        verifier = new MockRiscZeroVerifier();
        source = new MockBlockhashSource();
        registry = new AntseedWashTradingRegistry(
            address(verifier), IMAGE_ID, address(source), USDC, CHANNELS, DEPOSITS
        );
        policy = new AntseedWashTradingPointsPolicy(address(registry));
    }

    function _journal() internal view returns (AntseedWashTradingRegistry.LoopJournal memory j) {
        AntseedWashTradingRegistry.BlockRef[] memory refs =
            new AntseedWashTradingRegistry.BlockRef[](2);
        refs[0] = AntseedWashTradingRegistry.BlockRef(46362539, bytes32(uint256(0xaaaa)));
        refs[1] = AntseedWashTradingRegistry.BlockRef(47159498, bytes32(uint256(0xbbbb)));
        j = AntseedWashTradingRegistry.LoopJournal({
            predicateVersion: 1,
            chainId: uint64(block.chainid),
            usdc: USDC,
            channels: CHANNELS,
            deposits: DEPOSITS,
            seller: seller,
            buyer: buyer,
            funder: funder,
            hopCount: 3,
            sellerOutflowRaw: 240_000_000,
            fundedRaw: 10_000_000,
            settledAfterFundingRaw: 1_972_660,
            fundingBlock: 47159498,
            blockRefs: refs
        });
    }

    function _arm(AntseedWashTradingRegistry.LoopJournal memory j)
        internal
        returns (bytes memory seal, bytes memory data)
    {
        data = abi.encode(j);
        seal = bytes("valid-seal");
        verifier.expect(seal, IMAGE_ID, sha256(data));
        for (uint256 i = 0; i < j.blockRefs.length; i++) {
            source.set(j.blockRefs[i].number, j.blockRefs[i].blockHash);
        }
    }

    function test_submitRecordsFindingAndPolicyZeroesEdge() public {
        (bytes memory seal, bytes memory data) = _arm(_journal());

        assertFalse(registry.isFlagged(buyer, seller));
        (uint16 sp, uint16 bp) = policy.penaltyBps(bytes32(0), buyer, seller, 1000);
        assertEq(sp, 0);
        assertEq(bp, 0);

        vm.prank(watcher);
        registry.submitLoopFinding(seal, data);

        assertTrue(registry.isFlagged(buyer, seller));
        (,, address recordedFunder, uint128 funded,,, uint64 recordedAt, address submitter) =
            registry.findings(buyer, seller);
        assertEq(recordedFunder, funder);
        assertEq(funded, 10_000_000);
        assertGt(recordedAt, 0);
        assertEq(submitter, watcher);

        // the flagged seller's volume earns nothing on either side, from
        // any buyer — proven edge or not
        (sp, bp) = policy.penaltyBps(bytes32(0), buyer, seller, 1000);
        assertEq(sp, 10_000);
        assertEq(bp, 10_000);
        (sp, bp) = policy.penaltyBps(bytes32(0), makeAddr("other"), seller, 1000);
        assertEq(sp, 10_000);
        assertEq(bp, 10_000);
    }

    function test_washPolicyRegistersInPointsRegistryAndHardVetoesLaterPolicies() public {
        AntseedPointsPolicyRegistry pointsRegistry = new AntseedPointsPolicyRegistry(address(this));
        pointsRegistry.registerPolicy(address(policy));
        pointsRegistry.registerPolicy(address(new SoftPenaltyAfterWashPolicy()));

        assertTrue(pointsRegistry.isPolicyRegistered(address(policy)));
        assertEq(pointsRegistry.policyCategory(address(policy)), policy.PENALTY_CATEGORY());

        (uint256 sellerPoints, uint256 buyerPoints) =
            pointsRegistry.points(bytes32(0), buyer, seller, 1_000);
        assertEq(sellerPoints, 800);
        assertEq(buyerPoints, 800);

        (bytes memory seal, bytes memory data) = _arm(_journal());
        registry.submitLoopFinding(seal, data);

        (sellerPoints, buyerPoints) = pointsRegistry.points(bytes32(0), buyer, seller, 1_000);
        assertEq(sellerPoints, 0);
        assertEq(buyerPoints, 0);
    }

    function test_rejectsInvalidSeal() public {
        (, bytes memory data) = _arm(_journal());
        vm.expectRevert(MockRiscZeroVerifier.InvalidSeal.selector);
        registry.submitLoopFinding(bytes("forged"), data);
    }

    function test_rejectsTamperedJournal() public {
        AntseedWashTradingRegistry.LoopJournal memory j = _journal();
        (bytes memory seal,) = _arm(j);
        j.settledAfterFundingRaw = 999_999_999; // inflate after sealing
        vm.expectRevert(MockRiscZeroVerifier.InvalidSeal.selector);
        registry.submitLoopFinding(seal, abi.encode(j));
    }

    function test_rejectsWrongChain() public {
        AntseedWashTradingRegistry.LoopJournal memory j = _journal();
        j.chainId = uint64(block.chainid) + 1;
        (bytes memory seal, bytes memory data) = _arm(j);
        vm.expectRevert(
            abi.encodeWithSelector(AntseedWashTradingRegistry.WrongChain.selector, j.chainId)
        );
        registry.submitLoopFinding(seal, data);
    }

    function test_rejectsWrongContracts() public {
        AntseedWashTradingRegistry.LoopJournal memory j = _journal();
        j.channels = makeAddr("fake-channels");
        (bytes memory seal, bytes memory data) = _arm(j);
        vm.expectRevert(AntseedWashTradingRegistry.WrongContracts.selector);
        registry.submitLoopFinding(seal, data);
    }

    function test_rejectsNonCanonicalBlock() public {
        AntseedWashTradingRegistry.LoopJournal memory j = _journal();
        (bytes memory seal, bytes memory data) = _arm(j);
        source.set(j.blockRefs[1].number, bytes32(uint256(0xdead))); // fork the anchor
        vm.expectRevert(
            abi.encodeWithSelector(
                AntseedWashTradingRegistry.BlockNotCanonical.selector,
                j.blockRefs[1].number,
                j.blockRefs[1].blockHash
            )
        );
        registry.submitLoopFinding(seal, data);
    }

    function test_rejectsEmptyBlockRefs() public {
        AntseedWashTradingRegistry.LoopJournal memory j = _journal();
        j.blockRefs = new AntseedWashTradingRegistry.BlockRef[](0);
        (bytes memory seal, bytes memory data) = _arm(j);
        vm.expectRevert(AntseedWashTradingRegistry.NoBlockRefs.selector);
        registry.submitLoopFinding(seal, data);
    }

    function test_sellerFlagCoversAllEdges() public {
        (bytes memory seal, bytes memory data) = _arm(_journal());
        registry.submitLoopFinding(seal, data);

        assertTrue(registry.isSellerFlagged(seller));
        assertGt(registry.sellerFlaggedAt(seller), 0);

        // proven edge: both sides zeroed
        (uint16 sp, uint16 bp) = policy.penaltyBps(bytes32(0), buyer, seller, 1000);
        assertEq(sp, 10_000);
        assertEq(bp, 10_000);

        // ANY buyer of the flagged seller earns nothing — flagged-seller
        // volume cannot farm buyer rewards through unproven wallets
        (sp, bp) = policy.penaltyBps(bytes32(0), makeAddr("organic-buyer"), seller, 1000);
        assertEq(sp, 10_000);
        assertEq(bp, 10_000);

        // unrelated seller untouched
        (sp, bp) = policy.penaltyBps(bytes32(0), buyer, makeAddr("clean-seller"), 1000);
        assertEq(sp, 0);
        assertEq(bp, 0);
    }

    function test_flaggedSellerCannotClaimLockedRewards() public {
        MockANTS ants = new MockANTS();
        PoolRegistryStub poolRegistry = new PoolRegistryStub(address(this), address(ants));
        AntseedSellerRewardsPool pool = new AntseedSellerRewardsPool(address(poolRegistry));
        pool.setSellerClaimPolicy(
            address(new AntseedWashTradingSellerClaimPolicy(address(registry), address(0)))
        );

        // this test contract is the emissions endpoint: record locked rewards
        address cleanSeller = makeAddr("clean-seller");
        pool.recordLockedReward(seller, 100 ether);
        pool.recordLockedReward(cleanSeller, 40 ether);
        ants.mint(address(pool), 140 ether);

        (bytes memory seal, bytes memory data) = _arm(_journal());
        registry.submitLoopFinding(seal, data);

        // flagged seller: locked ANTS are unreachable forever
        vm.prank(seller);
        vm.expectRevert(AntseedSellerRewardsPool.NothingToClaim.selector);
        pool.claim(seller);

        // clean seller: full release (no inner policy configured)
        vm.prank(cleanSeller);
        pool.claim(cleanSeller);
        assertEq(ants.balanceOf(cleanSeller), 40 ether);
    }

    function test_claimPolicyStacksWithInnerPolicy() public {
        AntseedWashTradingSellerClaimPolicy stacked = new AntseedWashTradingSellerClaimPolicy(
            address(registry), address(new HalfClaimPolicy())
        );

        // unflagged: inner policy decides (half vests)
        assertEq(stacked.claimableSellerRewards(seller, 100 ether), 50 ether);

        // flagged: wash check wins regardless of inner
        (bytes memory seal, bytes memory data) = _arm(_journal());
        registry.submitLoopFinding(seal, data);
        assertEq(stacked.claimableSellerRewards(seller, 100 ether), 0);
    }

    function test_newRuleMeansNewRegistry() public {
        // The registry is immutable: no owner, no setters. A new predicate
        // version is a fresh deployment pinning a different image ID —
        // proofs built for the old rule do not verify against it.
        AntseedWashTradingRegistry registry2 = new AntseedWashTradingRegistry(
            address(verifier), bytes32(uint256(2)), address(source), USDC, CHANNELS, DEPOSITS
        );
        assertEq(registry2.imageId(), bytes32(uint256(2)));

        (bytes memory seal, bytes memory data) = _arm(_journal()); // armed for IMAGE_ID
        vm.expectRevert(MockRiscZeroVerifier.InvalidSeal.selector);
        registry2.submitLoopFinding(seal, data);

        // and findings never leak across registries
        registry.submitLoopFinding(seal, data);
        assertTrue(registry.isFlagged(buyer, seller));
        assertFalse(registry2.isFlagged(buyer, seller));
    }

    function test_keeperCheckpointAndFallback() public {
        AntseedBlockhashKeeper keeper = new AntseedBlockhashKeeper();
        vm.roll(1000);
        vm.setBlockhash(999, bytes32(uint256(0xc0ffee)));

        // live window fallback works without a checkpoint
        assertEq(keeper.blockHash(999), bytes32(uint256(0xc0ffee)));

        // checkpoint survives past the native 256-block window
        keeper.checkpoint(999);
        vm.roll(1000 + 10_000);
        assertEq(keeper.blockHash(999), bytes32(uint256(0xc0ffee)));

        // un-checkpointed, out-of-window blocks are unknown
        assertEq(keeper.blockHash(998), bytes32(0));
        vm.expectRevert(
            abi.encodeWithSelector(AntseedBlockhashKeeper.BlockhashUnavailable.selector, 998)
        );
        keeper.checkpoint(998);
    }
}
