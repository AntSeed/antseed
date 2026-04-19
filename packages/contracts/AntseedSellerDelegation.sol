// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IAntseedRegistry} from "./interfaces/IAntseedRegistry.sol";
import {IAntseedChannels} from "./interfaces/IAntseedChannels.sol";

/**
 * @title AntseedSellerDelegation
 * @notice Base contract for any seller façade that fronts an AntseedChannels
 *         channel on behalf of a pool / aggregator / multi-peer service.
 *
 *         Provides:
 *           - Multi-operator authorization (`isOperator`). Operators drive
 *             channel lifecycle actions on the contract's behalf. Buyers
 *             resolve the peer→sellerContract binding by calling
 *             `isOperator(peerAddress)` with no signature dance.
 *           - A byte-identical `reserve` / `topUp` / `settle` / `close`
 *             surface that forwards to `registry.channels()`. Channels is
 *             swappable at the registry level; derived contracts don't pin
 *             a specific channels address.
 *
 *         Derived contracts override the four lifecycle functions and wrap
 *         `super.X(...)` with any local bookkeeping (e.g. USDC inflow capture,
 *         reward streams, pool accounting).
 */
abstract contract AntseedSellerDelegation is Ownable, ReentrancyGuard {
    /// @notice Central AntSeed address book. Resolves channels / deposits / etc.
    IAntseedRegistry public immutable registry;

    /// @notice Authorized operators for this contract.
    mapping(address => bool) public isOperator;

    event OperatorSet(address indexed operator, bool enabled);

    error InvalidAddress();
    error NotOperator();

    modifier onlyOperator() {
        if (!isOperator[msg.sender]) revert NotOperator();
        _;
    }

    /// @param _registry AntSeed address book.
    /// @param initialOperator First authorized operator. Must be non-zero.
    constructor(address _registry, address initialOperator) Ownable(msg.sender) {
        if (_registry == address(0)) revert InvalidAddress();
        if (initialOperator == address(0)) revert InvalidAddress();
        registry = IAntseedRegistry(_registry);
        isOperator[initialOperator] = true;
        emit OperatorSet(initialOperator, true);
    }

    /// @notice Add or remove an operator.
    function setOperator(address op, bool enabled) external onlyOwner {
        if (op == address(0)) revert InvalidAddress();
        isOperator[op] = enabled;
        emit OperatorSet(op, enabled);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        CHANNEL LIFECYCLE FAÇADE
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Forwarded `AntseedChannels.reserve`.
    function reserve(
        address buyer,
        bytes32 salt,
        uint128 maxAmount,
        uint256 deadline,
        bytes calldata buyerSig
    ) public virtual onlyOperator nonReentrant {
        _channels().reserve(buyer, salt, maxAmount, deadline, buyerSig);
    }

    /// @notice Forwarded `AntseedChannels.topUp`.
    function topUp(
        bytes32 channelId,
        uint128 cumulativeAmount,
        bytes calldata metadata,
        bytes calldata spendingSig,
        uint128 newMaxAmount,
        uint256 deadline,
        bytes calldata reserveSig
    ) public virtual onlyOperator nonReentrant {
        _channels().topUp(channelId, cumulativeAmount, metadata, spendingSig, newMaxAmount, deadline, reserveSig);
    }

    /// @notice Forwarded `AntseedChannels.settle`.
    function settle(
        bytes32 channelId,
        uint128 cumulativeAmount,
        bytes calldata metadata,
        bytes calldata buyerSig
    ) public virtual onlyOperator nonReentrant {
        _channels().settle(channelId, cumulativeAmount, metadata, buyerSig);
    }

    /// @notice Forwarded `AntseedChannels.close`.
    function close(
        bytes32 channelId,
        uint128 finalAmount,
        bytes calldata metadata,
        bytes calldata buyerSig
    ) public virtual onlyOperator nonReentrant {
        _channels().close(channelId, finalAmount, metadata, buyerSig);
    }

    /// @dev Resolve the current channels contract via the registry.
    function _channels() internal view returns (IAntseedChannels) {
        return IAntseedChannels(registry.channels());
    }

    /// @notice The underlying AntseedChannels contract. Client SDKs treat this
    ///         contract as the "channels address" for writes (so `onlyOperator`
    ///         and any derived-class logic applies), then call `channelsAddress`
    ///         at init to discover the real channels contract for reads + event
    ///         subscriptions. Reads are keyed on `address(this)` as the seller.
    function channelsAddress() external view returns (address) {
        return address(_channels());
    }
}
