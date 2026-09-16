// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { AntseedDepositRelay } from "./AntseedDepositRelay.sol";

interface IAntseedReferralBinder {
    function bindReferral(address buyer, address referrer, uint256 nonce, uint256 deadline, bytes calldata signature)
        external;
}

/**
 * @title AntseedReferralDepositRelay
 * @notice Adds an optional buyer-signed referral binding to the atomic,
 *         relayer-funded deposit sweep. The existing sweep fee compensates
 *         the seller for the complete transaction.
 */
contract AntseedReferralDepositRelay is AntseedDepositRelay {
    IAntseedReferralBinder public immutable referrals;

    constructor(address _usdc, address _deposits, uint256 _fee, address _referrals)
        AntseedDepositRelay(_usdc, _deposits, _fee)
    {
        if (_referrals == address(0)) revert InvalidAddress();
        referrals = IAntseedReferralBinder(_referrals);
    }

    function sweepDepositWithReferral(
        address from,
        uint256 amount,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 depositNonce,
        bytes calldata sig3009,
        address referrer,
        uint256 referralNonce,
        uint256 referralDeadline,
        bytes calldata referralSignature
    ) external nonReentrant {
        _sweepDeposit(from, amount, validAfter, validBefore, depositNonce, sig3009);
        referrals.bindReferral(from, referrer, referralNonce, referralDeadline, referralSignature);
    }
}
