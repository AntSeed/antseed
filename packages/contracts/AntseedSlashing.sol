// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";

import {IAntseedSlashing} from "./interfaces/IAntseedSlashing.sol";
import {IAntseedRegistry} from "./interfaces/IAntseedRegistry.sol";
import {IAntseedChannels} from "./interfaces/IAntseedChannels.sol";
import {IAntseedStaking} from "./interfaces/IAntseedStaking.sol";

/**
 * @title AntseedSlashing
 * @notice Swappable slashing logic for seller staking.
 *         Staking delegates slash calculation here. Deploy a new version
 *         and point Staking to it to change slashing rules without
 *         touching the contract that holds funds.
 */
contract AntseedSlashing is IAntseedSlashing, Ownable {
    IAntseedRegistry public registry;

    uint256 public SLASH_RATIO_THRESHOLD = 30;
    uint256 public SLASH_GHOST_THRESHOLD = 5;

    error InvalidAddress();

    constructor(address _registry) Ownable(msg.sender) {
        if (_registry == address(0)) revert InvalidAddress();
        registry = IAntseedRegistry(_registry);
    }

    function calculateSlash(address seller, uint256 stakeAmount) external view override returns (uint256) {
        uint256 agentId = IAntseedStaking(registry.staking()).getAgentId(seller);
        if (agentId == 0) return 0;

        IAntseedChannels.AgentStats memory stats = IAntseedChannels(registry.channels()).getAgentStats(agentId);

        uint256 channels = uint256(stats.channelCount);
        uint256 ghosts = uint256(stats.ghostCount);

        // Tier 1: ghosts >= threshold AND zero channels → full slash
        if (ghosts >= SLASH_GHOST_THRESHOLD && channels == 0) return stakeAmount;

        // Tier 2: channels > 0 but ghost ratio high → half slash
        if (channels > 0 && ghosts > 0) {
            uint256 ghostRatio = (ghosts * 100) / (channels + ghosts);
            if (ghostRatio >= SLASH_RATIO_THRESHOLD) return stakeAmount / 2;
        }

        // Tier 3: no slash
        return 0;
    }

    // ─── Admin ──────────────────────────────────────────────────────────

    function setRegistry(address _registry) external onlyOwner {
        if (_registry == address(0)) revert InvalidAddress();
        registry = IAntseedRegistry(_registry);
    }

    function setSlashRatioThreshold(uint256 value) external onlyOwner {
        SLASH_RATIO_THRESHOLD = value;
    }

    function setSlashGhostThreshold(uint256 value) external onlyOwner {
        SLASH_GHOST_THRESHOLD = value;
    }
}
