// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import { ITempoStreamChannel } from "./ITempoStreamChannel.sol";

/**
 * @title TempoStreamChannel
 * @notice Unidirectional payment channel escrow for streaming payments.
 * @dev Adapted from Tempo's reference implementation to use OpenZeppelin (ERC-20/EIP-712)
 *      instead of solady/TIP-20. Deployed independently and wrapped by AntseedSessions.
 *
 *      Users deposit ERC-20 tokens, sign cumulative vouchers, and payees
 *      can settle or close at any time. Channels have no expiry — they are
 *      closed either cooperatively by the payee or after a grace period
 *      following the payer's close request.
 */
contract TempoStreamChannel is ITempoStreamChannel, EIP712 {
    using SafeERC20 for IERC20;

    // --- Constants ---

    bytes32 public constant VOUCHER_TYPEHASH =
        keccak256("Voucher(bytes32 channelId,uint128 cumulativeAmount)");

    uint64 public constant CLOSE_GRACE_PERIOD = 15 minutes;

    // --- State ---

    mapping(bytes32 => Channel) private _channels;

    // --- Constructor ---

    constructor() EIP712("Tempo Stream Channel", "1") {}

    // --- External Functions ---

    function open(
        address payee,
        address token,
        uint128 deposit,
        bytes32 salt,
        address authorizedSigner
    )
        external
        override
        returns (bytes32 channelId)
    {
        if (payee == address(0)) revert InvalidPayee();
        if (token == address(0)) revert InvalidToken();
        if (deposit == 0) revert ZeroDeposit();

        channelId = computeChannelId(msg.sender, payee, token, salt, authorizedSigner);

        if (_channels[channelId].payer != address(0) || _channels[channelId].finalized) {
            revert ChannelAlreadyExists();
        }

        _channels[channelId] = Channel({
            finalized: false,
            closeRequestedAt: 0,
            payer: msg.sender,
            payee: payee,
            token: token,
            authorizedSigner: authorizedSigner,
            deposit: deposit,
            settled: 0
        });

        IERC20(token).safeTransferFrom(msg.sender, address(this), deposit);

        emit ChannelOpened(channelId, msg.sender, payee, token, authorizedSigner, salt, deposit);
    }

    function settle(
        bytes32 channelId,
        uint128 cumulativeAmount,
        bytes calldata signature
    )
        external
        override
    {
        Channel storage channel = _channels[channelId];

        if (channel.finalized) revert ChannelFinalized();
        if (channel.payer == address(0)) revert ChannelNotFound();
        if (msg.sender != channel.payee) revert NotPayee();
        if (cumulativeAmount > channel.deposit) revert AmountExceedsDeposit();
        if (cumulativeAmount <= channel.settled) revert AmountNotIncreasing();

        _verifyVoucher(channelId, cumulativeAmount, signature, channel);

        uint128 delta = cumulativeAmount - channel.settled;
        channel.settled = cumulativeAmount;

        IERC20(channel.token).safeTransfer(channel.payee, delta);

        emit Settled(
            channelId, channel.payer, channel.payee, cumulativeAmount, delta, channel.settled
        );
    }

    function topUp(bytes32 channelId, uint256 additionalDeposit) external override {
        Channel storage channel = _channels[channelId];

        if (channel.finalized) revert ChannelFinalized();
        if (channel.payer == address(0)) revert ChannelNotFound();
        if (msg.sender != channel.payer) revert NotPayer();
        if (additionalDeposit == 0) revert ZeroDeposit();
        if (additionalDeposit > type(uint128).max - channel.deposit) revert DepositOverflow();

        channel.deposit += uint128(additionalDeposit);

        IERC20(channel.token).safeTransferFrom(msg.sender, address(this), additionalDeposit);

        if (channel.closeRequestedAt != 0) {
            channel.closeRequestedAt = 0;
            emit CloseRequestCancelled(channelId, channel.payer, channel.payee);
        }

        emit TopUp(channelId, channel.payer, channel.payee, additionalDeposit, channel.deposit);
    }

    function requestClose(bytes32 channelId) external override {
        Channel storage channel = _channels[channelId];

        if (channel.finalized) revert ChannelFinalized();
        if (channel.payer == address(0)) revert ChannelNotFound();
        if (msg.sender != channel.payer) revert NotPayer();

        if (channel.closeRequestedAt == 0) {
            channel.closeRequestedAt = uint64(block.timestamp);
            emit CloseRequested(
                channelId, channel.payer, channel.payee, block.timestamp + CLOSE_GRACE_PERIOD
            );
        }
    }

    function close(
        bytes32 channelId,
        uint128 cumulativeAmount,
        bytes calldata signature
    )
        external
        override
    {
        Channel storage channel = _channels[channelId];

        if (channel.finalized) revert ChannelFinalized();
        if (channel.payer == address(0)) revert ChannelNotFound();
        if (msg.sender != channel.payee) revert NotPayee();

        address token = channel.token;
        address payer = channel.payer;
        address payee = channel.payee;
        uint128 deposit = channel.deposit;

        uint128 settledAmount = channel.settled;
        uint128 delta = 0;

        if (cumulativeAmount > settledAmount) {
            if (cumulativeAmount > deposit) revert AmountExceedsDeposit();

            _verifyVoucher(channelId, cumulativeAmount, signature, channel);

            delta = cumulativeAmount - settledAmount;
            settledAmount = cumulativeAmount;
        }

        uint128 refund = deposit - settledAmount;
        _clearAndFinalize(channelId);

        if (delta > 0) {
            IERC20(token).safeTransfer(payee, delta);
        }

        if (refund > 0) {
            IERC20(token).safeTransfer(payer, refund);
        }

        emit ChannelClosed(channelId, payer, payee, settledAmount, refund);
    }

    function withdraw(bytes32 channelId) external override {
        Channel storage channel = _channels[channelId];

        if (channel.finalized) revert ChannelFinalized();
        if (channel.payer == address(0)) revert ChannelNotFound();
        if (msg.sender != channel.payer) revert NotPayer();

        address token = channel.token;
        address payer = channel.payer;
        address payee = channel.payee;
        uint128 deposit = channel.deposit;
        uint128 settledAmount = channel.settled;

        bool closeGracePassed = channel.closeRequestedAt != 0
            && block.timestamp >= channel.closeRequestedAt + CLOSE_GRACE_PERIOD;

        if (!closeGracePassed) revert CloseNotReady();

        uint128 refund = deposit - settledAmount;
        _clearAndFinalize(channelId);

        if (refund > 0) {
            IERC20(token).safeTransfer(payer, refund);
        }

        emit ChannelExpired(channelId, payer, payee);
        emit ChannelClosed(channelId, payer, payee, settledAmount, refund);
    }

    // --- View Functions ---

    function getChannel(bytes32 channelId) external view override returns (Channel memory) {
        return _channels[channelId];
    }

    function getChannelsBatch(bytes32[] calldata channelIds)
        external
        view
        override
        returns (Channel[] memory channelStates)
    {
        uint256 length = channelIds.length;
        channelStates = new Channel[](length);
        for (uint256 i = 0; i < length; ++i) {
            channelStates[i] = _channels[channelIds[i]];
        }
    }

    function computeChannelId(
        address payer,
        address payee,
        address token,
        bytes32 salt,
        address authorizedSigner
    )
        public
        view
        override
        returns (bytes32)
    {
        return keccak256(
            abi.encode(payer, payee, token, salt, authorizedSigner, address(this), block.chainid)
        );
    }

    function getVoucherDigest(
        bytes32 channelId,
        uint128 cumulativeAmount
    )
        external
        view
        override
        returns (bytes32)
    {
        bytes32 structHash = keccak256(abi.encode(VOUCHER_TYPEHASH, channelId, cumulativeAmount));
        return _hashTypedDataV4(structHash);
    }

    function domainSeparator() external view override returns (bytes32) {
        return _domainSeparatorV4();
    }

    // --- Internal Functions ---

    function _verifyVoucher(
        bytes32 channelId,
        uint128 cumulativeAmount,
        bytes calldata signature,
        Channel storage channel
    ) internal view {
        bytes32 structHash = keccak256(abi.encode(VOUCHER_TYPEHASH, channelId, cumulativeAmount));
        bytes32 digest = _hashTypedDataV4(structHash);
        address signer = ECDSA.recover(digest, signature);

        address expectedSigner =
            channel.authorizedSigner != address(0) ? channel.authorizedSigner : channel.payer;

        if (signer != expectedSigner) revert InvalidSignature();
    }

    function _clearAndFinalize(bytes32 channelId) internal {
        delete _channels[channelId];
        _channels[channelId].finalized = true;
    }
}
