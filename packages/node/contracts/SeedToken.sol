// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title  AntsToken
 * @notice ERC-20 reputation/reward token for the Antseed network.
 *
 * @dev ANTS is minted exclusively by the AntseedEscrow contract as a reward for
 *      proven service delivery. It is non-transferable by default (soulbound)
 *      to prevent gaming. The owner can grant transfer privileges to specific
 *      addresses (e.g. staking contracts, governance) in the future.
 *
 *      Supply is uncapped but minting is rate-limited by on-chain charge volume.
 */
contract AntsToken {

    // ── Errors ────────────────────────────────────────────────────────────────

    error NotMinter();
    error NotOwner();
    error ZeroAddress();
    error TransferNotAllowed();

    // ── ERC-20 metadata ───────────────────────────────────────────────────────

    string  public constant name     = "Antseed";
    string  public constant symbol   = "ANTS";
    uint8   public constant decimals = 18;

    // ── State ─────────────────────────────────────────────────────────────────

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    address public owner;
    mapping(address => bool) public isMinter;
    mapping(address => bool) public canTransfer;

    // ── Events ────────────────────────────────────────────────────────────────

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event MinterUpdated(address indexed minter, bool allowed);
    event TransferPrivilegeUpdated(address indexed addr, bool allowed);
    event OwnershipTransferred(address indexed prev, address indexed next);

    // ── Modifiers ─────────────────────────────────────────────────────────────

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyMinter() {
        if (!isMinter[msg.sender]) revert NotMinter();
        _;
    }

    // ── Constructor ───────────────────────────────────────────────────────────

    constructor() {
        owner = msg.sender;
    }

    // ── Owner admin ───────────────────────────────────────────────────────────

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function setMinter(address minter, bool allowed) external onlyOwner {
        if (minter == address(0)) revert ZeroAddress();
        isMinter[minter] = allowed;
        emit MinterUpdated(minter, allowed);
    }

    function setTransferPrivilege(address addr, bool allowed) external onlyOwner {
        if (addr == address(0)) revert ZeroAddress();
        canTransfer[addr] = allowed;
        emit TransferPrivilegeUpdated(addr, allowed);
    }

    // ── Minting ───────────────────────────────────────────────────────────────

    function mint(address to, uint256 amount) external onlyMinter {
        if (to == address(0)) revert ZeroAddress();
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    // ── ERC-20 core ───────────────────────────────────────────────────────────

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _requireTransferAllowed(msg.sender);
        return _transfer(msg.sender, to, amount);
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        _requireTransferAllowed(from);
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            allowance[from][msg.sender] = allowed - amount;
        }
        return _transfer(from, to, amount);
    }

    // ── Internal ──────────────────────────────────────────────────────────────

    function _transfer(address from, address to, uint256 amount) private returns (bool) {
        if (to == address(0)) revert ZeroAddress();
        balanceOf[from] -= amount;
        balanceOf[to]   += amount;
        emit Transfer(from, to, amount);
        return true;
    }

    function _requireTransferAllowed(address from) private view {
        if (!canTransfer[from]) revert TransferNotAllowed();
    }
}
