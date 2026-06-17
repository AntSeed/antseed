// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

import {AntseedChannels} from "../AntseedChannels.sol";
import {AntseedDeposits} from "../AntseedDeposits.sol";
import {AntseedStaking} from "../AntseedStaking.sol";
import {AntseedRegistry} from "../AntseedRegistry.sol";
import {AntseedStats} from "../AntseedStats.sol";
import {MockUSDC} from "../MockUSDC.sol";
import {MockERC8004Registry} from "../MockERC8004Registry.sol";

/**
 * @title AntseedChannelsAuthFuzz
 * @notice Adversarial fuzz tests for the AntseedChannels EIP-712 authorization layer and
 *         channel state machine: signature binding, replay resistance, monotonicity,
 *         caller authorization, and terminal-state immutability. Pure safety properties,
 *         independent of fee/emission economics.
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

    // secp256k1 group order — valid private keys are in [1, N-1].
    uint256 constant SECP_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
    uint256 constant METADATA_VERSION = 1;

    bytes32 constant SPENDING_AUTH_TYPEHASH =
        keccak256("SpendingAuth(bytes32 channelId,uint256 cumulativeAmount,bytes32 metadataHash)");
    bytes32 constant RESERVE_AUTH_TYPEHASH =
        keccak256("ReserveAuth(bytes32 channelId,uint128 maxAmount,uint256 deadline)");

    address buyer;
    address seller;
    address seller2;
    address operator = address(0x0B0B0B);
    address protocolReserve = address(0xFEE);

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
        registry.setProtocolReserve(protocolReserve);
        deposits.setRegistry(address(registry));

        channels.setFirstSignCap(100_000_000);

        _stakeSeller(SELLER_PK);
        _stakeSeller(SELLER2_PK);
        _fundBuyer();
    }

    // ── setup helpers ────────────────────────────────────────────────────
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

    // ── signing helpers ────────────────────────────────────────────────────
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

    /// @dev Reserve a channel for `seller` and return its id.
    function _reserve(bytes32 salt, uint128 amount) internal returns (bytes32 id) {
        id = channels.computeChannelId(buyer, seller, salt);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signReserveAuth(BUYER_PK, id, amount, deadline);
        vm.prank(seller);
        channels.reserve(buyer, salt, amount, deadline, sig);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                        RESERVE AUTH
    // ═══════════════════════════════════════════════════════════════════════

    function testFuzz_reserve_wrongSignerRejected(uint256 badPk, uint128 amount) public {
        badPk = bound(badPk, 1, SECP_N - 1);
        if (badPk == BUYER_PK) badPk = BUYER_PK - 1;
        amount = uint128(bound(amount, 1, DEPOSIT_AMT));

        bytes32 salt = keccak256("s");
        bytes32 id = channels.computeChannelId(buyer, seller, salt);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signReserveAuth(badPk, id, amount, deadline);

        vm.prank(seller);
        vm.expectRevert(AntseedChannels.InvalidSignature.selector);
        channels.reserve(buyer, salt, amount, deadline, sig);
    }

    function testFuzz_reserve_wrongDomainRejected(uint128 amount) public {
        amount = uint128(bound(amount, 1, DEPOSIT_AMT));
        bytes32 salt = keccak256("s");
        bytes32 id = channels.computeChannelId(buyer, seller, salt);
        uint256 deadline = block.timestamp + 1 hours;

        // Sign the right struct but against the Deposits domain separator.
        bytes32 sh = keccak256(abi.encode(RESERVE_AUTH_TYPEHASH, id, amount, deadline));
        bytes32 wrongDigest = keccak256(abi.encodePacked("\x19\x01", deposits.domainSeparator(), sh));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(BUYER_PK, wrongDigest);

        vm.prank(seller);
        vm.expectRevert(AntseedChannels.InvalidSignature.selector);
        channels.reserve(buyer, salt, amount, deadline, abi.encodePacked(r, s, v));
    }

    /// @notice A ReserveAuth signed for a channelId derived from seller A cannot be replayed by
    ///         seller B (B's reserve recomputes a different channelId, so the sig fails).
    function testFuzz_reserve_replayDifferentSellerRejected(uint128 amount) public {
        amount = uint128(bound(amount, 1, DEPOSIT_AMT));
        bytes32 salt = keccak256("shared-salt");

        // Buyer signs for the (buyer, seller) channel.
        bytes32 idA = channels.computeChannelId(buyer, seller, salt);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signReserveAuth(BUYER_PK, idA, amount, deadline);

        // seller2 tries to reuse it; reserve recomputes id from (buyer, seller2) -> mismatch.
        vm.prank(seller2);
        vm.expectRevert(AntseedChannels.InvalidSignature.selector);
        channels.reserve(buyer, salt, amount, deadline, sig);
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

    function testFuzz_reserve_aboveFirstSignCapRejected(uint128 amount) public {
        channels.setFirstSignCap(1_000_000);
        amount = uint128(bound(amount, 1_000_001, type(uint128).max));

        bytes32 salt = keccak256("cap");
        bytes32 id = channels.computeChannelId(buyer, seller, salt);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signReserveAuth(BUYER_PK, id, amount, deadline);

        vm.prank(seller);
        vm.expectRevert(AntseedChannels.FirstSignCapExceeded.selector);
        channels.reserve(buyer, salt, amount, deadline, sig);
    }

    function test_reserve_unstakedSellerRejected() public {
        address rando = address(0xDEAD);
        bytes32 salt = keccak256("nostake");
        bytes32 id = channels.computeChannelId(buyer, rando, salt);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signReserveAuth(BUYER_PK, id, 1_000_000, deadline);

        vm.prank(rando);
        vm.expectRevert(AntseedChannels.SellerNotStaked.selector);
        channels.reserve(buyer, salt, 1_000_000, deadline, sig);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                        SPENDING AUTH (settle)
    // ═══════════════════════════════════════════════════════════════════════

    function testFuzz_settle_wrongChannelIdRejected(bytes32 fakeId, uint128 cum) public {
        bytes32 salt = keccak256("c");
        bytes32 id = _reserve(salt, DEPOSIT_AMT);
        vm.assume(fakeId != id);
        cum = uint128(bound(cum, 1, DEPOSIT_AMT));

        // Sign over a different channelId than the one being settled.
        bytes memory sig = _signSpendingAuth(BUYER_PK, fakeId, cum, keccak256(_meta()));

        vm.prank(seller);
        vm.expectRevert(AntseedChannels.InvalidSignature.selector);
        channels.settle(id, cum, _meta(), sig);
    }

    function testFuzz_settle_amountMismatchRejected(uint128 signedAmt, uint128 callAmt) public {
        bytes32 salt = keccak256("c");
        bytes32 id = _reserve(salt, DEPOSIT_AMT);
        signedAmt = uint128(bound(signedAmt, 1, DEPOSIT_AMT));
        callAmt = uint128(bound(callAmt, 1, DEPOSIT_AMT));
        vm.assume(signedAmt != callAmt);

        bytes memory sig = _signSpendingAuth(BUYER_PK, id, signedAmt, keccak256(_meta()));

        vm.prank(seller);
        vm.expectRevert(AntseedChannels.InvalidSignature.selector);
        channels.settle(id, callAmt, _meta(), sig);
    }

    function test_settle_tamperedMetadataRejected() public {
        bytes32 salt = keccak256("c");
        bytes32 id = _reserve(salt, DEPOSIT_AMT);
        uint128 cum = 10_000_000;

        bytes memory signedMeta = _meta();
        bytes memory tamperedMeta = abi.encode(METADATA_VERSION, uint256(999), uint256(0), uint256(0));
        bytes memory sig = _signSpendingAuth(BUYER_PK, id, cum, keccak256(signedMeta));

        vm.prank(seller);
        vm.expectRevert(AntseedChannels.InvalidSignature.selector);
        channels.settle(id, cum, tamperedMeta, sig);
    }

    function test_settle_monotonicAndBounds() public {
        bytes32 salt = keccak256("c");
        bytes32 id = _reserve(salt, DEPOSIT_AMT);

        // First settle to 20 USDC.
        uint128 first = 20_000_000;
        bytes memory sig1 = _signSpendingAuth(BUYER_PK, id, first, keccak256(_meta()));
        vm.prank(seller);
        channels.settle(id, first, _meta(), sig1);

        // cum <= settled reverts InvalidAmount.
        bytes memory sigLow = _signSpendingAuth(BUYER_PK, id, first, keccak256(_meta()));
        vm.prank(seller);
        vm.expectRevert(AntseedChannels.InvalidAmount.selector);
        channels.settle(id, first, _meta(), sigLow);

        // cum > deposit reverts InvalidAmount.
        uint128 tooHigh = DEPOSIT_AMT + 1;
        bytes memory sigHigh = _signSpendingAuth(BUYER_PK, id, tooHigh, keccak256(_meta()));
        vm.prank(seller);
        vm.expectRevert(AntseedChannels.InvalidAmount.selector);
        channels.settle(id, tooHigh, _meta(), sigHigh);
    }

    function testFuzz_settle_onlySeller(address caller) public {
        bytes32 salt = keccak256("c");
        bytes32 id = _reserve(salt, DEPOSIT_AMT);
        vm.assume(caller != seller);

        uint128 cum = 10_000_000;
        bytes memory sig = _signSpendingAuth(BUYER_PK, id, cum, keccak256(_meta()));

        vm.prank(caller);
        vm.expectRevert(AntseedChannels.NotAuthorized.selector);
        channels.settle(id, cum, _meta(), sig);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                        CLOSE
    // ═══════════════════════════════════════════════════════════════════════

    function test_close_atSettledNeedsNoSignature() public {
        bytes32 salt = keccak256("c");
        bytes32 id = _reserve(salt, DEPOSIT_AMT);

        // finalAmount == settled (0) -> no signature required.
        vm.prank(seller);
        channels.close(id, 0, _meta(), bytes(""));

        (,,,,,,,, AntseedChannels.ChannelStatus status) = channels.channels(id);
        assertEq(uint256(status), uint256(AntseedChannels.ChannelStatus.Settled));
    }

    function testFuzz_close_aboveSettledRequiresValidSig(uint128 finalAmount) public {
        bytes32 salt = keccak256("c");
        bytes32 id = _reserve(salt, DEPOSIT_AMT);
        finalAmount = uint128(bound(finalAmount, 1, DEPOSIT_AMT));

        // Empty signature on a real settlement must revert.
        vm.prank(seller);
        vm.expectRevert();
        channels.close(id, finalAmount, _meta(), bytes(""));
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                        OPERATOR-GATED PATHS
    // ═══════════════════════════════════════════════════════════════════════

    function testFuzz_requestClose_onlyOperator(address caller) public {
        bytes32 salt = keccak256("c");
        bytes32 id = _reserve(salt, DEPOSIT_AMT);
        vm.assume(caller != operator);

        vm.prank(caller);
        vm.expectRevert(AntseedChannels.NotAuthorized.selector);
        channels.requestClose(id);
    }

    function testFuzz_withdraw_onlyOperator(address caller) public {
        bytes32 salt = keccak256("c");
        bytes32 id = _reserve(salt, DEPOSIT_AMT);
        vm.assume(caller != operator);

        vm.prank(caller);
        vm.expectRevert(AntseedChannels.NotAuthorized.selector);
        channels.withdraw(id);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                        TERMINAL-STATE IMMUTABILITY
    // ═══════════════════════════════════════════════════════════════════════

    function test_terminalChannelRejectsAllMutations() public {
        bytes32 salt = keccak256("c");
        bytes32 id = _reserve(salt, DEPOSIT_AMT);

        // Drive to terminal (Settled) via close.
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
