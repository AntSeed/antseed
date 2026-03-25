// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function transfer(address to, uint256 value) external returns (bool);
}

interface IAntseedIdentityForStaking {
    function isRegistered(address addr) external view returns (bool);
    function getTokenId(address addr) external view returns (uint256);

    struct ProvenReputation {
        uint64 firstSignCount;
        uint64 qualifiedProvenSignCount;
        uint64 unqualifiedProvenSignCount;
        uint64 ghostCount;
        uint256 totalQualifiedTokenVolume;
        uint64 lastProvenAt;
    }
    function getReputation(uint256 tokenId) external view returns (ProvenReputation memory);
}

/**
 * @title AntseedStaking
 * @notice Seller staking, token rates, active session tracking, and slashing.
 *         Stable contract — holds seller stake USDC. Reads reputation from AntseedIdentity.
 */
contract AntseedStaking {
    // ─── State ───────────────────────────────────────────────────────────
    IERC20 public immutable usdc;
    IAntseedIdentityForStaking public identityContract;
    address public owner;
    address public sessionsContract;
    address public protocolReserve;
    bool private _locked;

    // ─── Structs ────────────────────────────────────────────────────────
    struct SellerAccount {
        uint256 stake;
        uint256 stakedAt;
        uint256 tokenRate;
    }

    // ─── Storage ────────────────────────────────────────────────────────
    mapping(address => SellerAccount) public sellers;
    mapping(address => uint256) public activeSessionCount;

    // ─── Configurable Constants ─────────────────────────────────────────
    uint256 public MIN_SELLER_STAKE = 10_000_000;
    uint256 public REPUTATION_CAP_COEFFICIENT = 20;
    uint256 public SLASH_RATIO_THRESHOLD = 30;
    uint256 public SLASH_GHOST_THRESHOLD = 5;
    uint256 public SLASH_INACTIVITY_DAYS = 30 days;

    // ─── Events ─────────────────────────────────────────────────────────
    event Staked(address indexed seller, uint256 amount);
    event Unstaked(address indexed seller, uint256 amount, uint256 slashed);
    event ConstantUpdated(bytes32 indexed key, uint256 value);

    // ─── Custom Errors ──────────────────────────────────────────────────
    error NotOwner();
    error NotAuthorized();
    error InvalidAmount();
    error InvalidAddress();
    error InsufficientStake();
    error NotRegistered();
    error ActiveSessions();
    error TransferFailed();
    error Reentrancy();

    // ─── Modifiers ──────────────────────────────────────────────────────
    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlySessions() {
        if (msg.sender != sessionsContract) revert NotAuthorized();
        _;
    }

    modifier nonReentrant() {
        if (_locked) revert Reentrancy();
        _locked = true;
        _;
        _locked = false;
    }

    // ─── Constructor ────────────────────────────────────────────────────
    constructor(address _usdc, address _identity) {
        if (_usdc == address(0) || _identity == address(0)) revert InvalidAddress();
        usdc = IERC20(_usdc);
        identityContract = IAntseedIdentityForStaking(_identity);
        owner = msg.sender;
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        SELLER OPERATIONS
    // ═══════════════════════════════════════════════════════════════════

    function stake(uint256 amount) external nonReentrant {
        if (amount == 0) revert InvalidAmount();
        if (!identityContract.isRegistered(msg.sender)) revert NotRegistered();

        _safeTransferFrom(msg.sender, address(this), amount);

        SellerAccount storage sa = sellers[msg.sender];
        sa.stake += amount;
        sa.stakedAt = block.timestamp;

        emit Staked(msg.sender, amount);
    }

    function setTokenRate(uint256 rate) external {
        if (rate == 0) revert InvalidAmount();
        SellerAccount storage sa = sellers[msg.sender];
        if (sa.stake == 0) revert InsufficientStake();
        sa.tokenRate = rate;
    }

    function unstake() external nonReentrant {
        SellerAccount storage sa = sellers[msg.sender];
        if (sa.stake == 0) revert InsufficientStake();
        if (activeSessionCount[msg.sender] > 0) revert ActiveSessions();

        uint256 slashAmount = _calculateSlash(msg.sender);
        uint256 payout = sa.stake - slashAmount;

        uint256 stakeAmount = sa.stake;
        sa.stake = 0;
        sa.stakedAt = 0;

        if (payout > 0) {
            _safeTransfer(msg.sender, payout);
        }
        if (slashAmount > 0 && protocolReserve != address(0)) {
            _safeTransfer(protocolReserve, slashAmount);
        }

        emit Unstaked(msg.sender, stakeAmount, slashAmount);
    }

    // ─── View Helpers ───────────────────────────────────────────────────
    function validateSeller(address seller) external view returns (uint256 tokenRate) {
        if (sellers[seller].stake < MIN_SELLER_STAKE) revert InsufficientStake();
        if (sellers[seller].tokenRate == 0) revert InvalidAmount();
        return sellers[seller].tokenRate;
    }

    function getStake(address seller) external view returns (uint256) {
        return sellers[seller].stake;
    }

    function getTokenRate(address seller) external view returns (uint256) {
        return sellers[seller].tokenRate;
    }

    function isStakedAboveMin(address seller) external view returns (bool) {
        return sellers[seller].stake >= MIN_SELLER_STAKE;
    }

    function getSellerAccount(address seller)
        external
        view
        returns (uint256 stakeAmt, uint256 stakedAt, uint256 tokenRate)
    {
        SellerAccount storage sa = sellers[seller];
        return (sa.stake, sa.stakedAt, sa.tokenRate);
    }

    function effectiveProvenSigns(address seller) external view returns (uint256) {
        uint256 sellerTokenId = identityContract.getTokenId(seller);
        IAntseedIdentityForStaking.ProvenReputation memory rep = identityContract.getReputation(sellerTokenId);

        uint256 qualifiedCount = uint256(rep.qualifiedProvenSignCount);
        uint256 stakeCap = (sellers[seller].stake * REPUTATION_CAP_COEFFICIENT) / 1_000_000;

        return qualifiedCount < stakeCap ? qualifiedCount : stakeCap;
    }

    // ─── Privileged — Sessions Only ─────────────────────────────────────
    function incrementActiveSessions(address seller) external onlySessions {
        activeSessionCount[seller]++;
    }

    function decrementActiveSessions(address seller) external onlySessions {
        if (activeSessionCount[seller] == 0) revert InvalidAmount();
        activeSessionCount[seller]--;
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        INTERNAL — SLASHING
    // ═══════════════════════════════════════════════════════════════════

    function _calculateSlash(address seller) internal view returns (uint256) {
        uint256 sellerTokenId = identityContract.getTokenId(seller);
        IAntseedIdentityForStaking.ProvenReputation memory rep = identityContract.getReputation(sellerTokenId);

        uint256 totalSigns = uint256(rep.qualifiedProvenSignCount) + uint256(rep.unqualifiedProvenSignCount);
        uint256 Q = uint256(rep.qualifiedProvenSignCount);
        uint256 stakeAmt = sellers[seller].stake;

        // Tier 1: no qualified proven signs but has total signs
        if (Q == 0 && totalSigns > 0) return stakeAmt;

        // Tier 2: has qualified but ratio below threshold
        if (Q > 0 && totalSigns > 0) {
            uint256 ratio = (Q * 100) / totalSigns;
            if (ratio < SLASH_RATIO_THRESHOLD) return stakeAmt / 2;
        }

        // Tier 3: too many ghosts and no qualified
        if (uint256(rep.ghostCount) >= SLASH_GHOST_THRESHOLD && Q == 0) return stakeAmt;

        // Tier 4: good ratio but inactive
        if (Q > 0 && totalSigns > 0) {
            uint256 ratio = (Q * 100) / totalSigns;
            if (ratio >= SLASH_RATIO_THRESHOLD && rep.lastProvenAt > 0) {
                if (block.timestamp > uint256(rep.lastProvenAt) + SLASH_INACTIVITY_DAYS) {
                    return stakeAmt / 5;
                }
            }
        }

        // Tier 5: no slash
        return 0;
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

    // ═══════════════════════════════════════════════════════════════════
    //                        ADMIN
    // ═══════════════════════════════════════════════════════════════════

    function setSessionsContract(address _sessions) external onlyOwner {
        if (_sessions == address(0)) revert InvalidAddress();
        sessionsContract = _sessions;
    }

    function setIdentityContract(address _identity) external onlyOwner {
        if (_identity == address(0)) revert InvalidAddress();
        identityContract = IAntseedIdentityForStaking(_identity);
    }

    function setProtocolReserve(address _reserve) external onlyOwner {
        if (_reserve == address(0)) revert InvalidAddress();
        protocolReserve = _reserve;
    }

    function setConstant(bytes32 key, uint256 value) external onlyOwner {
        if (key == keccak256("MIN_SELLER_STAKE")) MIN_SELLER_STAKE = value;
        else if (key == keccak256("REPUTATION_CAP_COEFFICIENT")) REPUTATION_CAP_COEFFICIENT = value;
        else if (key == keccak256("SLASH_RATIO_THRESHOLD")) SLASH_RATIO_THRESHOLD = value;
        else if (key == keccak256("SLASH_GHOST_THRESHOLD")) SLASH_GHOST_THRESHOLD = value;
        else if (key == keccak256("SLASH_INACTIVITY_DAYS")) {
            if (value < 1 days) revert InvalidAmount();
            SLASH_INACTIVITY_DAYS = value;
        }
        else revert InvalidAmount();

        emit ConstantUpdated(key, value);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert InvalidAddress();
        owner = newOwner;
    }
}
