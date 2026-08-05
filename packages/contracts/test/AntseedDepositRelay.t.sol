// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

import {AntseedDepositRelay} from "../payments/AntseedDepositRelay.sol";
import {AntseedDeposits} from "../payments/AntseedDeposits.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

contract AntseedDepositRelayTest is Test {
    uint256 constant BUYER_PK = 0xA11CE;
    uint256 constant RANDOM_PK = 0xDEAD;

    address buyer;
    address relayer = address(0xBEEF);
    address frontRunner = address(0xF00D);

    MockUSDC usdc;
    AntseedDeposits deposits;
    AntseedDepositRelay relay;

    uint256 constant MIN_DEPOSIT = 1_000_000; // Deposits default
    uint256 constant FEE = 50_000; // deploy-time fixed fee ($0.05)

    function setUp() public {
        buyer = vm.addr(BUYER_PK);

        usdc = new MockUSDC();
        deposits = new AntseedDeposits(address(usdc));
        relay = new AntseedDepositRelay(address(usdc), address(deposits), FEE);

        usdc.mint(buyer, 100_000_000); // 100 USDC in the hot wallet
        vm.warp(1_700_000_000);
    }

    // ─── Helpers ─────────────────────────────────────────────────────

    function _sign3009(
        uint256 pk,
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce
    ) internal view returns (bytes memory) {
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                usdc.DOMAIN_SEPARATOR(),
                keccak256(
                    abi.encode(
                        usdc.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(), from, to, value, validAfter, validBefore, nonce
                    )
                )
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    /// @dev Signs the authorization with default validity window and submits as `submitter`.
    function _sweep(address submitter, uint256 amount, bytes32 nonce) internal {
        uint256 validAfter = block.timestamp - 60;
        uint256 validBefore = block.timestamp + 3600;
        bytes memory sig3009 = _sign3009(BUYER_PK, buyer, address(relay), amount, validAfter, validBefore, nonce);
        vm.prank(submitter);
        relay.sweepDeposit(buyer, amount, validAfter, validBefore, nonce, sig3009);
    }

    function _buyerDepositBalance() internal view returns (uint256) {
        (uint256 available,,) = deposits.getBuyerBalance(buyer);
        return available;
    }

    // ─── Happy path ──────────────────────────────────────────────────

    function test_sweep_happyPath_exactFixedFeeAccounting() public {
        uint256 amount = 5_000_000; // 5 USDC

        vm.expectEmit(true, true, false, true, address(relay));
        emit AntseedDepositRelay.SweepExecuted(buyer, relayer, amount - FEE, FEE, bytes32(uint256(1)));
        _sweep(relayer, amount, bytes32(uint256(1)));

        assertEq(_buyerDepositBalance(), amount - FEE, "buyer credited exactly amount - FEE");
        assertEq(usdc.balanceOf(relayer), FEE, "relayer got exactly FEE");
        assertEq(usdc.balanceOf(buyer), 100_000_000 - amount, "hot wallet debited");
        assertEq(usdc.balanceOf(address(relay)), 0, "relay holds nothing");
        assertEq(usdc.allowance(address(relay), address(deposits)), 0, "allowance fully consumed");
    }

    function test_sweep_feeIsImmutablePublicTerm() public view {
        assertEq(relay.FEE(), FEE);
    }

    function test_sweep_zeroFeeDeployment() public {
        AntseedDepositRelay freeRelay = new AntseedDepositRelay(address(usdc), address(deposits), 0);
        uint256 amount = 5_000_000;
        uint256 validAfter = block.timestamp - 60;
        uint256 validBefore = block.timestamp + 3600;
        bytes memory sig3009 =
            _sign3009(BUYER_PK, buyer, address(freeRelay), amount, validAfter, validBefore, bytes32(uint256(2)));

        vm.prank(relayer);
        freeRelay.sweepDeposit(buyer, amount, validAfter, validBefore, bytes32(uint256(2)), sig3009);

        assertEq(_buyerDepositBalance(), amount, "full amount credited");
        assertEq(usdc.balanceOf(relayer), 0, "no fee transferred");
    }

    function test_sweep_frontRunnerGetsFee_buyerOutcomeUnchanged() public {
        // Whoever submits first wins the fee; the buyer is credited identically.
        _sweep(frontRunner, 5_000_000, bytes32(uint256(4)));

        assertEq(usdc.balanceOf(frontRunner), FEE);
        assertEq(usdc.balanceOf(relayer), 0);
        assertEq(_buyerDepositBalance(), 5_000_000 - FEE);
    }

    function test_sweep_topUpBelowMinWithExistingBalance() public {
        _sweep(relayer, 5_000_000, bytes32(uint256(5)));

        // 0.5 USDC top-up is fine once the buyer has a balance.
        _sweep(relayer, 500_000, bytes32(uint256(6)));

        assertEq(_buyerDepositBalance(), 5_000_000 - FEE + 500_000 - FEE);
    }

    // ─── Reverts ─────────────────────────────────────────────────────

    function test_sweep_revertsWhenExpired() public {
        bytes32 nonce = bytes32(uint256(7));
        uint256 validAfter = block.timestamp - 3600;
        uint256 validBefore = block.timestamp; // now >= validBefore
        bytes memory sig3009 =
            _sign3009(BUYER_PK, buyer, address(relay), 5_000_000, validAfter, validBefore, nonce);

        vm.prank(relayer);
        vm.expectRevert(MockUSDC.AuthorizationExpired.selector);
        relay.sweepDeposit(buyer, 5_000_000, validAfter, validBefore, nonce, sig3009);
    }

    function test_sweep_revertsWhenNotYetValid() public {
        bytes32 nonce = bytes32(uint256(8));
        uint256 validAfter = block.timestamp + 600;
        uint256 validBefore = block.timestamp + 3600;
        bytes memory sig3009 =
            _sign3009(BUYER_PK, buyer, address(relay), 5_000_000, validAfter, validBefore, nonce);

        vm.prank(relayer);
        vm.expectRevert(MockUSDC.AuthorizationNotYetValid.selector);
        relay.sweepDeposit(buyer, 5_000_000, validAfter, validBefore, nonce, sig3009);
    }

    function test_sweep_revertsOnReplayedNonce() public {
        _sweep(relayer, 5_000_000, bytes32(uint256(9)));

        uint256 validAfter = block.timestamp - 60;
        uint256 validBefore = block.timestamp + 3600;
        bytes memory sig3009 = _sign3009(
            BUYER_PK, buyer, address(relay), 5_000_000, validAfter, validBefore, bytes32(uint256(9))
        );

        vm.prank(relayer);
        vm.expectRevert(MockUSDC.AuthorizationAlreadyUsed.selector);
        relay.sweepDeposit(buyer, 5_000_000, validAfter, validBefore, bytes32(uint256(9)), sig3009);
    }

    function test_sweep_revertsOnWrong3009Signer() public {
        bytes32 nonce = bytes32(uint256(10));
        uint256 validAfter = block.timestamp - 60;
        uint256 validBefore = block.timestamp + 3600;
        bytes memory sig3009 =
            _sign3009(RANDOM_PK, buyer, address(relay), 5_000_000, validAfter, validBefore, nonce);

        vm.prank(relayer);
        vm.expectRevert(MockUSDC.InvalidAuthorizationSignature.selector);
        relay.sweepDeposit(buyer, 5_000_000, validAfter, validBefore, nonce, sig3009);
    }

    function test_sweep_revertsWhenAmountNotAboveFee() public {
        // amount == FEE and amount < FEE both revert
        for (uint256 amount = FEE - 1; amount <= FEE; amount++) {
            bytes32 nonce = bytes32(uint256(1000) + amount);
            uint256 validAfter = block.timestamp - 60;
            uint256 validBefore = block.timestamp + 3600;
            bytes memory sig3009 =
                _sign3009(BUYER_PK, buyer, address(relay), amount, validAfter, validBefore, nonce);

            vm.prank(relayer);
            vm.expectRevert(AntseedDepositRelay.FeeExceedsAmount.selector);
            relay.sweepDeposit(buyer, amount, validAfter, validBefore, nonce, sig3009);
        }
    }

    function test_sweep_revertsOnFirstDepositBelowMin() public {
        // net = 1_000_000 - FEE < MIN_BUYER_DEPOSIT for a first-time buyer
        bytes32 nonce = bytes32(uint256(14));
        uint256 validAfter = block.timestamp - 60;
        uint256 validBefore = block.timestamp + 3600;
        bytes memory sig3009 =
            _sign3009(BUYER_PK, buyer, address(relay), 1_000_000, validAfter, validBefore, nonce);

        vm.prank(relayer);
        vm.expectRevert(AntseedDepositRelay.NetBelowMinDeposit.selector);
        relay.sweepDeposit(buyer, 1_000_000, validAfter, validBefore, nonce, sig3009);

        assertEq(usdc.balanceOf(buyer), 100_000_000, "funds never left the buyer");
    }

    function test_sweep_firstDepositExactlyAtMinSucceeds() public {
        // net == MIN_BUYER_DEPOSIT exactly
        _sweep(relayer, MIN_DEPOSIT + FEE, bytes32(uint256(15)));
        assertEq(_buyerDepositBalance(), MIN_DEPOSIT);
    }

    function test_sweep_revertsWhenNetExceedsCreditLimit() public {
        // Default credit limit is 10 USDC; a 20 USDC sweep must revert whole
        // with the relay's own mirror error (clear for simulating relayers).
        bytes32 nonce = bytes32(uint256(16));
        uint256 validAfter = block.timestamp - 60;
        uint256 validBefore = block.timestamp + 3600;
        bytes memory sig3009 =
            _sign3009(BUYER_PK, buyer, address(relay), 20_000_000, validAfter, validBefore, nonce);

        vm.prank(relayer);
        vm.expectRevert(AntseedDepositRelay.NetExceedsCreditLimit.selector);
        relay.sweepDeposit(buyer, 20_000_000, validAfter, validBefore, nonce, sig3009);

        assertEq(usdc.balanceOf(buyer), 100_000_000, "funds never left the buyer");
        assertEq(_buyerDepositBalance(), 0);
    }

    function test_sweep_netExactlyAtCreditLimitSucceeds() public {
        // Deposits allows balance + amount == limit; the relay must mirror
        // the same boundary (> reverts, == succeeds).
        uint256 limit = deposits.getBuyerCreditLimit(buyer);
        _sweep(relayer, limit + FEE, bytes32(uint256(17)));
        assertEq(_buyerDepositBalance(), limit);
    }

    function test_sweep_topUpRespectsExistingBalanceInLimitCheck() public {
        // Fill to the limit, then any further top-up must revert.
        uint256 limit = deposits.getBuyerCreditLimit(buyer);
        _sweep(relayer, limit + FEE, bytes32(uint256(18)));

        bytes32 nonce = bytes32(uint256(19));
        uint256 validAfter = block.timestamp - 60;
        uint256 validBefore = block.timestamp + 3600;
        bytes memory sig3009 =
            _sign3009(BUYER_PK, buyer, address(relay), 500_000, validAfter, validBefore, nonce);

        vm.prank(relayer);
        vm.expectRevert(AntseedDepositRelay.NetExceedsCreditLimit.selector);
        relay.sweepDeposit(buyer, 500_000, validAfter, validBefore, nonce, sig3009);
    }

    function test_constructor_rejectsZeroAddresses() public {
        vm.expectRevert(AntseedDepositRelay.InvalidAddress.selector);
        new AntseedDepositRelay(address(0), address(deposits), FEE);
        vm.expectRevert(AntseedDepositRelay.InvalidAddress.selector);
        new AntseedDepositRelay(address(usdc), address(0), FEE);
    }

    // ─── Fuzz ────────────────────────────────────────────────────────

    function testFuzz_sweep_conservation(uint256 amount, bytes32 nonce) public {
        amount = bound(amount, MIN_DEPOSIT + FEE, 10_000_000); // net >= MIN, within credit limit
        vm.assume(nonce != bytes32(0));

        _sweep(relayer, amount, nonce);

        assertEq(_buyerDepositBalance(), amount - FEE);
        assertEq(usdc.balanceOf(relayer), FEE);
        assertEq(usdc.balanceOf(address(relay)), 0, "relay never retains funds");
        assertEq(usdc.balanceOf(buyer) + amount, 100_000_000);
    }
}
