// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Ownable2Step } from "@openzeppelin/contracts/access/Ownable2Step.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import { IAntseedRelayTreasury } from "../interfaces/IAntseedRelayTreasury.sol";

contract AntseedRelayTreasury is IAntseedRelayTreasury, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable override usdc;
    address public immutable override verifierRegistry;

    uint96 public override maxPayoutPerJob;
    uint96 public override maxPayoutPerAudit;
    uint96 public override maxCommittedBudgetPerEpoch;

    uint256 public override totalLockedUsdc;
    mapping(uint256 epoch => uint256 amount) public override committedBudgetByEpoch;
    mapping(uint256 epoch => uint256 amount) public override lockedBudgetByEpoch;
    mapping(bytes32 auditId => AuditReservation reservation) private _reservations;

    event Funded(address indexed funder, uint256 amount);
    event RelayPaid(bytes32 indexed auditId, address indexed recipient, uint16 jobCount, uint256 amount);
    event RelayBatchPaid(bytes32 indexed auditId, uint256 recipientCount, uint16 jobCount, uint256 totalAmount);
    event PayoutCapsSet(uint96 maxPayoutPerJob, uint96 maxPayoutPerAudit);
    event EpochBudgetCapSet(uint96 maxCommittedBudgetPerEpoch);
    event AuditBudgetReserved(
        bytes32 indexed auditId,
        uint256 indexed epoch,
        uint16 jobCount,
        uint96 payoutPerJobUsdc,
        uint96 totalBudgetUsdc,
        uint64 releaseAfter
    );
    event AuditBudgetReleased(bytes32 indexed auditId, uint256 indexed epoch, uint96 amount);
    event Withdrawn(address indexed recipient, uint256 amount);

    error InvalidAddress();
    error InvalidAmount();
    error InvalidPayoutCaps();
    error ArrayLengthMismatch();
    error NotVerifierRegistry();
    error PayoutCapExceeded();
    error AuditBudgetAlreadyReserved();
    error AuditBudgetNotReserved();
    error AuditBudgetReleasedAlready();
    error EpochBudgetCapExceeded();
    error InsufficientTreasuryBalance();
    error InsufficientReservedBudget();
    error ReleaseNotAvailable();
    error LockedFunds();

    modifier onlyVerifierRegistry() {
        if (msg.sender != verifierRegistry) revert NotVerifierRegistry();
        _;
    }

    constructor(
        address usdc_,
        address verifierRegistry_,
        uint96 maxPayoutPerJob_,
        uint96 maxPayoutPerAudit_,
        uint96 maxCommittedBudgetPerEpoch_
    ) Ownable(msg.sender) {
        if (
            usdc_ == address(0) || verifierRegistry_ == address(0) || usdc_.code.length == 0
                || verifierRegistry_.code.length == 0
        ) revert InvalidAddress();
        if (
            maxPayoutPerJob_ == 0 || maxPayoutPerJob_ > maxPayoutPerAudit_
                || maxPayoutPerAudit_ > maxCommittedBudgetPerEpoch_
        ) revert InvalidPayoutCaps();

        usdc = IERC20(usdc_);
        verifierRegistry = verifierRegistry_;
        maxPayoutPerJob = maxPayoutPerJob_;
        maxPayoutPerAudit = maxPayoutPerAudit_;
        maxCommittedBudgetPerEpoch = maxCommittedBudgetPerEpoch_;
    }

    function availableBalance() public view override returns (uint256) {
        uint256 balance = usdc.balanceOf(address(this));
        return balance > totalLockedUsdc ? balance - totalLockedUsdc : 0;
    }

    function getReservation(bytes32 auditId) external view override returns (AuditReservation memory) {
        return _reservations[auditId];
    }

    function reserveAuditBudget(
        bytes32 auditId,
        uint256 epoch,
        uint16 jobCount,
        uint96 payoutPerJobUsdc,
        uint64 releaseAfter
    ) external override onlyVerifierRegistry {
        if (auditId == bytes32(0) || jobCount == 0 || payoutPerJobUsdc == 0) revert InvalidAmount();
        if (_reservations[auditId].totalBudgetUsdc != 0) revert AuditBudgetAlreadyReserved();
        if (releaseAfter <= block.timestamp) revert ReleaseNotAvailable();
        if (payoutPerJobUsdc > maxPayoutPerJob) revert PayoutCapExceeded();

        uint256 computedBudget = uint256(payoutPerJobUsdc) * jobCount;
        if (computedBudget > maxPayoutPerAudit || computedBudget > type(uint96).max) revert PayoutCapExceeded();

        uint256 newEpochCommitment = committedBudgetByEpoch[epoch] + computedBudget;
        if (newEpochCommitment > maxCommittedBudgetPerEpoch) revert EpochBudgetCapExceeded();
        if (usdc.balanceOf(address(this)) < totalLockedUsdc + computedBudget) {
            revert InsufficientTreasuryBalance();
        }

        uint96 totalBudgetUsdc = uint96(computedBudget);
        _reservations[auditId] = AuditReservation({
            epoch: epoch,
            payoutPerJobUsdc: payoutPerJobUsdc,
            totalBudgetUsdc: totalBudgetUsdc,
            remainingBudgetUsdc: totalBudgetUsdc,
            jobCount: jobCount,
            paidJobCount: 0,
            releaseAfter: releaseAfter,
            released: false
        });
        totalLockedUsdc += computedBudget;
        committedBudgetByEpoch[epoch] = newEpochCommitment;
        lockedBudgetByEpoch[epoch] += computedBudget;

        emit AuditBudgetReserved(auditId, epoch, jobCount, payoutPerJobUsdc, totalBudgetUsdc, releaseAfter);
    }

    function fund(uint256 amount) external nonReentrant {
        if (amount == 0) revert InvalidAmount();
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        emit Funded(msg.sender, amount);
    }

    function payJob(bytes32 auditId, address recipient) external override onlyVerifierRegistry nonReentrant {
        if (recipient == address(0)) revert InvalidAddress();
        AuditReservation storage reservation = _activeReservation(auditId);
        _consumeJobs(reservation, 1);
        usdc.safeTransfer(recipient, reservation.payoutPerJobUsdc);
        emit RelayPaid(auditId, recipient, 1, reservation.payoutPerJobUsdc);
    }

    function payBatch(bytes32 auditId, address[] calldata recipients, uint16[] calldata jobCounts)
        external
        override
        onlyVerifierRegistry
        nonReentrant
    {
        uint256 length = recipients.length;
        if (length == 0 || length != jobCounts.length) revert ArrayLengthMismatch();

        uint256 aggregateJobCount;
        for (uint256 i = 0; i < length; i++) {
            if (recipients[i] == address(0)) revert InvalidAddress();
            if (jobCounts[i] == 0) revert InvalidAmount();
            aggregateJobCount += jobCounts[i];
        }
        if (aggregateJobCount > type(uint16).max) revert InsufficientReservedBudget();

        AuditReservation storage reservation = _activeReservation(auditId);
        uint16 totalJobCount = uint16(aggregateJobCount);
        _consumeJobs(reservation, totalJobCount);

        for (uint256 i = 0; i < length; i++) {
            uint256 amount = uint256(reservation.payoutPerJobUsdc) * jobCounts[i];
            usdc.safeTransfer(recipients[i], amount);
            emit RelayPaid(auditId, recipients[i], jobCounts[i], amount);
        }
        emit RelayBatchPaid(auditId, length, totalJobCount, uint256(reservation.payoutPerJobUsdc) * totalJobCount);
    }

    function releaseExpiredAuditBudget(bytes32 auditId) external override {
        AuditReservation storage reservation = _reservations[auditId];
        if (reservation.totalBudgetUsdc == 0) revert AuditBudgetNotReserved();
        if (reservation.released) revert AuditBudgetReleasedAlready();
        if (block.timestamp <= reservation.releaseAfter) revert ReleaseNotAvailable();
        uint96 releasedAmount = reservation.remainingBudgetUsdc;
        if (releasedAmount == 0) revert InsufficientReservedBudget();

        reservation.remainingBudgetUsdc = 0;
        reservation.released = true;
        totalLockedUsdc -= releasedAmount;
        lockedBudgetByEpoch[reservation.epoch] -= releasedAmount;
        emit AuditBudgetReleased(auditId, reservation.epoch, releasedAmount);
    }

    function setPayoutCaps(uint96 newMaxPerJob, uint96 newMaxPerAudit) external onlyOwner {
        if (newMaxPerJob == 0 || newMaxPerJob > newMaxPerAudit || newMaxPerAudit > maxCommittedBudgetPerEpoch) {
            revert InvalidPayoutCaps();
        }
        maxPayoutPerJob = newMaxPerJob;
        maxPayoutPerAudit = newMaxPerAudit;
        emit PayoutCapsSet(newMaxPerJob, newMaxPerAudit);
    }

    function setEpochBudgetCap(uint96 newMaxPerEpoch) external onlyOwner {
        if (newMaxPerEpoch == 0 || newMaxPerEpoch < maxPayoutPerAudit) revert InvalidPayoutCaps();
        maxCommittedBudgetPerEpoch = newMaxPerEpoch;
        emit EpochBudgetCapSet(newMaxPerEpoch);
    }

    function withdraw(address recipient, uint256 amount) external onlyOwner nonReentrant {
        if (recipient == address(0)) revert InvalidAddress();
        if (amount == 0) revert InvalidAmount();
        if (amount > availableBalance()) revert LockedFunds();
        usdc.safeTransfer(recipient, amount);
        emit Withdrawn(recipient, amount);
    }

    function _activeReservation(bytes32 auditId) internal view returns (AuditReservation storage reservation) {
        reservation = _reservations[auditId];
        if (reservation.totalBudgetUsdc == 0) revert AuditBudgetNotReserved();
        if (reservation.released) revert AuditBudgetReleasedAlready();
    }

    function _consumeJobs(AuditReservation storage reservation, uint16 jobCount) internal {
        uint256 amount = uint256(reservation.payoutPerJobUsdc) * jobCount;
        if (
            uint256(reservation.paidJobCount) + jobCount > reservation.jobCount
                || amount > reservation.remainingBudgetUsdc
        ) revert InsufficientReservedBudget();

        reservation.paidJobCount += jobCount;
        reservation.remainingBudgetUsdc -= uint96(amount);
        totalLockedUsdc -= amount;
        lockedBudgetByEpoch[reservation.epoch] -= amount;
    }
}
