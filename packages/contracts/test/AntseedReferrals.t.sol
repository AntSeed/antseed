// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import { AntseedReferrals } from "../rewards/AntseedReferrals.sol";

contract ReferralToken is ERC20 {
    constructor() ERC20("ANTS", "ANTS") { }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract ReferralUsageAccountingMock {
    uint256 public currentEpoch = 10;
    mapping(address => uint256) public usage;

    function setCurrentEpoch(uint256 epoch) external {
        currentEpoch = epoch;
    }

    function setUsage(address buyer, uint256 points) external {
        usage[buyer] = points;
    }

    function buyerUsageTotal(address buyer) external view returns (uint256 points, uint256 weightedPoints) {
        points = usage[buyer];
        weightedPoints = points;
    }
}

contract ReferralUsageRewardsMock {
    mapping(address => mapping(uint256 => uint256)) public rewards;

    function setReward(address buyer, uint256 epoch, uint256 amount) external {
        rewards[buyer][epoch] = amount;
    }

    function pendingBuyerReward(address buyer, uint256 epoch) external view returns (uint256) {
        return rewards[buyer][epoch];
    }
}

contract ReferralDepositsMock {
    mapping(address => address) public operator;

    function setOperator(address buyer, address value) external {
        operator[buyer] = value;
    }

    function getOperator(address buyer) external view returns (address) {
        return operator[buyer];
    }
}

contract AntseedReferralsTest is Test {
    uint256 private constant BUYER_PK = 0xB0B;
    address private buyer;
    address private referrer = address(0xA11CE);
    address private submitter = address(0xBEEF);

    ReferralToken private ants;
    ReferralUsageAccountingMock private accounting;
    ReferralUsageRewardsMock private rewards;
    ReferralDepositsMock private deposits;
    AntseedReferrals private referrals;

    function setUp() public {
        buyer = vm.addr(BUYER_PK);
        ants = new ReferralToken();
        accounting = new ReferralUsageAccountingMock();
        rewards = new ReferralUsageRewardsMock();
        deposits = new ReferralDepositsMock();
        referrals = new AntseedReferrals(address(ants), address(accounting), address(rewards), address(deposits));
    }

    function test_bindAndAccrueTwoPercentOfBuyerRewards() public {
        _bind(referrer);
        rewards.setReward(buyer, 10, 100 ether);
        rewards.setReward(buyer, 11, 25 ether);
        accounting.setCurrentEpoch(12);

        ants.mint(address(this), 10 ether);
        ants.approve(address(referrals), 10 ether);
        referrals.fund(10 ether);
        referrals.accrue(buyer, 11);

        assertEq(referrals.claimable(referrer), 2.5 ether);
        assertEq(referrals.nextAccrualEpoch(buyer), 12);

        vm.prank(referrer);
        referrals.claim();
        assertEq(ants.balanceOf(referrer), 2.5 ether);
        assertEq(referrals.totalClaimable(), 0);
    }

    function test_anyRelayerCanSubmitBuyerAuthorization() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory signature = _signature(referrer, 0, deadline);

        vm.prank(submitter);
        referrals.bindReferral(buyer, referrer, 0, deadline, signature);
        assertEq(referrals.referrerOf(buyer), referrer);
        assertEq(referrals.nonces(buyer), 1);
    }

    function test_bindRejectsUsageAndSelfReferral() public {
        accounting.setUsage(buyer, 1);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory signature = _signature(referrer, 0, deadline);
        vm.expectRevert(AntseedReferrals.ReferralMustPrecedeUsage.selector);
        referrals.bindReferral(buyer, referrer, 0, deadline, signature);

        address operator = address(0x1234);
        accounting.setUsage(buyer, 0);
        deposits.setOperator(buyer, operator);
        signature = _signature(operator, 0, deadline);
        vm.expectRevert(AntseedReferrals.SelfReferral.selector);
        referrals.bindReferral(buyer, operator, 0, deadline, signature);
    }

    function test_accrualDoesNotAdvanceWhenUnderfunded() public {
        _bind(referrer);
        rewards.setReward(buyer, 10, 100 ether);
        accounting.setCurrentEpoch(11);

        vm.expectRevert(AntseedReferrals.InsufficientFunding.selector);
        referrals.accrue(buyer, 10);
        assertEq(referrals.nextAccrualEpoch(buyer), 10);
    }

    function _bind(address referralWallet) private {
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory signature = _signature(referralWallet, 0, deadline);
        vm.prank(submitter);
        referrals.bindReferral(buyer, referralWallet, 0, deadline, signature);
    }

    function _signature(address referralWallet, uint256 nonce, uint256 deadline) private view returns (bytes memory) {
        bytes32 structHash =
            keccak256(abi.encode(referrals.BIND_REFERRAL_TYPEHASH(), buyer, referralWallet, nonce, deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", referrals.domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(BUYER_PK, digest);
        return abi.encodePacked(r, s, v);
    }
}
