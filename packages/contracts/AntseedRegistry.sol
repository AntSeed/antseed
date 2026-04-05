// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import {IAntseedRegistry} from "./interfaces/IAntseedRegistry.sol";

/**
 * @title AntseedRegistry
 * @notice Central address book for all AntSeed protocol contracts.
 *         Each protocol contract stores only a pointer to this registry
 *         and looks up sibling addresses on demand.
 */
contract AntseedRegistry is IAntseedRegistry, Ownable {

    address public override channels;
    address public override deposits;
    address public override staking;
    address public override emissions;
    address public override antsToken;
    address public override identityRegistry;
    address public override protocolReserve;
    address public override teamWallet;

    error InvalidAddress();
    event AddressUpdated(string indexed key, address indexed newAddress);

    constructor() Ownable(msg.sender) {}

    function setChannels(address _channels) external onlyOwner {
        if (_channels == address(0)) revert InvalidAddress();
        channels = _channels;
        emit AddressUpdated("channels", _channels);
    }

    function setDeposits(address _deposits) external onlyOwner {
        if (_deposits == address(0)) revert InvalidAddress();
        deposits = _deposits;
        emit AddressUpdated("deposits", _deposits);
    }

    function setStaking(address _staking) external onlyOwner {
        if (_staking == address(0)) revert InvalidAddress();
        staking = _staking;
        emit AddressUpdated("staking", _staking);
    }

    function setEmissions(address _emissions) external onlyOwner {
        if (_emissions == address(0)) revert InvalidAddress();
        emissions = _emissions;
        emit AddressUpdated("emissions", _emissions);
    }

    function setAntsToken(address _antsToken) external onlyOwner {
        if (_antsToken == address(0)) revert InvalidAddress();
        antsToken = _antsToken;
        emit AddressUpdated("antsToken", _antsToken);
    }

    function setIdentityRegistry(address _identityRegistry) external onlyOwner {
        if (_identityRegistry == address(0)) revert InvalidAddress();
        identityRegistry = _identityRegistry;
        emit AddressUpdated("identityRegistry", _identityRegistry);
    }

    function setProtocolReserve(address _protocolReserve) external onlyOwner {
        if (_protocolReserve == address(0)) revert InvalidAddress();
        protocolReserve = _protocolReserve;
        emit AddressUpdated("protocolReserve", _protocolReserve);
    }

    function setTeamWallet(address _teamWallet) external onlyOwner {
        if (_teamWallet == address(0)) revert InvalidAddress();
        teamWallet = _teamWallet;
        emit AddressUpdated("teamWallet", _teamWallet);
    }
}
