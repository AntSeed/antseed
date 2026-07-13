// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IAntseedEmissionsGate } from "./IAntseedEmissionsGate.sol";
import { IAntseedVerifierRegistry } from "./IAntseedVerifierRegistry.sol";

interface IAntseedVerifierRewards {
    function gate() external view returns (IAntseedEmissionsGate);
    function verifierRegistry() external view returns (IAntseedVerifierRegistry);

    function claimVerifierReward(uint256 epoch) external;
    function claimDelegateReward(uint256 epoch) external;
    function settleEpochRemainder(uint256 epoch) external returns (uint256 burnedAmount, uint256 reserveAmount);

    function pendingVerifierReward(uint256 epoch, address verifier) external view returns (uint256);
    function pendingDelegateReward(uint256 epoch, address delegate) external view returns (uint256);
    function verifierEpochBudget(uint256 epoch) external view returns (uint256);
    function delegateEpochPool(uint256 epoch) external view returns (uint256);
    function verifierEpochTotalCredits(uint256 epoch) external view returns (uint256);
    function delegateEpochTotalCredits(uint256 epoch) external view returns (uint256);
    function epochRewardClaimed(uint256 epoch, address verifier) external view returns (bool);
    function epochDelegateRewardClaimed(uint256 epoch, address delegate) external view returns (bool);
    function epochRemainderSettled(uint256 epoch) external view returns (bool);
}
