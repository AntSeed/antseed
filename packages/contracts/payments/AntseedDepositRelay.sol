// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IAntseedDeposits} from "../interfaces/IAntseedDeposits.sol";
import {IERC3009} from "../interfaces/IERC3009.sol";

/**
 * @title AntseedDepositRelay
 * @notice Gasless USDC sweep from a buyer hot wallet into AntseedDeposits,
 *         paid for in USDC by the buyer and executed by permissionless
 *         relayers. Stateless periphery — holds no funds between transactions
 *         (swappable tier, like AntseedChannels), fully immutable: no owner,
 *         no tunable parameters.
 *
 *         Single-signature design: the buyer's EIP-3009 authorization is
 *         addressed to this contract (`to = relay`), which IS the consent to
 *         its public, immutable terms — the fixed FEE. No second signature,
 *         and no governance that could change the fee after a user signed.
 *
 *         Flow (atomic — any failure reverts and funds never leave the buyer):
 *           1. Pull `amount` USDC from the buyer via EIP-3009
 *              receiveWithAuthorization (only this contract can redeem the
 *              authorization; the 3009 nonce is replay-safe).
 *           2. Credit `amount - FEE` to the BUYER's AntseedDeposits balance —
 *              never a token transfer to the buyer address (iron rule: the
 *              buyer hot wallet never receives funds).
 *           3. Pay `FEE` to msg.sender (the relayer's compensation).
 *
 *         Front-running is harmless by design: a front-runner can only execute
 *         the identical sweep and claim the fee; the buyer outcome is
 *         unchanged.
 */
contract AntseedDepositRelay is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─── State ───────────────────────────────────────────────────────
    IERC20 public immutable usdc;
    IAntseedDeposits public immutable deposits;

    /// @notice Fixed relayer fee in USDC base units. Immutable — a signed
    ///         authorization can never face different terms than it consented to.
    uint256 public immutable FEE;

    // ─── Events ──────────────────────────────────────────────────────
    event SweepExecuted(
        address indexed buyer,
        address indexed relayer,
        uint256 deposited,
        uint256 fee,
        bytes32 authNonce
    );

    // ─── Custom Errors ───────────────────────────────────────────────
    error InvalidAddress();
    error FeeExceedsAmount();
    error NetBelowMinDeposit();
    error NetExceedsCreditLimit();

    // ─── Constructor ─────────────────────────────────────────────────
    constructor(address _usdc, address _deposits, uint256 _fee) {
        if (_usdc == address(0) || _deposits == address(0)) revert InvalidAddress();
        usdc = IERC20(_usdc);
        deposits = IAntseedDeposits(_deposits);
        FEE = _fee;
    }

    // ═══════════════════════════════════════════════════════════════════
    //                              SWEEP
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Sweep `amount` USDC from `from` into their AntseedDeposits
     *         balance, paying the fixed FEE to msg.sender. Anyone can call —
     *         authorization comes from the buyer's EIP-3009 signature, which
     *         is addressed to this contract and thereby consents to FEE.
     * @param from        Buyer hot wallet the USDC is pulled from and credited to.
     * @param amount      Total USDC pulled via EIP-3009 (FEE is taken from this).
     * @param validAfter  EIP-3009 window start (exclusive).
     * @param validBefore EIP-3009 window end (exclusive).
     * @param nonce       EIP-3009 authorization nonce.
     * @param sig3009     Buyer signature over the ReceiveWithAuthorization typed data.
     */
    function sweepDeposit(
        address from,
        uint256 amount,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata sig3009
    ) external nonReentrant {
        if (amount <= FEE) revert FeeExceedsAmount();
        uint256 net = amount - FEE;

        // Mirror the Deposits guards so relayers simulating the call get clear
        // errors: MIN_BUYER_DEPOSIT applies only to a buyer's first deposit,
        // and the credited balance may never exceed the buyer's credit limit.
        (uint256 available, uint256 reserved, ) = deposits.getBuyerBalance(from);
        uint256 balance = available + reserved;
        if (balance == 0 && net < deposits.MIN_BUYER_DEPOSIT()) {
            revert NetBelowMinDeposit();
        }
        if (balance + net > deposits.getBuyerCreditLimit(from)) {
            revert NetExceedsCreditLimit();
        }

        // Interactions (trusted contracts only: USDC + Deposits).
        IERC3009(address(usdc)).receiveWithAuthorization(
            from, address(this), amount, validAfter, validBefore, nonce, sig3009
        );

        usdc.forceApprove(address(deposits), net);
        deposits.deposit(from, net);

        if (FEE > 0) {
            usdc.safeTransfer(msg.sender, FEE);
        }

        emit SweepExecuted(from, msg.sender, net, FEE, nonce);
    }
}
