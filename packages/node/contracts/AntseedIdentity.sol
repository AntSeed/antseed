// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

interface IAntseedStakingForIdentity {
    function getStake(address seller) external view returns (uint256);
}

/**
 * @title AntseedIdentity
 * @notice Peer identity NFTs with reputation and feedback (ERC-8004).
 *         Stable contract. Staking lives in AntseedStaking, sessions in AntseedSessions.
 */
contract AntseedIdentity is ERC721, ERC721URIStorage, Ownable {
    // ─── Core State ─────────────────────────────────────────────────────
    address public sessionsContract;
    address public stakingContract;
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
    error NotAuthorized();
    error InvalidAddress();
    error InvalidToken();
    error NonTransferable();
    error AlreadyRegistered();
    error PeerIdTaken();
    error NotTokenOwner();
    error ActiveStake();
    error InvalidIndex();
    error AlreadyRevoked();
    error InvalidAmount();

    // ─── Events ─────────────────────────────────────────────────────────
    event PeerRegistered(uint256 indexed tokenId, address indexed peer, bytes32 indexed peerId);
    event PeerDeregistered(uint256 indexed tokenId, address indexed peer);
    event SessionsContractSet(address indexed sessionsContract);
    event StakingContractSet(address indexed stakingContract);
    event FeedbackGiven(uint256 indexed agentId, address indexed client, int128 value, bytes32 indexed tag);
    event FeedbackRevoked(uint256 indexed agentId, address indexed client, uint256 index);

    // ─── Constructor ────────────────────────────────────────────────────
    constructor() ERC721("AntseedIdentity", "ANTID") Ownable(msg.sender) {
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
        if (stakingContract != address(0)) {
            uint256 stake = IAntseedStakingForIdentity(stakingContract).getStake(msg.sender);
            if (stake > 0) revert ActiveStake();
        }

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
    //                        ADMIN
    // ═══════════════════════════════════════════════════════════════════

    function setSessionsContract(address _sessions) external onlyOwner {
        if (_sessions == address(0)) revert InvalidAddress();
        sessionsContract = _sessions;
        emit SessionsContractSet(_sessions);
    }

    function setStakingContract(address _staking) external onlyOwner {
        if (_staking == address(0)) revert InvalidAddress();
        stakingContract = _staking;
        emit StakingContractSet(_staking);
    }

}
