// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

import {IAntseedRegistry} from "./interfaces/IAntseedRegistry.sol";

contract ANTSToken is ERC20, Ownable {
    uint256 public constant MAX_SUPPLY = 1_040_000_000e18; // 1.04B ANTS

    IAntseedRegistry public registry;
    bool public transfersEnabled;       // Phase 1: false. One-way toggle to true.
    mapping(address => bool) public transferWhitelist;

    error NotEmissionsContract();
    error InvalidAddress();
    error TransfersNotEnabled();
    error TransfersAlreadyEnabled();
    error MaxSupplyExceeded();

    event TransfersEnabled();
    event WhitelistUpdated(address indexed account, bool allowed);

    constructor() ERC20("AntSeed", "ANTS") Ownable(msg.sender) {
        transfersEnabled = false;   // Phase 1: non-transferable
    }

    function setRegistry(address _registry) external onlyOwner {
        if (_registry == address(0)) revert InvalidAddress();
        registry = IAntseedRegistry(_registry);
    }

    /// @notice Mint ANTS tokens. Restricted to emissions contract.
    function mint(address to, uint256 amount) external {
        if (msg.sender != registry.emissions()) revert NotEmissionsContract();
        if (to == address(0)) revert InvalidAddress();
        if (totalSupply() + amount > MAX_SUPPLY) revert MaxSupplyExceeded();
        _mint(to, amount);
    }

    /// @notice Enable transfers permanently. One-way toggle — cannot be reversed.
    function enableTransfers() external onlyOwner {
        if (transfersEnabled) revert TransfersAlreadyEnabled();
        transfersEnabled = true;
        emit TransfersEnabled();
    }

    /// @notice Allow an address to transfer before transfers are globally enabled.
    ///         Used for adding liquidity, seeding pools, etc.
    function setTransferWhitelist(address account, bool allowed) external onlyOwner {
        if (account == address(0)) revert InvalidAddress();
        transferWhitelist[account] = allowed;
        emit WhitelistUpdated(account, allowed);
    }

    /// @notice Override _update to block transfers when not enabled.
    /// Minting (from == address(0)), whitelisted senders, and post-enablement transfers are allowed.
    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && !transfersEnabled && !transferWhitelist[from]) {
            revert TransfersNotEnabled();
        }
        super._update(from, to, value);
    }
}
