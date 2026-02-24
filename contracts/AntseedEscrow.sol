// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function transfer(address to, uint256 value) external returns (bool);
}

/**
 * @title AntseedEscrow
 * @notice Session-scoped USDC escrow used by Antseed payment channels.
 * @dev State mapping matches node/src/payments/crypto/escrow.ts STATE_MAP:
 *      0=open, 1=active, 2=disputed, 3=settled, 4=closed.
 */
contract AntseedEscrow {
    enum ChannelState {
        Open,
        Active,
        Disputed,
        Settled,
        Closed
    }

    struct Channel {
        address buyer;
        address seller;
        uint256 amount;
        ChannelState state;
        uint64 createdAt;
        uint64 disputedAt;
    }

    IERC20 public immutable usdc;
    address public owner;
    address public arbiter;
    address public feeCollector;
    uint64 public disputeTimeout;

    mapping(bytes32 => Channel) private channels;

    bool private locked;

    event ChannelDeposited(bytes32 indexed sessionId, address indexed buyer, address indexed seller, uint256 amount);
    event ChannelReleased(bytes32 indexed sessionId, address indexed seller, uint256 amount, address caller);
    event ChannelSettled(
        bytes32 indexed sessionId,
        address indexed seller,
        uint256 sellerAmount,
        address indexed feeCollector,
        uint256 platformAmount,
        address buyer,
        uint256 buyerRefund,
        address caller
    );
    event ChannelRefunded(bytes32 indexed sessionId, address indexed buyer, uint256 amount, address caller);
    event ChannelDisputed(bytes32 indexed sessionId, address indexed caller);
    event ArbiterUpdated(address indexed previousArbiter, address indexed newArbiter);
    event FeeCollectorUpdated(address indexed previousFeeCollector, address indexed newFeeCollector);
    event DisputeTimeoutUpdated(uint64 previousTimeout, uint64 newTimeout);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error InvalidAddress();
    error InvalidSession();
    error InvalidAmount();
    error SessionExists();
    error InvalidState();
    error NotAuthorized();
    error NotOwner();
    error NotArbiter();
    error InvalidSplit();
    error DisputeTimeoutNotReached();
    error Reentrancy();
    error TransferFailed();

    modifier nonReentrant() {
        if (locked) revert Reentrancy();
        locked = true;
        _;
        locked = false;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address usdcToken, address initialArbiter) {
        if (usdcToken == address(0)) revert InvalidAddress();
        usdc = IERC20(usdcToken);
        owner = msg.sender;
        arbiter = initialArbiter == address(0) ? msg.sender : initialArbiter;
        feeCollector = msg.sender;
        disputeTimeout = 72 hours;
    }

    function setArbiter(address newArbiter) external onlyOwner {
        if (newArbiter == address(0)) revert InvalidAddress();
        emit ArbiterUpdated(arbiter, newArbiter);
        arbiter = newArbiter;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert InvalidAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function setFeeCollector(address newFeeCollector) external onlyOwner {
        if (newFeeCollector == address(0)) revert InvalidAddress();
        emit FeeCollectorUpdated(feeCollector, newFeeCollector);
        feeCollector = newFeeCollector;
    }

    function setDisputeTimeout(uint64 newTimeout) external onlyOwner {
        if (newTimeout == 0) revert InvalidAmount();
        emit DisputeTimeoutUpdated(disputeTimeout, newTimeout);
        disputeTimeout = newTimeout;
    }

    /**
     * @notice Lock buyer funds for a session.
     * @param sessionId keccak256(sessionIdString) from ethers.id(sessionId)
     * @param seller seller wallet address
     * @param amount USDC amount in token base units (6 decimals)
     */
    function deposit(bytes32 sessionId, address seller, uint256 amount) external nonReentrant {
        if (sessionId == bytes32(0)) revert InvalidSession();
        if (seller == address(0)) revert InvalidAddress();
        if (amount == 0) revert InvalidAmount();

        Channel storage channel = channels[sessionId];
        if (channel.buyer != address(0)) revert SessionExists();

        channel.buyer = msg.sender;
        channel.seller = seller;
        channel.amount = amount;
        channel.state = ChannelState.Active;
        channel.createdAt = uint64(block.timestamp);
        channel.disputedAt = 0;

        _safeTransferFrom(msg.sender, address(this), amount);
        emit ChannelDeposited(sessionId, msg.sender, seller, amount);
    }

    /**
     * @notice Release escrow to seller.
     * @dev Active channel: buyer/seller/arbiter can release.
     *      Disputed channel: only arbiter can release.
     */
    function release(bytes32 sessionId) external nonReentrant {
        Channel storage channel = channels[sessionId];
        if (channel.state != ChannelState.Active && channel.state != ChannelState.Disputed) {
            revert InvalidState();
        }
        _authorizeForSettlement(channel);

        uint256 amount = channel.amount;
        channel.amount = 0;
        channel.state = ChannelState.Settled;
        channel.disputedAt = 0;

        _safeTransfer(channel.seller, amount);
        emit ChannelReleased(sessionId, channel.seller, amount, msg.sender);
    }

    /**
     * @notice Settle escrow by splitting funds between seller, platform fee collector, and buyer refund.
     * @dev Active channel: buyer/seller/arbiter can settle.
     *      Disputed channel: only arbiter can settle.
     */
    function settle(bytes32 sessionId, uint256 sellerAmount, uint256 platformAmount) external nonReentrant {
        Channel storage channel = channels[sessionId];
        if (channel.state != ChannelState.Active && channel.state != ChannelState.Disputed) {
            revert InvalidState();
        }
        _authorizeForSettlement(channel);

        uint256 amount = channel.amount;
        if (sellerAmount > amount || platformAmount > amount - sellerAmount) {
            revert InvalidSplit();
        }
        uint256 buyerRefund = amount - sellerAmount - platformAmount;

        channel.amount = 0;
        channel.state = ChannelState.Settled;
        channel.disputedAt = 0;

        if (sellerAmount > 0) {
            _safeTransfer(channel.seller, sellerAmount);
        }
        if (platformAmount > 0) {
            _safeTransfer(feeCollector, platformAmount);
        }
        if (buyerRefund > 0) {
            _safeTransfer(channel.buyer, buyerRefund);
        }

        emit ChannelSettled(
            sessionId,
            channel.seller,
            sellerAmount,
            feeCollector,
            platformAmount,
            channel.buyer,
            buyerRefund,
            msg.sender
        );
    }

    /**
     * @notice Mark an active channel as disputed.
     */
    function dispute(bytes32 sessionId) external {
        Channel storage channel = channels[sessionId];
        if (channel.state != ChannelState.Active) revert InvalidState();
        if (msg.sender != channel.buyer && msg.sender != channel.seller && msg.sender != arbiter) {
            revert NotAuthorized();
        }

        channel.state = ChannelState.Disputed;
        channel.disputedAt = uint64(block.timestamp);
        emit ChannelDisputed(sessionId, msg.sender);
    }

    /**
     * @notice Refund escrow to buyer.
     * @dev Active channel: buyer/arbiter can refund.
     *      Disputed channel: only arbiter can refund.
     */
    function refund(bytes32 sessionId) external nonReentrant {
        Channel storage channel = channels[sessionId];
        if (channel.state != ChannelState.Active && channel.state != ChannelState.Disputed) {
            revert InvalidState();
        }

        if (channel.state == ChannelState.Active) {
            if (msg.sender != channel.buyer && msg.sender != arbiter) {
                revert NotAuthorized();
            }
        } else if (msg.sender != arbiter) {
            revert NotArbiter();
        }

        uint256 amount = channel.amount;
        channel.amount = 0;
        channel.state = ChannelState.Closed;
        channel.disputedAt = 0;

        _safeTransfer(channel.buyer, amount);
        emit ChannelRefunded(sessionId, channel.buyer, amount, msg.sender);
    }

    /**
     * @notice Resolve stale disputes by refunding the buyer after the dispute timeout.
     */
    function resolveDisputeTimeout(bytes32 sessionId) external nonReentrant {
        Channel storage channel = channels[sessionId];
        if (channel.state != ChannelState.Disputed) revert InvalidState();
        if (uint64(block.timestamp) < channel.disputedAt + disputeTimeout) {
            revert DisputeTimeoutNotReached();
        }

        uint256 amount = channel.amount;
        channel.amount = 0;
        channel.state = ChannelState.Closed;
        channel.disputedAt = 0;

        _safeTransfer(channel.buyer, amount);
        emit ChannelRefunded(sessionId, channel.buyer, amount, msg.sender);
    }

    function getChannel(bytes32 sessionId)
        external
        view
        returns (address buyer, address seller, uint256 amount, uint8 state)
    {
        Channel storage channel = channels[sessionId];
        return (channel.buyer, channel.seller, channel.amount, uint8(channel.state));
    }

    function _safeTransferFrom(address from, address to, uint256 value) private {
        (bool ok, bytes memory ret) = address(usdc).call(
            abi.encodeWithSelector(IERC20.transferFrom.selector, from, to, value)
        );
        if (!ok || (ret.length > 0 && !abi.decode(ret, (bool)))) {
            revert TransferFailed();
        }
    }

    function _safeTransfer(address to, uint256 value) private {
        (bool ok, bytes memory ret) = address(usdc).call(
            abi.encodeWithSelector(IERC20.transfer.selector, to, value)
        );
        if (!ok || (ret.length > 0 && !abi.decode(ret, (bool)))) {
            revert TransferFailed();
        }
    }

    function _authorizeForSettlement(Channel storage channel) private view {
        if (channel.state == ChannelState.Active) {
            if (msg.sender != channel.buyer && msg.sender != channel.seller && msg.sender != arbiter) {
                revert NotAuthorized();
            }
            return;
        }
        if (msg.sender != arbiter) {
            revert NotArbiter();
        }
    }
}
