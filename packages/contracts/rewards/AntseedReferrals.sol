// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

interface IAntseedReferralUsageAccounting {
    function currentEpoch() external view returns (uint256);
    function buyerUsageTotal(address buyer) external view returns (uint256 points, uint256 weightedPoints);
}

interface IAntseedReferralUsageRewards {
    function pendingBuyerReward(address buyer, uint256 epoch) external view returns (uint256 amount);
}

interface IAntseedReferralDeposits {
    function getOperator(address buyer) external view returns (address);
}

/**
 * @title AntseedReferrals
 * @notice Foundation-funded rewards for wallets that refer active buyers.
 */
contract AntseedReferrals is EIP712, Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint32 public constant BPS_DENOMINATOR = 10_000;
    uint32 public constant referralRateBps = 200;
    uint256 public constant MAX_EPOCHS_PER_ACCRUAL = 52;

    bytes32 public constant BIND_REFERRAL_TYPEHASH =
        keccak256("BindReferral(address buyer,address referrer,uint256 nonce,uint256 deadline)");

    IERC20 public immutable ants;
    IAntseedReferralUsageAccounting public immutable usageAccounting;
    IAntseedReferralUsageRewards public immutable usageRewards;
    IAntseedReferralDeposits public immutable deposits;

    uint256 public totalClaimable;

    mapping(address buyer => address referrer) public referrerOf;
    mapping(address buyer => uint256 epoch) public boundAtEpoch;
    mapping(address buyer => uint256 epoch) public nextAccrualEpoch;
    mapping(address buyer => uint256 nonce) public nonces;
    mapping(address referrer => uint256 amount) public claimable;

    event ReferralBound(address indexed buyer, address indexed referrer, address indexed submitter, uint256 epoch);
    event ReferralAccrued(
        address indexed buyer,
        address indexed referrer,
        uint256 indexed epoch,
        uint256 buyerReward,
        uint256 referralReward
    );
    event ReferralClaimed(address indexed referrer, uint256 amount);
    event Funded(address indexed funder, uint256 amount);

    error InvalidAddress();
    error InvalidAmount();
    error InvalidNonce();
    error InvalidSignature();
    error SignatureExpired();
    error ReferralAlreadyBound();
    error ReferralNotBound();
    error ReferralMustPrecedeUsage();
    error SelfReferral();
    error EpochNotFinalized();
    error AccrualRangeTooLarge();
    error InsufficientFunding();
    error NothingToClaim();

    constructor(address _ants, address _usageAccounting, address _usageRewards, address _deposits)
        EIP712("AntseedReferrals", "1")
        Ownable(msg.sender)
    {
        if (
            _ants == address(0) || _usageAccounting == address(0) || _usageRewards == address(0)
                || _deposits == address(0)
        ) revert InvalidAddress();
        ants = IERC20(_ants);
        usageAccounting = IAntseedReferralUsageAccounting(_usageAccounting);
        usageRewards = IAntseedReferralUsageRewards(_usageRewards);
        deposits = IAntseedReferralDeposits(_deposits);
    }

    function bindReferral(address buyer, address referrer, uint256 nonce, uint256 deadline, bytes calldata signature)
        external
        whenNotPaused
    {
        if (buyer == address(0) || referrer == address(0)) revert InvalidAddress();
        if (block.timestamp > deadline) revert SignatureExpired();
        if (nonce != nonces[buyer]) revert InvalidNonce();
        if (referrerOf[buyer] != address(0)) revert ReferralAlreadyBound();

        (uint256 priorUsage,) = usageAccounting.buyerUsageTotal(buyer);
        if (priorUsage != 0) revert ReferralMustPrecedeUsage();

        address operator = deposits.getOperator(buyer);
        if (referrer == buyer || (operator != address(0) && referrer == operator)) revert SelfReferral();

        bytes32 structHash = keccak256(abi.encode(BIND_REFERRAL_TYPEHASH, buyer, referrer, nonce, deadline));
        if (ECDSA.recover(_hashTypedDataV4(structHash), signature) != buyer) revert InvalidSignature();

        nonces[buyer] = nonce + 1;
        uint256 epoch = usageAccounting.currentEpoch();
        referrerOf[buyer] = referrer;
        boundAtEpoch[buyer] = epoch;
        nextAccrualEpoch[buyer] = epoch;

        emit ReferralBound(buyer, referrer, msg.sender, epoch);
    }

    function accrue(address buyer, uint256 throughEpoch) external whenNotPaused {
        address referrer = referrerOf[buyer];
        if (referrer == address(0)) revert ReferralNotBound();

        uint256 currentEpoch = usageAccounting.currentEpoch();
        if (throughEpoch >= currentEpoch) revert EpochNotFinalized();

        uint256 epoch = nextAccrualEpoch[buyer];
        if (throughEpoch < epoch) return;
        if (throughEpoch - epoch + 1 > MAX_EPOCHS_PER_ACCRUAL) revert AccrualRangeTooLarge();

        uint256 available = ants.balanceOf(address(this)) - totalClaimable;
        for (; epoch <= throughEpoch; epoch++) {
            uint256 buyerReward = usageRewards.pendingBuyerReward(buyer, epoch);
            uint256 referralReward = (buyerReward * referralRateBps) / BPS_DENOMINATOR;
            if (referralReward > available) revert InsufficientFunding();
            if (referralReward != 0) {
                claimable[referrer] += referralReward;
                totalClaimable += referralReward;
                available -= referralReward;
            }
            emit ReferralAccrued(buyer, referrer, epoch, buyerReward, referralReward);
        }
        nextAccrualEpoch[buyer] = throughEpoch + 1;
    }

    function claim() external nonReentrant whenNotPaused {
        uint256 amount = claimable[msg.sender];
        if (amount == 0) revert NothingToClaim();
        claimable[msg.sender] = 0;
        totalClaimable -= amount;
        ants.safeTransfer(msg.sender, amount);

        emit ReferralClaimed(msg.sender, amount);
    }

    function fund(uint256 amount) external nonReentrant {
        if (amount == 0) revert InvalidAmount();
        ants.safeTransferFrom(msg.sender, address(this), amount);
        emit Funded(msg.sender, amount);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }
}
