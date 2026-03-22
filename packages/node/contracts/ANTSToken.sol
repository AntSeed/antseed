// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract ANTSToken is ERC20 {
    address public owner;
    address public emissionsContract;
    bool public emissionsContractSet;
    bool public transfersEnabled;       // Phase 1: false. One-way toggle to true.

    error NotOwner();
    error NotEmissionsContract();
    error EmissionsAlreadySet();
    error InvalidAddress();
    error TransfersNotEnabled();
    error TransfersAlreadyEnabled();

    event EmissionsContractSet(address indexed emissionsContract);
    event TransfersEnabled();
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor() ERC20("AntSeed", "ANTS") {
        owner = msg.sender;
        transfersEnabled = false;   // Phase 1: non-transferable
    }

    /// @notice Set the emissions contract address. Can only be called once.
    function setEmissionsContract(address _emissionsContract) external onlyOwner {
        if (_emissionsContract == address(0)) revert InvalidAddress();
        if (emissionsContractSet) revert EmissionsAlreadySet();
        emissionsContract = _emissionsContract;
        emissionsContractSet = true;
        emit EmissionsContractSet(_emissionsContract);
    }

    /// @notice Mint ANTS tokens. Restricted to emissions contract.
    function mint(address to, uint256 amount) external {
        if (msg.sender != emissionsContract) revert NotEmissionsContract();
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

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert InvalidAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }
}
