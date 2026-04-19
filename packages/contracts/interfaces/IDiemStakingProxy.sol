// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IDiemStakingProxy {
    function operator() external view returns (address);
    function isValidDelegation(
        address peerAddress,
        address sellerContract,
        uint256 chainId,
        uint256 expiresAt,
        bytes calldata signature
    ) external view returns (bool);
    function earned(address account) external view returns (uint256 usdcEarned, uint256 antsEarned);
}
