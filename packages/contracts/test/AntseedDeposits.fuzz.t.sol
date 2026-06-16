// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

import {AntseedDeposits} from "../AntseedDeposits.sol";
import {AntseedRegistry} from "../AntseedRegistry.sol";
import {MockUSDC} from "../MockUSDC.sol";

/**
 * @title AntseedDepositsFuzz
 * @notice Stateless fuzz tests for AntseedDeposits custody arithmetic. The test contract
 *         registers itself as `channels` in the registry so it can drive the onlyChannels
 *         entrypoints (lockForChannel / chargeAndCreditPayouts / releaseLock) directly.
 */
contract AntseedDepositsFuzz is Test {
    MockUSDC usdc;
    AntseedRegistry registry;
    AntseedDeposits deposits;

    uint256 constant BUYER_PK = 0xB0B;
    address buyer;
    address operator = address(0x0BDE);
    address seller = address(0x5E11);
    address protocolReserve = address(0xFEE);

    function setUp() public {
        buyer = vm.addr(BUYER_PK);
        usdc = new MockUSDC();
        registry = new AntseedRegistry();
        deposits = new AntseedDeposits(address(usdc));

        // The test contract acts as Channels so it can call privileged custody fns.
        registry.setChannels(address(this));
        registry.setProtocolReserve(protocolReserve);
        deposits.setRegistry(address(registry));

        // No credit-limit friction for arithmetic-focused fuzzing.
        deposits.setCreditLimitOverride(buyer, type(uint256).max);

        // Set operator so withdraw paths are reachable.
        uint256 nonce = deposits.getOperatorNonce(buyer);
        bytes32 structHash = keccak256(abi.encode(deposits.SET_OPERATOR_TYPEHASH(), operator, nonce));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", deposits.domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(BUYER_PK, digest);
        deposits.setOperator(buyer, operator, nonce, abi.encodePacked(r, s, v));
    }

    function _fund(uint256 amount) internal {
        usdc.mint(address(this), amount);
        usdc.approve(address(deposits), amount);
        deposits.deposit(buyer, amount);
    }

    // ── deposit ───────────────────────────────────────────────────────────
    function testFuzz_depositTracksCustody(uint256 amount) public {
        amount = bound(amount, deposits.MIN_BUYER_DEPOSIT(), 1_000_000_000_000);
        _fund(amount);

        (uint256 balance, uint256 reserved,,,,) = deposits.buyers(buyer);
        assertEq(balance, amount);
        assertEq(reserved, 0);
        assertEq(usdc.balanceOf(address(deposits)), amount);
    }

    // ── lock / release round trip ──────────────────────────────────────────
    function testFuzz_lockReleaseRoundTrip(uint256 deposited, uint256 lock) public {
        deposited = bound(deposited, deposits.MIN_BUYER_DEPOSIT(), 1_000_000_000_000);
        lock = bound(lock, 1, deposited);
        _fund(deposited);

        deposits.lockForChannel(buyer, lock);
        (, uint256 reservedAfterLock,,,,) = deposits.buyers(buyer);
        assertEq(reservedAfterLock, lock);

        deposits.releaseLock(buyer, lock);
        (uint256 balance, uint256 reserved,,,,) = deposits.buyers(buyer);
        assertEq(reserved, 0);
        assertEq(balance, deposited, "release must not touch balance");
    }

    /// @notice Locking can never reserve more than the available (balance - reserved) funds.
    function testFuzz_cannotLockBeyondAvailable(uint256 deposited, uint256 lock) public {
        deposited = bound(deposited, deposits.MIN_BUYER_DEPOSIT(), 1_000_000_000_000);
        lock = bound(lock, deposited + 1, type(uint128).max);
        _fund(deposited);

        vm.expectRevert(AntseedDeposits.InsufficientBalance.selector);
        deposits.lockForChannel(buyer, lock);
    }

    // ── charge conservation ─────────────────────────────────────────────────
    /// @notice chargeAndCreditPayouts decrements balance & reserved by `amount`, and the USDC
    ///         that leaves Deposits equals `amount` (fee to reserve + payout to seller).
    function testFuzz_chargeConservation(uint256 deposited, uint256 charge, uint256 feeBps) public {
        deposited = bound(deposited, deposits.MIN_BUYER_DEPOSIT(), 1_000_000_000_000);
        charge = bound(charge, 1, deposited);
        feeBps = bound(feeBps, 0, 1000);
        _fund(deposited);
        deposits.lockForChannel(buyer, charge);

        uint256 fee = (charge * feeBps) / 10000;
        uint256 beforeDeposits = usdc.balanceOf(address(deposits));
        uint256 beforeSeller = usdc.balanceOf(seller);
        uint256 beforeReserve = usdc.balanceOf(protocolReserve);

        deposits.chargeAndCreditPayouts(buyer, seller, charge, fee);

        (uint256 balance, uint256 reserved,,,,) = deposits.buyers(buyer);
        assertEq(balance, deposited - charge, "balance decremented by charge");
        assertEq(reserved, 0, "reserved decremented by charge");

        // USDC leaving Deposits == charge; split between seller and protocol reserve.
        assertEq(beforeDeposits - usdc.balanceOf(address(deposits)), charge, "custody outflow != charge");
        assertEq(usdc.balanceOf(seller) - beforeSeller, charge - fee, "seller payout wrong");
        assertEq(usdc.balanceOf(protocolReserve) - beforeReserve, fee, "fee payout wrong");
    }

    // ── withdraw ─────────────────────────────────────────────────────────────
    function testFuzz_withdrawRespectsAvailable(uint256 deposited, uint256 lock, uint256 take) public {
        deposited = bound(deposited, deposits.MIN_BUYER_DEPOSIT(), 1_000_000_000_000);
        lock = bound(lock, 0, deposited);
        _fund(deposited);
        if (lock > 0) deposits.lockForChannel(buyer, lock);

        uint256 available = deposited - lock;
        take = bound(take, 1, deposited);

        vm.prank(operator);
        if (take > available) {
            vm.expectRevert(AntseedDeposits.InsufficientBalance.selector);
            deposits.withdraw(buyer, take);
        } else {
            deposits.withdraw(buyer, take);
            (uint256 balance,,,,,) = deposits.buyers(buyer);
            assertEq(balance, deposited - take);
            assertEq(usdc.balanceOf(operator), take);
        }
    }

    // ── credit limit bounds ──────────────────────────────────────────────────
    function testFuzz_creditLimitWithinBounds(uint256 uniqueSellers, uint256 daysElapsed) public {
        address fresh = address(0xCAFE);
        uniqueSellers = bound(uniqueSellers, 0, 50);
        daysElapsed = bound(daysElapsed, 0, 3650);

        // No override → derived limit must sit within [BASE, MAX].
        uint256 limit = deposits.getBuyerCreditLimit(fresh);
        assertGe(limit, deposits.BASE_CREDIT_LIMIT());
        assertLe(limit, deposits.MAX_CREDIT_LIMIT());
    }
}
