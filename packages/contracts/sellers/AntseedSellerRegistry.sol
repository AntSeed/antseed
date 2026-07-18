// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable2Step.sol";

import { IERC8004Registry } from "../interfaces/IERC8004Registry.sol";
import { IAntseedSellerPools } from "../interfaces/IAntseedSellerPools.sol";
import { IAntseedRegistry } from "../interfaces/IAntseedRegistry.sol";
import { IAntseedStaking } from "../interfaces/IAntseedStaking.sol";

/**
 * @title AntseedSellerRegistry
 * @notice Seller identity and eligibility adapter for the seller-pool era.
 *
 *         AntseedChannels already reads registry.staking() for two things:
 *         seller eligibility via isStakedAboveMin() and agent stats via getAgentId().
 *         This contract preserves that interface while moving the economic stake
 *         signal to AntseedSellerPools.
 *
 *         Agent identity is stored locally for new sellers and falls back to the
 *         deprecated USDC staking contract for sellers that registered before
 *         the pool migration. Eligibility requires both an agent identity and an
 *         active seller pool with enough active ANTS stake in the current epoch.
 *
 *         Important behavior:
 *           - This contract is an adapter for existing channel checks. It does
 *             not custody stake and does not create seller pools.
 *           - `stakeFor` is deliberately unsupported here. ANTS staking must go
 *             through AntseedSellerPools.
 *           - Seller registration binds a seller address to an ERC-8004 agent
 *             id for routing and legacy compatibility. Economic pool ownership
 *             remains agent-id based in AntseedSellerPools.
 *           - If an agent changes hands, the new owner can register it and the
 *             old seller binding — local or legacy — is superseded.
 */
contract AntseedSellerRegistry is IAntseedStaking, Ownable2Step {
    // ─── External Contracts ──────────────────────────────────────────
    IAntseedRegistry public registry;
    IAntseedSellerPools public sellerPools;
    IAntseedStaking public legacyStaking;

    // ─── Eligibility Config ──────────────────────────────────────────
    uint256 public minSellerPoolStake = 1;

    /// @notice Migration switch: while true, sellers staked above min in the
    ///         legacy USDC staking contract stay channel-eligible even without
    ///         an active ANTS seller pool. Existing mainnet sellers cannot
    ///         acquire pool stake at cutover (ANTS transfers may be disabled
    ///         and new stake activates next epoch), so cutting registry.staking
    ///         to this adapter without the fallback would brick all new
    ///         channel creation. Disable once seller pools are seeded.
    bool public legacyStakeEligibilityEnabled = true;

    // ─── Seller-Agent Bindings ───────────────────────────────────────
    mapping(address => uint256) private _sellerAgentId;
    mapping(uint256 => address) public agentSeller;

    // ─── Events ──────────────────────────────────────────────────────
    event RegistrySet(address indexed registry);
    event SellerPoolsSet(address indexed sellerPools);
    event LegacyStakingSet(address indexed legacyStaking);
    event MinSellerPoolStakeSet(uint256 minSellerPoolStake);
    event LegacyStakeEligibilitySet(bool enabled);
    event SellerRegistered(address indexed seller, uint256 indexed agentId);

    // ─── Custom Errors ───────────────────────────────────────────────
    error InvalidAddress();
    error InvalidValue();
    error NotAgentOwner();
    error AgentIdMismatch();
    error AgentAlreadyBound();
    error UnsupportedStakeOperation();

    // ─── Constructor ─────────────────────────────────────────────────
    constructor(address _registry, address _sellerPools, address _legacyStaking) Ownable(msg.sender) {
        if (_registry == address(0) || _sellerPools == address(0)) revert InvalidAddress();
        registry = IAntseedRegistry(_registry);
        sellerPools = IAntseedSellerPools(_sellerPools);
        legacyStaking = IAntseedStaking(_legacyStaking);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        CORE — REGISTER SELLER
    // ═══════════════════════════════════════════════════════════════════

    function registerSeller(uint256 agentId) external {
        if (agentId == 0) revert InvalidValue();
        if (IERC8004Registry(registry.identityRegistry()).ownerOf(agentId) != msg.sender) revert NotAgentOwner();

        uint256 existingAgentId = _sellerAgentId[msg.sender];
        if (existingAgentId != 0 && existingAgentId != agentId) revert AgentIdMismatch();

        uint256 legacyAgentId = _legacyAgentId(msg.sender);
        if (legacyAgentId != 0 && legacyAgentId != agentId) revert AgentIdMismatch();

        address existingSeller = agentSeller[agentId];
        if (existingSeller != address(0) && existingSeller != msg.sender && _sellerAgentId[existingSeller] == agentId) {
            _sellerAgentId[existingSeller] = 0;
        }

        _sellerAgentId[msg.sender] = agentId;
        agentSeller[agentId] = msg.sender;
        emit SellerRegistered(msg.sender, agentId);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        VIEWS
    // ═══════════════════════════════════════════════════════════════════

    function getStake(address seller) public view returns (uint256) {
        return _stakeForAgent(getAgentId(seller));
    }

    function isStakedAboveMin(address seller) external view returns (bool) {
        uint256 agentId = getAgentId(seller);
        if (agentId == 0) return false;
        if (_stakeForAgent(agentId) >= minSellerPoolStake) return true;
        return _legacyStakedAboveMin(seller);
    }

    function _stakeForAgent(uint256 agentId) internal view returns (uint256) {
        IAntseedSellerPools pools = sellerPools;
        uint256 epoch = pools.currentEpoch();
        if (agentId == 0 || !pools.hasPoolAtEpoch(agentId, epoch)) return 0;
        return pools.poolActiveStakeAtEpoch(agentId, epoch);
    }

    function getAgentId(address seller) public view returns (uint256) {
        uint256 agentId = _sellerAgentId[seller];
        if (agentId != 0) return agentId;
        agentId = _legacyAgentId(seller);
        if (agentId == 0) return 0;
        // A local registration by another seller (e.g. the buyer of the agent)
        // supersedes the legacy binding. Without this, a seller who sold their
        // agent would keep the binding — and channel eligibility funded by the
        // new owner's pool stake — until they unstake from legacy staking.
        address localSeller = agentSeller[agentId];
        if (localSeller != address(0) && localSeller != seller) return 0;
        return agentId;
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        UNSUPPORTED LEGACY STAKE SURFACE
    // ═══════════════════════════════════════════════════════════════════

    function stakeFor(address, uint256, uint256) external pure {
        revert UnsupportedStakeOperation();
    }

    /// @dev Legacy USDC stake stays in the legacy staking contract and is
    ///      msg.sender-attributed there, so it cannot be forwarded from here.
    ///      To unstake a seller contract's legacy deposit, temporarily point
    ///      registry.staking back at the legacy contract.
    function unstake() external pure {
        revert UnsupportedStakeOperation();
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        ADMIN FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════

    function setRegistry(address _registry) external onlyOwner {
        if (_registry == address(0)) revert InvalidAddress();
        registry = IAntseedRegistry(_registry);
        emit RegistrySet(_registry);
    }

    function setSellerPools(address _sellerPools) external onlyOwner {
        if (_sellerPools == address(0)) revert InvalidAddress();
        sellerPools = IAntseedSellerPools(_sellerPools);
        emit SellerPoolsSet(_sellerPools);
    }

    function setLegacyStaking(address _legacyStaking) external onlyOwner {
        legacyStaking = IAntseedStaking(_legacyStaking);
        emit LegacyStakingSet(_legacyStaking);
    }

    function setMinSellerPoolStake(uint256 value) external onlyOwner {
        minSellerPoolStake = value;
        emit MinSellerPoolStakeSet(value);
    }

    function setLegacyStakeEligibilityEnabled(bool enabled) external onlyOwner {
        legacyStakeEligibilityEnabled = enabled;
        emit LegacyStakeEligibilitySet(enabled);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        INTERNAL HELPERS
    // ═══════════════════════════════════════════════════════════════════

    function _legacyStakedAboveMin(address seller) internal view returns (bool) {
        if (!legacyStakeEligibilityEnabled) return false;
        IAntseedStaking legacy = legacyStaking;
        if (address(legacy) == address(0)) return false;

        try legacy.isStakedAboveMin(seller) returns (bool staked) {
            return staked;
        } catch {
            return false;
        }
    }

    function _legacyAgentId(address seller) internal view returns (uint256) {
        IAntseedStaking legacy = legacyStaking;
        if (address(legacy) == address(0)) return 0;
        return legacy.getAgentId(seller);
    }
}
