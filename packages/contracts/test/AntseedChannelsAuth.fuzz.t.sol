// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

import {AntseedChannels} from "../payments/AntseedChannels.sol";
import {AntseedDeposits} from "../payments/AntseedDeposits.sol";
import {AntseedStaking} from "../staking/AntseedStaking.sol";
import {AntseedRegistry} from "../core/AntseedRegistry.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {MockERC8004Registry} from "./mocks/MockERC8004Registry.sol";

/**
 * @title AntseedChannelsAuthFuzz
 * @notice Adversarial EIP-712 / state-machine cases NOT covered by AntseedChannels.t.sol
 *         (which already tests basic invalid-sig / firstSignCap / sellerNotStaked / operator
 *         gating): cross-seller replay, wrong-domain binding, wrong-channelId and amount/metadata
 *         signature mismatches, monotonic settle bounds, no-sig close, and terminal-state
 *         immutability. Pure safety, independent of economics.
 */
contract AntseedChannelsAuthFuzz is Test {
    MockUSDC usdc;
    MockERC8004Registry identity;
    AntseedRegistry registry;
    AntseedStaking staking;
    AntseedDeposits deposits;
    AntseedChannels channels;

    uint256 constant BUYER_PK = 0xA11CE;
    uint256 constant SELLER_PK = 0xB0B;
    uint256 constant SELLER2_PK = 0xB0B2;
    uint256 constant METADATA_VERSION = 1;

    bytes32 constant SPENDING_AUTH_TYPEHASH =
        keccak256("SpendingAuth(bytes32 channelId,uint256 cumulativeAmount,bytes32 metadataHash)");
    bytes32 constant RESERVE_AUTH_TYPEHASH =
        keccak256("ReserveAuth(bytes32 channelId,uint128 maxAmount,uint256 deadline)");

    address buyer;
    address seller;
    address seller2;
    address operator = address(0x0B0B0B);

    uint128 constant DEPOSIT_AMT = 50_000_000;

    function setUp() public {
        buyer = vm.addr(BUYER_PK);
        seller = vm.addr(SELLER_PK);
        seller2 = vm.addr(SELLER2_PK);

        usdc = new MockUSDC();
        identity = new MockERC8004Registry();
        registry = new AntseedRegistry();
        staking = new AntseedStaking(address(usdc), address(registry));
        deposits = new AntseedDeposits(address(usdc));
        channels = new AntseedChannels(address(registry));

        registry.setChannels(address(channels));
        registry.setDeposits(address(deposits));
        registry.setStaking(address(staking));
        registry.setIdentityRegistry(address(identity));
        registry.setProtocolReserve(address(0xFEE));
        deposits.setRegistry(address(registry));
        channels.setFirstSignCap(100_000_000);

        _stakeSeller(SELLER_PK);
        _stakeSeller(SELLER2_PK);
        _fundBuyer();
    }

    function _stakeSeller(uint256 pk) internal {
        address s = vm.addr(pk);
        vm.prank(s);
        uint256 agentId = identity.register();
        usdc.mint(s, 10_000_000);
        vm.startPrank(s);
        usdc.approve(address(staking), 10_000_000);
        staking.stake(agentId, 10_000_000);
        vm.stopPrank();
    }

    function _fundBuyer() internal {
        vm.prank(buyer);
        identity.register();
        deposits.setCreditLimitOverride(buyer, type(uint256).max);

        uint256 nonce = deposits.getOperatorNonce(buyer);
        bytes32 sh = keccak256(abi.encode(deposits.SET_OPERATOR_TYPEHASH(), operator, nonce));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", deposits.domainSeparator(), sh));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(BUYER_PK, digest);
        deposits.setOperator(buyer, operator, nonce, abi.encodePacked(r, s, v));

        usdc.mint(address(this), DEPOSIT_AMT);
        usdc.approve(address(deposits), DEPOSIT_AMT);
        deposits.deposit(buyer, DEPOSIT_AMT);
    }

    function _meta() internal pure returns (bytes memory) {
        return abi.encode(METADATA_VERSION, uint256(0), uint256(0), uint256(0));
    }

    function _channelsDigest(bytes32 structHash) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", channels.domainSeparator(), structHash));
    }

    function _signReserveAuth(uint256 pk, bytes32 id, uint128 maxAmount, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        bytes32 sh = keccak256(abi.encode(RESERVE_AUTH_TYPEHASH, id, maxAmount, deadline));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, _channelsDigest(sh));
        return abi.encodePacked(r, s, v);
    }

    function _signSpendingAuth(uint256 pk, bytes32 id, uint256 cum, bytes32 metadataHash)
        internal
        view
        returns (bytes memory)
    {
        bytes32 sh = keccak256(abi.encode(SPENDING_AUTH_TYPEHASH, id, cum, metadataHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, _channelsDigest(sh));
        return abi.encodePacked(r, s, v);
    }

    function _reserve(bytes32 salt, uint128 amount) internal returns (bytes32 id) {
        id = channels.computeChannelId(buyer, seller, salt);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signReserveAuth(BUYER_PK, id, amount, deadline);
        vm.prank(seller);
        channels.reserve(buyer, salt, amount, deadline, sig);
    }

    // ── reserve: cross-seller replay + wrong domain ────────────────────────────

    /// @notice A ReserveAuth bound to (buyer, sellerA)'s channelId cannot be replayed by sellerB,
    ///         whose reserve recomputes a different channelId, breaking the signature.
    function test_reserve_replayDifferentSellerRejected() public {
        uint128 amount = 10_000_000;
        bytes32 salt = keccak256("shared-salt");
        bytes32 idA = channels.computeChannelId(buyer, seller, salt);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signReserveAuth(BUYER_PK, idA, amount, deadline);

        vm.prank(seller2);
        vm.expectRevert(AntseedChannels.InvalidSignature.selector);
        channels.reserve(buyer, salt, amount, deadline, sig);
    }

    /// @notice A ReserveAuth signed against a foreign EIP-712 domain is rejected.
    function test_reserve_wrongDomainRejected() public {
        uint128 amount = 10_000_000;
        bytes32 salt = keccak256("s");
        bytes32 id = channels.computeChannelId(buyer, seller, salt);
        uint256 deadline = block.timestamp + 1 hours;

        bytes32 sh = keccak256(abi.encode(RESERVE_AUTH_TYPEHASH, id, amount, deadline));
        bytes32 wrongDigest = keccak256(abi.encodePacked("\x19\x01", deposits.domainSeparator(), sh));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(BUYER_PK, wrongDigest);

        vm.prank(seller);
        vm.expectRevert(AntseedChannels.InvalidSignature.selector);
        channels.reserve(buyer, salt, amount, deadline, abi.encodePacked(r, s, v));
    }

    function test_reserve_duplicateChannelRejected() public {
        bytes32 salt = keccak256("dup");
        _reserve(salt, 10_000_000);

        uint256 deadline = block.timestamp + 1 hours;
        bytes32 id = channels.computeChannelId(buyer, seller, salt);
        bytes memory sig = _signReserveAuth(BUYER_PK, id, 10_000_000, deadline);
        vm.prank(seller);
        vm.expectRevert(AntseedChannels.ChannelExists.selector);
        channels.reserve(buyer, salt, 10_000_000, deadline, sig);
    }

    // ── settle: signature binding to channelId / amount / metadata ──────────────

    function testFuzz_settle_wrongChannelIdRejected(bytes32 fakeId, uint128 cum) public {
        bytes32 id = _reserve(keccak256("c"), DEPOSIT_AMT);
        vm.assume(fakeId != id);
        cum = uint128(bound(cum, 1, DEPOSIT_AMT));

        bytes memory sig = _signSpendingAuth(BUYER_PK, fakeId, cum, keccak256(_meta()));
        vm.prank(seller);
        vm.expectRevert(AntseedChannels.InvalidSignature.selector);
        channels.settle(id, cum, _meta(), sig);
    }

    function testFuzz_settle_amountMismatchRejected(uint128 signedAmt, uint128 callAmt) public {
        bytes32 id = _reserve(keccak256("c"), DEPOSIT_AMT);
        signedAmt = uint128(bound(signedAmt, 1, DEPOSIT_AMT));
        callAmt = uint128(bound(callAmt, 1, DEPOSIT_AMT));
        vm.assume(signedAmt != callAmt);

        bytes memory sig = _signSpendingAuth(BUYER_PK, id, signedAmt, keccak256(_meta()));
        vm.prank(seller);
        vm.expectRevert(AntseedChannels.InvalidSignature.selector);
        channels.settle(id, callAmt, _meta(), sig);
    }

    function test_settle_tamperedMetadataRejected() public {
        bytes32 id = _reserve(keccak256("c"), DEPOSIT_AMT);
        uint128 cum = 10_000_000;
        bytes memory tamperedMeta = abi.encode(METADATA_VERSION, uint256(999), uint256(0), uint256(0));
        bytes memory sig = _signSpendingAuth(BUYER_PK, id, cum, keccak256(_meta()));

        vm.prank(seller);
        vm.expectRevert(AntseedChannels.InvalidSignature.selector);
        channels.settle(id, cum, tamperedMeta, sig);
    }

    function test_settle_monotonicAndBounds() public {
        bytes32 id = _reserve(keccak256("c"), DEPOSIT_AMT);

        uint128 first = 20_000_000;
        bytes memory sig1 = _signSpendingAuth(BUYER_PK, id, first, keccak256(_meta()));
        vm.prank(seller);
        channels.settle(id, first, _meta(), sig1);

        // cum <= settled reverts.
        bytes memory sigLow = _signSpendingAuth(BUYER_PK, id, first, keccak256(_meta()));
        vm.prank(seller);
        vm.expectRevert(AntseedChannels.InvalidAmount.selector);
        channels.settle(id, first, _meta(), sigLow);

        // cum > deposit reverts.
        uint128 tooHigh = DEPOSIT_AMT + 1;
        bytes memory sigHigh = _signSpendingAuth(BUYER_PK, id, tooHigh, keccak256(_meta()));
        vm.prank(seller);
        vm.expectRevert(AntseedChannels.InvalidAmount.selector);
        channels.settle(id, tooHigh, _meta(), sigHigh);
    }

    // ── close without signature + terminal immutability ─────────────────────────

    function test_close_atSettledNeedsNoSignature() public {
        bytes32 id = _reserve(keccak256("c"), DEPOSIT_AMT);
        vm.prank(seller);
        channels.close(id, 0, _meta(), bytes(""));

        (,,,,,,,, AntseedChannels.ChannelStatus status) = channels.channels(id);
        assertEq(uint256(status), uint256(AntseedChannels.ChannelStatus.Settled));
    }

    function test_terminalChannelRejectsAllMutations() public {
        bytes32 id = _reserve(keccak256("c"), DEPOSIT_AMT);
        vm.prank(seller);
        channels.close(id, 0, _meta(), bytes(""));

        bytes memory sig = _signSpendingAuth(BUYER_PK, id, 1_000_000, keccak256(_meta()));

        vm.prank(seller);
        vm.expectRevert(AntseedChannels.ChannelNotActive.selector);
        channels.settle(id, 1_000_000, _meta(), sig);

        vm.prank(seller);
        vm.expectRevert(AntseedChannels.ChannelNotActive.selector);
        channels.close(id, 0, _meta(), bytes(""));

        vm.prank(seller);
        vm.expectRevert(AntseedChannels.ChannelNotActive.selector);
        channels.topUp(id, 1_000_000, _meta(), sig, DEPOSIT_AMT + 1, block.timestamp + 1 hours, sig);

        vm.prank(operator);
        vm.expectRevert(AntseedChannels.ChannelNotActive.selector);
        channels.requestClose(id);

        vm.prank(operator);
        vm.expectRevert(AntseedChannels.ChannelNotActive.selector);
        channels.withdraw(id);
    }
}
