// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IAntseedChannels } from "../interfaces/IAntseedChannels.sol";
import { IAntseedRegistry } from "../interfaces/IAntseedRegistry.sol";
import { IAntseedSellerClaimPolicy } from "../interfaces/IAntseedSellerClaimPolicy.sol";
import { IAntseedSellerUnlockPolicy } from "../interfaces/IAntseedSellerUnlockPolicy.sol";
import { IAntseedStaking } from "../interfaces/IAntseedStaking.sol";
import { IAntseedWashTradingRegistry } from "../interfaces/IAntseedWashTradingRegistry.sol";

contract AntseedSellerRewardEligibilityPolicy is IAntseedSellerClaimPolicy, IAntseedSellerUnlockPolicy {
    uint256 public constant INACTIVITY_PERIOD = 14 days;
    uint8 public constant REASON_P0 = 1;
    uint8 public constant REASON_NO_AGENT = 2;
    uint8 public constant REASON_NEVER_SETTLED = 4;
    uint8 public constant REASON_INACTIVE = 8;

    IAntseedRegistry public immutable registry;
    IAntseedWashTradingRegistry public immutable washTradingRegistry;
    uint64 public immutable snapshotBlockNumber;
    uint64 public immutable snapshotTimestamp;
    uint32 public immutable inactiveSellerCount;
    bytes32 public immutable inactiveSellerSnapshotHash;

    mapping(address seller => uint64 lastSettledAt) public inactiveLastSettledAt;

    error InvalidAddress();
    error InvalidInactiveSeller(address seller);

    constructor(address registry_, address washTradingRegistry_, address[] memory inactiveSellers_) {
        if (registry_ == address(0) || washTradingRegistry_ == address(0)) revert InvalidAddress();
        registry = IAntseedRegistry(registry_);
        washTradingRegistry = IAntseedWashTradingRegistry(washTradingRegistry_);
        snapshotBlockNumber = uint64(block.number);
        snapshotTimestamp = uint64(block.timestamp);
        inactiveSellerCount = uint32(inactiveSellers_.length);

        IAntseedStaking staking = IAntseedStaking(registry.staking());
        IAntseedChannels channels = IAntseedChannels(registry.channels());
        uint64[] memory settledAt = new uint64[](inactiveSellers_.length);
        address previous;
        for (uint256 index = 0; index < inactiveSellers_.length; index++) {
            address seller = inactiveSellers_[index];
            if (seller == address(0) || seller <= previous) revert InvalidInactiveSeller(seller);
            uint256 agentId = staking.getAgentId(seller);
            if (agentId == 0) revert InvalidInactiveSeller(seller);
            uint64 lastSettledAt = channels.getAgentStats(agentId).lastSettledAt;
            if (lastSettledAt == 0 || block.timestamp <= uint256(lastSettledAt) + INACTIVITY_PERIOD) {
                revert InvalidInactiveSeller(seller);
            }
            inactiveLastSettledAt[seller] = lastSettledAt;
            settledAt[index] = lastSettledAt;
            previous = seller;
        }
        inactiveSellerSnapshotHash = keccak256(abi.encode(inactiveSellers_, settledAt));
    }

    function claimableSellerRewards(address seller, uint256 lockedAmount) external view returns (uint256 amount) {
        (bool eligible,,) = eligibility(seller);
        return eligible ? lockedAmount : 0;
    }

    function canClaimSellerUnlocked(address seller) external view returns (bool) {
        (bool eligible,,) = eligibility(seller);
        return eligible;
    }

    function eligibility(address seller) public view returns (bool eligible, uint8 reasonMask, uint64 lastSettledAt) {
        if (washTradingRegistry.isSellerP0(seller)) return (false, REASON_P0, 0);

        lastSettledAt = inactiveLastSettledAt[seller];
        if (lastSettledAt != 0) return (false, REASON_INACTIVE, lastSettledAt);

        uint256 agentId = IAntseedStaking(registry.staking()).getAgentId(seller);
        if (agentId == 0) return (false, REASON_NO_AGENT, 0);

        lastSettledAt = IAntseedChannels(registry.channels()).getAgentStats(agentId).lastSettledAt;
        if (lastSettledAt == 0) return (false, REASON_NEVER_SETTLED, 0);
        return (true, 0, lastSettledAt);
    }
}
