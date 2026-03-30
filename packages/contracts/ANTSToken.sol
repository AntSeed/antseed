// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

import {IAntseedRegistry} from "./interfaces/IAntseedRegistry.sol";

contract ANTSToken is ERC20, Ownable {
    IAntseedRegistry public registry;
    bool public transfersEnabled;       // Phase 1: false. One-way toggle to true.

    error NotEmissionsContract();
    error InvalidAddress();
    error TransfersNotEnabled();
    error TransfersAlreadyEnabled();

    event TransfersEnabled();

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
        _mint(to, amount);
    }

    /// @notice Enable transfers permanently. One-way toggle — cannot be reversed.
    function enableTransfers() external onlyOwner {
        if (transfersEnabled) revert TransfersAlreadyEnabled();
        transfersEnabled = true;
        emit TransfersEnabled();
    }

    /// @notice Override _update to block transfers when not enabled.
    /// Minting (from == address(0)) is always allowed.
    function _update(address from, address to, uint256 value) internal override {
        // Allow minting (from emissions contract) regardless of transfer state
        if (from != address(0) && !transfersEnabled) revert TransfersNotEnabled();
        super._update(from, to, value);
    }
}
