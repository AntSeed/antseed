// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import { IAntseedRegistry } from "../interfaces/IAntseedRegistry.sol";
import { IAntseedSellerClaimPolicy } from "../interfaces/IAntseedSellerClaimPolicy.sol";

/**
 * @title AntseedSellerRewardsPool
 * @notice Custody pool for seller ANTS emissions that are earned but not yet
 *         immediately claimable. Emissions mints ANTS to this pool and records
 *         the per-seller locked balance here.
 *
 *         Sellers claim from their own locked balance subject to an optional
 *         seller claim policy. If no policy is configured, claims are blocked
 *         until a policy is introduced.
 */
contract AntseedSellerRewardsPool is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IAntseedRegistry public registry;
    IAntseedSellerClaimPolicy public sellerClaimPolicy;

    mapping(address => uint256) public lockedRewards;
    uint256 public totalLockedRewards;

    event LockedRewardRecorded(address indexed seller, uint256 amount);
    event SellerRewardsClaimed(address indexed seller, address indexed recipient, uint256 amount);
    event RegistrySet(address indexed registry);
    event SellerClaimPolicySet(address indexed policy);

    error InvalidAddress();
    error InvalidAmount();
    error NotEmissionsContract();
    error NoSellerClaimPolicy();
    error NothingToClaim();

    modifier onlyEmissions() {
        if (msg.sender != registry.emissions()) revert NotEmissionsContract();
        _;
    }

    constructor(address _registry) Ownable(msg.sender) {
        if (_registry == address(0)) revert InvalidAddress();
        registry = IAntseedRegistry(_registry);
    }

    function recordLockedReward(address seller, uint256 amount) external onlyEmissions {
        if (seller == address(0)) revert InvalidAddress();
        if (amount == 0) revert InvalidAmount();

        lockedRewards[seller] += amount;
        totalLockedRewards += amount;

        emit LockedRewardRecorded(seller, amount);
    }

    function claim(address recipient) external nonReentrant {
        if (recipient == address(0)) revert InvalidAddress();

        IAntseedSellerClaimPolicy policy = sellerClaimPolicy;
        if (address(policy) == address(0)) revert NoSellerClaimPolicy();

        uint256 locked = lockedRewards[msg.sender];
        uint256 amount = policy.claimableSellerRewards(msg.sender, locked);
        if (amount > locked) amount = locked;
        if (amount == 0) revert NothingToClaim();

        lockedRewards[msg.sender] = locked - amount;
        totalLockedRewards -= amount;

        IERC20(registry.antsToken()).safeTransfer(recipient, amount);

        emit SellerRewardsClaimed(msg.sender, recipient, amount);
    }

    function setSellerClaimPolicy(address policy) external onlyOwner {
        sellerClaimPolicy = IAntseedSellerClaimPolicy(policy);
        emit SellerClaimPolicySet(policy);
    }

    function setRegistry(address _registry) external onlyOwner {
        if (_registry == address(0)) revert InvalidAddress();
        registry = IAntseedRegistry(_registry);
        emit RegistrySet(_registry);
    }
}
