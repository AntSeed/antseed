// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

import { AntseedDeposits } from "../payments/AntseedDeposits.sol";
import { AntseedReferralDepositRelay } from "../payments/AntseedReferralDepositRelay.sol";
import { MockUSDC } from "./mocks/MockUSDC.sol";

contract ReferralBinderMock {
    address public buyer;
    address public referrer;

    function bindReferral(address value, address referralWallet, uint256, uint256, bytes calldata) external {
        buyer = value;
        referrer = referralWallet;
    }
}

contract AntseedReferralDepositRelayTest is Test {
    uint256 private constant BUYER_PK = 0xA11CE;
    uint256 private constant FEE = 50_000;

    address private buyer;
    address private referrer = address(0xA11CE);
    address private seller = address(0xBEEF);
    MockUSDC private usdc;
    AntseedDeposits private deposits;
    ReferralBinderMock private referrals;
    AntseedReferralDepositRelay private relay;

    function setUp() public {
        buyer = vm.addr(BUYER_PK);
        usdc = new MockUSDC();
        deposits = new AntseedDeposits(address(usdc));
        referrals = new ReferralBinderMock();
        relay = new AntseedReferralDepositRelay(address(usdc), address(deposits), FEE, address(referrals));
        usdc.mint(buyer, 10_000_000);
        vm.warp(1_700_000_000);
    }

    function test_sweepAndReferralBindingAreAtomic() public {
        uint256 amount = 2_000_000;
        uint256 validAfter = block.timestamp - 60;
        uint256 validBefore = block.timestamp + 3600;
        bytes32 nonce = bytes32(uint256(1));
        bytes memory sig3009 = _sign3009(amount, validAfter, validBefore, nonce);

        vm.prank(seller);
        relay.sweepDepositWithReferral(
            buyer, amount, validAfter, validBefore, nonce, sig3009, referrer, 0, block.timestamp + 1 hours, hex"1234"
        );

        (uint256 available,,) = deposits.getBuyerBalance(buyer);
        assertEq(available, amount - FEE);
        assertEq(usdc.balanceOf(seller), FEE);
        assertEq(referrals.buyer(), buyer);
        assertEq(referrals.referrer(), referrer);
    }

    function _sign3009(uint256 amount, uint256 validAfter, uint256 validBefore, bytes32 nonce)
        private
        view
        returns (bytes memory)
    {
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                usdc.DOMAIN_SEPARATOR(),
                keccak256(
                    abi.encode(
                        usdc.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(),
                        buyer,
                        address(relay),
                        amount,
                        validAfter,
                        validBefore,
                        nonce
                    )
                )
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(BUYER_PK, digest);
        return abi.encodePacked(r, s, v);
    }
}
