// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

import {AntseedDeposits} from "../AntseedDeposits.sol";
import {AntseedRegistry} from "../AntseedRegistry.sol";
import {MockUSDC} from "../MockUSDC.sol";

/**
 * @title AntseedDepositsFuzz
 * @notice Net-new Deposits coverage not in AntseedDeposits.t.sol: the charge fee-split
 *         arithmetic fuzzed across the full (amount, fee) range, plus a characterization of the
 *         transferOperator zero-address gap (audit lead). The test contract registers itself as
 *         `channels` so it can drive the privileged custody entrypoints.
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

        registry.setChannels(address(this)); // test acts as Channels for custody calls
        registry.setProtocolReserve(protocolReserve);
        deposits.setRegistry(address(registry));
        deposits.setCreditLimitOverride(buyer, type(uint256).max);

        // Set operator (needed for the transferOperator characterization).
        uint256 nonce = deposits.getOperatorNonce(buyer);
        bytes32 sh = keccak256(abi.encode(deposits.SET_OPERATOR_TYPEHASH(), operator, nonce));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", deposits.domainSeparator(), sh));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(BUYER_PK, digest);
        deposits.setOperator(buyer, operator, nonce, abi.encodePacked(r, s, v));
    }

    function _fund(uint256 amount) internal {
        usdc.mint(address(this), amount);
        usdc.approve(address(deposits), amount);
        deposits.deposit(buyer, amount);
    }

    /// @notice chargeAndCreditPayouts decrements balance & reserved by `amount`, and the USDC
    ///         that leaves Deposits equals `amount` (fee to reserve + payout to seller), across
    ///         the full amount/fee range — exercises the fee-split rounding the unit tests fix.
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
        assertEq(beforeDeposits - usdc.balanceOf(address(deposits)), charge, "custody outflow != charge");
        assertEq(usdc.balanceOf(seller) - beforeSeller, charge - fee, "seller payout wrong");
        assertEq(usdc.balanceOf(protocolReserve) - beforeReserve, fee, "fee payout wrong");
    }

    /// @notice CHARACTERIZATION (audit lead): transferOperator has no zero-address guard (unlike
    ///         setOperator), so the current operator can brick the buyer by zeroing it. Pins the
    ///         current behavior so a future fix flips this test red.
    function test_transferOperator_currentlyAllowsZeroAddress_KNOWN_GAP() public {
        vm.prank(operator);
        deposits.transferOperator(buyer, address(0)); // does NOT revert today
        assertEq(deposits.getOperator(buyer), address(0));
    }
}
