// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

import {AntseedDeposits} from "../AntseedDeposits.sol";
import {AntseedRegistry} from "../AntseedRegistry.sol";
import {MockUSDC} from "../MockUSDC.sol";

/**
 * @title AntseedDepositsOperatorFuzz
 * @notice Fuzz tests for the AntseedDeposits operator authorization (EIP-712 SetOperator) and
 *         transferOperator. Pure auth/state-machine properties, independent of economics.
 */
contract AntseedDepositsOperatorFuzz is Test {
    MockUSDC usdc;
    AntseedRegistry registry;
    AntseedDeposits deposits;

    uint256 constant BUYER_PK = 0xA11CE;
    uint256 constant SECP_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

    address buyer;
    address operator = address(0x0B0B);

    function setUp() public {
        buyer = vm.addr(BUYER_PK);
        usdc = new MockUSDC();
        registry = new AntseedRegistry();
        deposits = new AntseedDeposits(address(usdc));
        deposits.setRegistry(address(registry));
    }

    function _signSetOperator(uint256 pk, address op, uint256 nonce) internal view returns (bytes memory) {
        bytes32 sh = keccak256(abi.encode(deposits.SET_OPERATOR_TYPEHASH(), op, nonce));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", deposits.domainSeparator(), sh));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    // ── happy path ───────────────────────────────────────────────────────────
    function test_setOperator_validSig() public {
        bytes memory sig = _signSetOperator(BUYER_PK, operator, 0);
        deposits.setOperator(buyer, operator, 0, sig);

        assertEq(deposits.getOperator(buyer), operator);
        assertEq(deposits.getOperatorNonce(buyer), 1);
    }

    // ── signer / nonce / domain binding ──────────────────────────────────────
    function testFuzz_setOperator_wrongSignerRejected(uint256 badPk) public {
        badPk = bound(badPk, 1, SECP_N - 1);
        if (badPk == BUYER_PK) badPk = BUYER_PK - 1;
        bytes memory sig = _signSetOperator(badPk, operator, 0);

        vm.expectRevert(AntseedDeposits.InvalidSignature.selector);
        deposits.setOperator(buyer, operator, 0, sig);
    }

    function testFuzz_setOperator_wrongNonceRejected(uint256 nonce) public {
        nonce = bound(nonce, 1, type(uint256).max); // current nonce is 0
        bytes memory sig = _signSetOperator(BUYER_PK, operator, nonce);

        vm.expectRevert(AntseedDeposits.InvalidNonce.selector);
        deposits.setOperator(buyer, operator, nonce, sig);
    }

    function test_setOperator_wrongDomainRejected() public {
        // Sign the right struct against a foreign domain separator.
        bytes32 sh = keccak256(abi.encode(deposits.SET_OPERATOR_TYPEHASH(), operator, uint256(0)));
        bytes32 foreign = keccak256("not the deposits domain");
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", foreign, sh));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(BUYER_PK, digest);

        vm.expectRevert(AntseedDeposits.InvalidSignature.selector);
        deposits.setOperator(buyer, operator, 0, abi.encodePacked(r, s, v));
    }

    function test_setOperator_zeroAddressRejected() public {
        bytes memory sig = _signSetOperator(BUYER_PK, address(0), 0);
        vm.expectRevert(AntseedDeposits.InvalidAddress.selector);
        deposits.setOperator(buyer, address(0), 0, sig);

        vm.expectRevert(AntseedDeposits.InvalidAddress.selector);
        deposits.setOperator(address(0), operator, 0, sig);
    }

    // ── one-shot + replay ─────────────────────────────────────────────────────
    function test_setOperator_alreadySetRejected() public {
        deposits.setOperator(buyer, operator, 0, _signSetOperator(BUYER_PK, operator, 0));

        // A fresh, validly-signed set for nonce 1 is still blocked: setOperator is one-shot.
        bytes memory sig2 = _signSetOperator(BUYER_PK, address(0xCAFE), 1);
        vm.expectRevert(AntseedDeposits.OperatorAlreadySet.selector);
        deposits.setOperator(buyer, address(0xCAFE), 1, sig2);
    }

    function test_setOperator_replayRejected() public {
        bytes memory sig = _signSetOperator(BUYER_PK, operator, 0);
        deposits.setOperator(buyer, operator, 0, sig);

        // Replaying the exact same call hits the one-shot guard first.
        vm.expectRevert(AntseedDeposits.OperatorAlreadySet.selector);
        deposits.setOperator(buyer, operator, 0, sig);
    }

    // ── transferOperator ──────────────────────────────────────────────────────
    function _setInitialOperator() internal {
        deposits.setOperator(buyer, operator, 0, _signSetOperator(BUYER_PK, operator, 0));
    }

    function testFuzz_transferOperator_onlyCurrentOperator(address caller, address newOp) public {
        _setInitialOperator();
        vm.assume(caller != operator);

        vm.prank(caller);
        vm.expectRevert(AntseedDeposits.NotAuthorized.selector);
        deposits.transferOperator(buyer, newOp);
    }

    function testFuzz_transferOperator_succeedsByOperator(address newOp) public {
        vm.assume(newOp != address(0));
        _setInitialOperator();

        vm.prank(operator);
        deposits.transferOperator(buyer, newOp);
        assertEq(deposits.getOperator(buyer), newOp);
    }

    /// @notice CHARACTERIZATION (audit lead): transferOperator has no zero-address guard, unlike
    ///         setOperator. The current operator can brick the buyer by zeroing the operator.
    ///         This test pins the current behavior so a future fix flips it to a revert.
    function test_transferOperator_currentlyAllowsZeroAddress_KNOWN_GAP() public {
        _setInitialOperator();

        vm.prank(operator);
        deposits.transferOperator(buyer, address(0)); // does NOT revert today
        assertEq(deposits.getOperator(buyer), address(0));
    }
}
