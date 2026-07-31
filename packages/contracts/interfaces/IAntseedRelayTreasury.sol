// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IAntseedRelayTreasury {
    struct AuditReservation {
        uint256 epoch;
        uint96 payoutPerJobUsdc;
        uint96 totalBudgetUsdc;
        uint96 remainingBudgetUsdc;
        uint16 jobCount;
        uint16 paidJobCount;
        uint64 releaseAfter;
        bool released;
    }

    function usdc() external view returns (IERC20);
    function verifierRegistry() external view returns (address);
    function maxPayoutPerJob() external view returns (uint96);
    function maxPayoutPerAudit() external view returns (uint96);
    function maxCommittedBudgetPerEpoch() external view returns (uint96);
    function totalLockedUsdc() external view returns (uint256);
    function committedBudgetByEpoch(uint256 epoch) external view returns (uint256);
    function lockedBudgetByEpoch(uint256 epoch) external view returns (uint256);

    function availableBalance() external view returns (uint256);
    function getReservation(bytes32 auditId) external view returns (AuditReservation memory);

    function reserveAuditBudget(
        bytes32 auditId,
        uint256 epoch,
        uint16 jobCount,
        uint96 payoutPerJobUsdc,
        uint64 releaseAfter
    ) external;
    function payJob(bytes32 auditId, address recipient) external;
    function payBatch(bytes32 auditId, address[] calldata recipients, uint16[] calldata jobCounts) external;
    function releaseExpiredAuditBudget(bytes32 auditId) external;
}
