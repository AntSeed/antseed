// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IAntseedLegacyVerifierRewards {
    function claimVerifierReward(uint256 epoch) external;
    function claimDelegateReward(uint256 epoch) external;
    function settleEpochRemainder(uint256 epoch) external returns (uint256 burnedAmount, uint256 reserveAmount);
    function pendingVerifierReward(uint256 epoch, address verifier) external view returns (uint256);
    function pendingDelegateReward(uint256 epoch, address delegate) external view returns (uint256);
    function epochRemainderSettled(uint256 epoch) external view returns (bool);
}
