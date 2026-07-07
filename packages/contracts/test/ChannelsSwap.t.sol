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
 * @title ChannelsSwapTest
 * @notice Characterization of the swappable-Channels design's fund-recovery semantics.
 *         Deposits.{lockForChannel,releaseLock,chargeAndCreditPayouts} are gated to whatever
 *         `registry.channels()` currently points at. These tests pin the operational reality:
 *         re-pointing the registry transfers fund authority to the new Channels, which has no
 *         record of the old Channels' open channels — so a swap with open channels strands the
 *         reserved funds until the registry is pointed back (the documented recovery path).
 *
 *         Independent of fee/emission economics.
 */
contract ChannelsSwapTest is Test {
    MockUSDC usdc;
    MockERC8004Registry identity;
    AntseedRegistry registry;
    AntseedStaking staking;
    AntseedDeposits deposits;
    AntseedChannels channelsA;
    AntseedChannels channelsB;

    uint256 constant BUYER_PK = 0xA11CE;
    uint256 constant SELLER_PK = 0xB0B;
    bytes32 constant RESERVE_AUTH_TYPEHASH =
        keccak256("ReserveAuth(bytes32 channelId,uint128 maxAmount,uint256 deadline)");

    address buyer;
    address seller;
    address operator = address(0x0B0B);
    uint128 constant AMOUNT = 20_000_000;
    bytes32 constant SALT = keccak256("swap");

    function setUp() public {
        buyer = vm.addr(BUYER_PK);
        seller = vm.addr(SELLER_PK);

        usdc = new MockUSDC();
        identity = new MockERC8004Registry();
        registry = new AntseedRegistry();
        staking = new AntseedStaking(address(usdc), address(registry));
        deposits = new AntseedDeposits(address(usdc));
        channelsA = new AntseedChannels(address(registry));
        channelsB = new AntseedChannels(address(registry));

        registry.setChannels(address(channelsA));
        registry.setDeposits(address(deposits));
        registry.setStaking(address(staking));
        registry.setIdentityRegistry(address(identity));
        registry.setProtocolReserve(address(0xFEE));
        deposits.setRegistry(address(registry));
        channelsA.setFirstSignCap(100_000_000);
        channelsB.setFirstSignCap(100_000_000);

        // seller stakes
        vm.prank(seller);
        uint256 agentId = identity.register();
        usdc.mint(seller, 10_000_000);
        vm.startPrank(seller);
        usdc.approve(address(staking), 10_000_000);
        staking.stake(agentId, 10_000_000);
        vm.stopPrank();

        // buyer funds + operator
        vm.prank(buyer);
        identity.register();
        deposits.setCreditLimitOverride(buyer, type(uint256).max);
        uint256 nonce = deposits.getOperatorNonce(buyer);
        bytes32 sh = keccak256(abi.encode(deposits.SET_OPERATOR_TYPEHASH(), operator, nonce));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", deposits.domainSeparator(), sh));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(BUYER_PK, digest);
        deposits.setOperator(buyer, operator, nonce, abi.encodePacked(r, s, v));
        usdc.mint(address(this), 50_000_000);
        usdc.approve(address(deposits), 50_000_000);
        deposits.deposit(buyer, 50_000_000);
    }

    function _reserveOnA() internal returns (bytes32 id) {
        id = channelsA.computeChannelId(buyer, seller, SALT);
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 sh = keccak256(abi.encode(RESERVE_AUTH_TYPEHASH, id, AMOUNT, deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", channelsA.domainSeparator(), sh));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(BUYER_PK, digest);
        vm.prank(seller);
        channelsA.reserve(buyer, SALT, AMOUNT, deadline, abi.encodePacked(r, s, v));
    }

    function _reserved() internal view returns (uint256 reserved) {
        (, reserved,,,,) = deposits.buyers(buyer);
    }

    /// @notice After swapping registry.channels() to a new contract, the old Channels can no
    ///         longer release funds, and the reserved amount stays locked.
    function test_swapAway_strandsReservedFunds() public {
        bytes32 id = _reserveOnA();
        assertEq(_reserved(), AMOUNT, "reserved after reserve");

        // Buyer-side timeout path opened before the swap.
        vm.prank(operator);
        channelsA.requestClose(id);
        vm.warp(block.timestamp + 16 minutes);

        // Swap authority to channelsB.
        registry.setChannels(address(channelsB));

        // Old Channels can no longer release — Deposits.releaseLock is gated to channelsB now.
        vm.prank(operator);
        vm.expectRevert(AntseedDeposits.NotAuthorized.selector);
        channelsA.withdraw(id);

        assertEq(_reserved(), AMOUNT, "funds still stranded");
    }

    /// @notice The new Channels has no record of the old channel and cannot release its lock.
    function test_newChannels_cannotTouchOldChannel() public {
        bytes32 id = _reserveOnA();
        registry.setChannels(address(channelsB));

        vm.prank(operator);
        vm.expectRevert(AntseedChannels.ChannelNotActive.selector);
        channelsB.withdraw(id);

        vm.prank(seller);
        vm.expectRevert(AntseedChannels.ChannelNotActive.selector);
        channelsB.close(id, 0, "", "");
    }

    /// @notice Old Channels also loses settle authority after the swap (Deposits charge is gated).
    function test_swapAway_oldChannelsCannotSettle() public {
        bytes32 id = _reserveOnA();
        registry.setChannels(address(channelsB));

        uint128 cum = 5_000_000;
        bytes memory meta = abi.encode(uint256(1), uint256(0), uint256(0), uint256(0));
        bytes32 sh = keccak256(
            abi.encode(
                keccak256("SpendingAuth(bytes32 channelId,uint256 cumulativeAmount,bytes32 metadataHash)"),
                id,
                uint256(cum),
                keccak256(meta)
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", channelsA.domainSeparator(), sh));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(BUYER_PK, digest);

        vm.prank(seller);
        vm.expectRevert(AntseedDeposits.NotAuthorized.selector);
        channelsA.settle(id, cum, meta, abi.encodePacked(r, s, v));
    }

    /// @notice Recovery path: pointing the registry back to the old Channels restores its
    ///         authority and the reserved funds become releasable again.
    function test_swapBack_recoversFunds() public {
        bytes32 id = _reserveOnA();
        vm.prank(operator);
        channelsA.requestClose(id);
        vm.warp(block.timestamp + 16 minutes);

        registry.setChannels(address(channelsB)); // swap away
        registry.setChannels(address(channelsA)); // ...and back

        vm.prank(operator);
        channelsA.withdraw(id);

        assertEq(_reserved(), 0, "funds recovered after swap-back");
    }
}
