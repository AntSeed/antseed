// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";

interface IERC20 {
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function transfer(address to, uint256 value) external returns (bool);
}

/**
 * @title AntseedIdentity
 * @notice Peer identity NFTs with reputation, feedback, and seller staking.
 *         Stable contract — holds seller stakes. Session logic lives in AntseedSessions (swappable).
 */
contract AntseedIdentity is ERC721, ERC721URIStorage {
    // ─── Core State ─────────────────────────────────────────────────────
    IERC20 public immutable usdc;
    address public owner;
    address public sessionsContract;
    address public protocolReserve;
    uint256 private _nextTokenId;

    // ─── Identity Mappings ──────────────────────────────────────────────
    mapping(address => uint256) public addressToTokenId;
    mapping(bytes32 => uint256) public peerIdToTokenId;
    mapping(uint256 => bytes32) public tokenIdToPeerId;
    mapping(address => bool) public registered;

    // ─── Reputation ─────────────────────────────────────────────────────
    struct ProvenReputation {
        uint64 firstSignCount;
        uint64 qualifiedProvenSignCount;
        uint64 unqualifiedProvenSignCount;
        uint64 ghostCount;
        uint256 totalQualifiedTokenVolume;
        uint64 lastProvenAt;
    }

    mapping(uint256 => ProvenReputation) private _reputation;

    struct ReputationUpdate {
        uint8 updateType;        // 0=firstSign, 1=qualifiedProven, 2=unqualifiedProven, 3=ghost
        uint256 tokenVolume;     // tokens delivered (for proven signs)
    }

    // ─── Seller Staking ─────────────────────────────────────────────────
    struct SellerAccount {
        uint256 stake;
        uint256 stakedAt;
        uint256 tokenRate;
    }

    mapping(address => SellerAccount) public sellers;
    mapping(address => uint256) public activeSessionCount;

    // Configurable slash constants
    uint256 public MIN_SELLER_STAKE = 10_000_000;
    uint256 public REPUTATION_CAP_COEFFICIENT = 20;
    uint256 public SLASH_RATIO_THRESHOLD = 30;
    uint256 public SLASH_GHOST_THRESHOLD = 5;
    uint256 public SLASH_INACTIVITY_DAYS = 30 days;

    // ─── ERC-8004 Feedback ──────────────────────────────────────────────
    mapping(uint256 => mapping(address => FeedbackEntry[])) private _feedback;
    mapping(uint256 => mapping(bytes32 => FeedbackSummary)) private _feedbackSummary;
    mapping(uint256 => address[]) private _feedbackClients;
    mapping(uint256 => mapping(address => bool)) private _isClient;

    struct FeedbackEntry {
        address client;
        int128 value;
        uint8 valueDecimals;
        bytes32 tag1;
        bytes32 tag2;
        uint64 timestamp;
        bool revoked;
    }

    struct FeedbackSummary {
        uint256 count;
        int256 summaryValue;
        uint8 summaryValueDecimals;
    }

    // ─── Errors ─────────────────────────────────────────────────────────
    error NotOwner();
    error NotAuthorized();
    error InvalidAddress();
    error InvalidToken();
    error NonTransferable();
    error AlreadyRegistered();
    error PeerIdTaken();
    error NotTokenOwner();
    error ActiveStake();
    error ActiveSessions();
    error InsufficientStake();
    error InvalidIndex();
    error AlreadyRevoked();
    error InvalidAmount();
    error NotRegistered();
    error TransferFailed();
    error Reentrancy();

    // ─── Events ─────────────────────────────────────────────────────────
    event PeerRegistered(uint256 indexed tokenId, address indexed peer, bytes32 indexed peerId);
    event PeerDeregistered(uint256 indexed tokenId, address indexed peer);
    event SessionsContractSet(address indexed sessionsContract);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event FeedbackGiven(uint256 indexed agentId, address indexed client, int128 value, bytes32 indexed tag);
    event FeedbackRevoked(uint256 indexed agentId, address indexed client, uint256 index);
    event Staked(address indexed seller, uint256 amount);
    event Unstaked(address indexed seller, uint256 amount, uint256 slashed);
    event ConstantUpdated(bytes32 indexed key, uint256 value);

    // ─── Modifiers ──────────────────────────────────────────────────────
    bool private _locked;

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
    constructor(address _usdc) ERC721("AntseedIdentity", "ANTID") {
        if (_usdc == address(0)) revert InvalidAddress();
        usdc = IERC20(_usdc);
        owner = msg.sender;
        _nextTokenId = 1;
    }

    function _update(address to, uint256 tokenId, address auth) internal override(ERC721) returns (address) {
        address from = _ownerOf(tokenId);
        if (from != address(0) && to != address(0)) revert NonTransferable();
        return super._update(to, tokenId, auth);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        REGISTRATION
    // ═══════════════════════════════════════════════════════════════════

    function register(bytes32 peerId, string calldata metadataURI) external returns (uint256) {
        if (registered[msg.sender]) revert AlreadyRegistered();
        if (peerId == bytes32(0)) revert InvalidAddress();
        if (peerIdToTokenId[peerId] != 0) revert PeerIdTaken();

        uint256 tokenId = _nextTokenId++;
        _safeMint(msg.sender, tokenId);
        _setTokenURI(tokenId, metadataURI);

        addressToTokenId[msg.sender] = tokenId;
        peerIdToTokenId[peerId] = tokenId;
        tokenIdToPeerId[tokenId] = peerId;
        registered[msg.sender] = true;

        emit PeerRegistered(tokenId, msg.sender, peerId);
        return tokenId;
    }

    function updateMetadata(uint256 tokenId, string calldata metadataURI) external {
        if (ownerOf(tokenId) != msg.sender) revert NotTokenOwner();
        _setTokenURI(tokenId, metadataURI);
    }

    function deregister(uint256 tokenId) external {
        if (ownerOf(tokenId) != msg.sender) revert NotTokenOwner();
        // Prevent reputation laundering: cannot deregister while staked
        if (sellers[msg.sender].stake > 0) revert ActiveStake();

        address peer = ownerOf(tokenId);
        bytes32 peerId = tokenIdToPeerId[tokenId];

        _burn(tokenId);

        delete addressToTokenId[peer];
        delete peerIdToTokenId[peerId];
        delete tokenIdToPeerId[tokenId];
        delete _reputation[tokenId];
        registered[peer] = false;

        emit PeerDeregistered(tokenId, peer);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        SELLER STAKING
    // ═══════════════════════════════════════════════════════════════════

    function stake(uint256 amount) external nonReentrant {
        if (amount == 0) revert InvalidAmount();
        if (!registered[msg.sender]) revert NotRegistered();

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

    // ─── Staking View Helpers (called by Sessions) ──────────────────────
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

    // ─── Privileged — Sessions Only ─────────────────────────────────────
    function incrementActiveSessions(address seller) external onlySessions {
        activeSessionCount[seller]++;
    }

    function decrementActiveSessions(address seller) external onlySessions {
        activeSessionCount[seller]--;
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        REPUTATION
    // ═══════════════════════════════════════════════════════════════════

    function updateReputation(uint256 tokenId, ReputationUpdate calldata update) external {
        if (msg.sender != sessionsContract) revert NotAuthorized();
        if (_ownerOf(tokenId) == address(0)) revert InvalidToken();

        ProvenReputation storage rep = _reputation[tokenId];
        if (update.updateType == 0) {
            rep.firstSignCount++;
        } else if (update.updateType == 1) {
            rep.qualifiedProvenSignCount++;
            rep.totalQualifiedTokenVolume += update.tokenVolume;
            rep.lastProvenAt = uint64(block.timestamp);
        } else if (update.updateType == 2) {
            rep.unqualifiedProvenSignCount++;
        } else if (update.updateType == 3) {
            rep.ghostCount++;
        }
    }

    function getReputation(uint256 tokenId) external view returns (ProvenReputation memory) {
        return _reputation[tokenId];
    }

    function effectiveProvenSigns(address seller) external view returns (uint256) {
        uint256 sellerTokenId = addressToTokenId[seller];
        ProvenReputation memory rep = _reputation[sellerTokenId];

        uint256 qualifiedCount = uint256(rep.qualifiedProvenSignCount);
        uint256 stakeCap = (sellers[seller].stake * REPUTATION_CAP_COEFFICIENT) / 1_000_000;

        return qualifiedCount < stakeCap ? qualifiedCount : stakeCap;
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        FEEDBACK (ERC-8004)
    // ═══════════════════════════════════════════════════════════════════

    function giveFeedback(
        uint256 agentId,
        int128 value,
        uint8 valueDecimals,
        bytes32 tag1,
        bytes32 tag2
    ) external {
        if (_ownerOf(agentId) == address(0)) revert InvalidToken();
        if (!registered[msg.sender]) revert NotAuthorized();
        if (ownerOf(agentId) == msg.sender) revert NotAuthorized();
        _feedback[agentId][msg.sender].push(FeedbackEntry({
            client: msg.sender,
            value: value,
            valueDecimals: valueDecimals,
            tag1: tag1,
            tag2: tag2,
            timestamp: uint64(block.timestamp),
            revoked: false
        }));
        FeedbackSummary storage summary = _feedbackSummary[agentId][tag1];
        if (summary.count == 0) {
            summary.summaryValueDecimals = valueDecimals;
        } else {
            if (valueDecimals != summary.summaryValueDecimals) revert InvalidAmount();
        }
        summary.count++;
        summary.summaryValue += int256(value);
        if (!_isClient[agentId][msg.sender]) {
            _feedbackClients[agentId].push(msg.sender);
            _isClient[agentId][msg.sender] = true;
        }
        emit FeedbackGiven(agentId, msg.sender, value, tag1);
    }

    function getSummary(uint256 agentId, bytes32 tag) external view
        returns (uint256 count, int256 summaryValue, uint8 summaryValueDecimals) {
        FeedbackSummary memory s = _feedbackSummary[agentId][tag];
        return (s.count, s.summaryValue, s.summaryValueDecimals);
    }

    function readFeedback(uint256 agentId, address client, uint256 index) external view
        returns (FeedbackEntry memory) {
        return _feedback[agentId][client][index];
    }

    function revokeFeedback(uint256 agentId, uint256 index) external {
        FeedbackEntry[] storage entries = _feedback[agentId][msg.sender];
        if (index >= entries.length) revert InvalidIndex();
        if (entries[index].revoked) revert AlreadyRevoked();
        entries[index].revoked = true;
        FeedbackSummary storage summary = _feedbackSummary[agentId][entries[index].tag1];
        summary.count--;
        summary.summaryValue -= int256(entries[index].value);
        emit FeedbackRevoked(agentId, msg.sender, index);
    }

    function getFeedbackCount(uint256 agentId, address client) external view returns (uint256) {
        return _feedback[agentId][client].length;
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        VIEW HELPERS
    // ═══════════════════════════════════════════════════════════════════

    function isRegistered(address addr) external view returns (bool) {
        return registered[addr];
    }

    function getTokenId(address addr) external view returns (uint256) {
        return addressToTokenId[addr];
    }

    function getTokenIdByPeerId(bytes32 peerId) external view returns (uint256) {
        return peerIdToTokenId[peerId];
    }

    function getPeerId(uint256 tokenId) external view returns (bytes32) {
        return tokenIdToPeerId[tokenId];
    }

    function tokenURI(uint256 tokenId) public view override(ERC721, ERC721URIStorage) returns (string memory) {
        return super.tokenURI(tokenId);
    }

    function supportsInterface(bytes4 interfaceId) public view override(ERC721, ERC721URIStorage) returns (bool) {
        return super.supportsInterface(interfaceId);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        INTERNAL — SLASHING
    // ═══════════════════════════════════════════════════════════════════

    function _calculateSlash(address seller) internal view returns (uint256) {
        uint256 sellerTokenId = addressToTokenId[seller];
        ProvenReputation memory rep = _reputation[sellerTokenId];

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
        emit SessionsContractSet(_sessions);
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

    function transferOwnership(address newOwner) external {
        if (msg.sender != owner) revert NotOwner();
        if (newOwner == address(0)) revert InvalidAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }
}
