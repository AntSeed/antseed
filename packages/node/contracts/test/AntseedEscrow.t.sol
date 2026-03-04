// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { AntseedEscrow } from "../AntseedEscrow.sol";
import { MockUSDC } from "../MockUSDC.sol";

interface Vm {
    function addr(uint256 privateKey) external returns (address keyAddr);
    function expectRevert(bytes4 revertData) external;
    function expectRevert(bytes calldata revertData) external;
    function prank(address msgSender) external;
    function startPrank(address msgSender) external;
    function stopPrank() external;
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
    function store(address target, bytes32 slot, bytes32 value) external;
    function warp(uint256 newTimestamp) external;
}

abstract contract TestBase {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    error AssertionFailed();

    function assertEq(uint256 a, uint256 b) internal pure {
        if (a != b) revert AssertionFailed();
    }

    function assertEq(address a, address b) internal pure {
        if (a != b) revert AssertionFailed();
    }

    function assertEq(bool a, bool b) internal pure {
        if (a != b) revert AssertionFailed();
    }

    function assertEq(bytes32 a, bytes32 b) internal pure {
        if (a != b) revert AssertionFailed();
    }

    function assertEq(bytes memory a, bytes memory b) internal pure {
        if (keccak256(a) != keccak256(b)) revert AssertionFailed();
    }

    function assertGt(uint256 a, uint256 b) internal pure {
        if (a <= b) revert AssertionFailed();
    }
}

contract FalseReturnUSDC {
    uint8 public constant decimals = 6;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    bool public failTransferFrom;
    bool public failTransfer;

    function setFailTransferFrom(bool value) external {
        failTransferFrom = value;
    }

    function setFailTransfer(bool value) external {
        failTransfer = value;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (failTransferFrom) return false;
        uint256 allowed = allowance[from][msg.sender];
        if (allowed < amount) return false;
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
        if (balanceOf[from] < amount) return false;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        if (failTransfer) return false;
        if (balanceOf[msg.sender] < amount) return false;
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract NoReturnUSDC {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    error InsufficientBalance();
    error InsufficientAllowance();

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    // Intentionally no return data.
    function transferFrom(address from, address to, uint256 amount) external {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed < amount) revert InsufficientAllowance();
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
        if (balanceOf[from] < amount) revert InsufficientBalance();
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }

    // Intentionally no return data.
    function transfer(address to, uint256 amount) external {
        if (balanceOf[msg.sender] < amount) revert InsufficientBalance();
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
    }
}

contract ReentrantUSDC {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    AntseedEscrow public escrow;
    bool public triggerReentry;
    bytes public lastRevertData;

    error InsufficientBalance();
    error InsufficientAllowance();

    function setEscrow(address escrow_) external {
        escrow = AntseedEscrow(escrow_);
    }

    function setTriggerReentry(bool value) external {
        triggerReentry = value;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed < amount) revert InsufficientAllowance();
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
        if (balanceOf[from] < amount) revert InsufficientBalance();
        balanceOf[from] -= amount;
        balanceOf[to] += amount;

        if (triggerReentry && msg.sender == address(escrow)) {
            triggerReentry = false;
            try escrow.deposit(1) { } catch (bytes memory reason) { lastRevertData = reason; }
        }

        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        if (balanceOf[msg.sender] < amount) revert InsufficientBalance();
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract AntseedEscrowTest is TestBase {
    uint256 private constant BUYER_PK = 0xB0B;
    uint256 private constant BUYER_TWO_PK = 0xB0C;
    uint256 private constant SELLER_A_PK = 0xA11;
    uint256 private constant SELLER_B_PK = 0xB22;
    uint256 private constant SELLER_C_PK = 0xC33;
    uint256 private constant SELLER_D_PK = 0xD44;
    uint256 private constant FEE_COLLECTOR_PK = 0xFEE;
    uint256 private constant NEW_OWNER_PK = 0xACE;

    uint256 private constant MIN_STAKE = 10_000_000;

    MockUSDC private usdc;
    AntseedEscrow private escrow;

    address private buyer;
    address private buyerTwo;
    address private sellerA;
    address private sellerB;
    address private sellerC;
    address private sellerD;
    address private feeCollector;
    address private newOwner;

    function setUp() public {
        buyer = vm.addr(BUYER_PK);
        buyerTwo = vm.addr(BUYER_TWO_PK);
        sellerA = vm.addr(SELLER_A_PK);
        sellerB = vm.addr(SELLER_B_PK);
        sellerC = vm.addr(SELLER_C_PK);
        sellerD = vm.addr(SELLER_D_PK);
        feeCollector = vm.addr(FEE_COLLECTOR_PK);
        newOwner = vm.addr(NEW_OWNER_PK);

        usdc = new MockUSDC();
        escrow = new AntseedEscrow(address(usdc), feeCollector, 200);

        _mintAndApprove(address(usdc), buyer, 1_000_000_000);
        _mintAndApprove(address(usdc), buyerTwo, 1_000_000_000);
        _mintAndApprove(address(usdc), sellerA, 1_000_000_000);
        _mintAndApprove(address(usdc), sellerB, 1_000_000_000);
        _mintAndApprove(address(usdc), sellerC, 1_000_000_000);
        _mintAndApprove(address(usdc), sellerD, 1_000_000_000);
    }

    function testConstructorValidationAndState() public {
        vm.expectRevert(AntseedEscrow.ZeroAddress.selector);
        new AntseedEscrow(address(0), feeCollector, 100);

        vm.expectRevert(AntseedEscrow.ZeroAddress.selector);
        new AntseedEscrow(address(usdc), address(0), 100);

        vm.expectRevert(abi.encodeWithSelector(AntseedEscrow.FeeTooHigh.selector, uint16(1001), uint16(1000)));
        new AntseedEscrow(address(usdc), feeCollector, 1001);

        assertEq(escrow.owner(), address(this));
        assertEq(escrow.feeCollector(), feeCollector);
        assertEq(uint256(escrow.platformFeeBps()), 200);
        assertEq(escrow.paused(), false);
        assertGt(uint256(escrow.DOMAIN_SEPARATOR()), 0);
    }

    function testAdminControlsAndOnlyOwnerGuards() public {
        vm.startPrank(buyer);
        vm.expectRevert(AntseedEscrow.NotOwner.selector);
        escrow.setFeeCollector(buyer);

        vm.expectRevert(AntseedEscrow.NotOwner.selector);
        escrow.setPlatformFee(100);

        vm.expectRevert(AntseedEscrow.NotOwner.selector);
        escrow.pause();

        vm.expectRevert(AntseedEscrow.NotOwner.selector);
        escrow.unpause();

        vm.expectRevert(AntseedEscrow.NotOwner.selector);
        escrow.transferOwnership(buyer);
        vm.stopPrank();

        vm.expectRevert(AntseedEscrow.ZeroAddress.selector);
        escrow.transferOwnership(address(0));

        vm.expectRevert(AntseedEscrow.ZeroAddress.selector);
        escrow.setFeeCollector(address(0));

        vm.expectRevert(abi.encodeWithSelector(AntseedEscrow.FeeTooHigh.selector, uint16(1001), uint16(1000)));
        escrow.setPlatformFee(1001);

        escrow.setFeeCollector(newOwner);
        assertEq(escrow.feeCollector(), newOwner);

        escrow.setPlatformFee(0);
        assertEq(uint256(escrow.platformFeeBps()), 0);

        escrow.pause();
        assertEq(escrow.paused(), true);
        escrow.unpause();
        assertEq(escrow.paused(), false);

        escrow.transferOwnership(newOwner);
        assertEq(escrow.owner(), newOwner);

        vm.prank(newOwner);
        escrow.pause();
        assertEq(escrow.paused(), true);

        vm.prank(newOwner);
        escrow.unpause();
        assertEq(escrow.paused(), false);
    }

    function testDepositRevertsForZeroPausedAndTransferFailure() public {
        vm.expectRevert(AntseedEscrow.ZeroAmount.selector);
        vm.prank(buyer);
        escrow.deposit(0);

        escrow.pause();
        vm.expectRevert(AntseedEscrow.Paused.selector);
        vm.prank(buyer);
        escrow.deposit(1_000_000);
        escrow.unpause();

        FalseReturnUSDC falseToken = new FalseReturnUSDC();
        AntseedEscrow badEscrow = new AntseedEscrow(address(falseToken), feeCollector, 100);
        falseToken.mint(buyer, 10_000_000);
        vm.prank(buyer);
        falseToken.approve(address(badEscrow), type(uint256).max);
        falseToken.setFailTransferFrom(true);

        vm.expectRevert(AntseedEscrow.TransferFailed.selector);
        vm.prank(buyer);
        badEscrow.deposit(1_000_000);
    }

    function testDepositSuccessAndBalanceViews() public {
        _deposit(buyer, 15_000_000);

        (uint256 available, uint256 pending, uint256 readyAt) = escrow.getBuyerBalance(buyer);
        assertEq(available, 15_000_000);
        assertEq(pending, 0);
        assertEq(readyAt, 0);

        (uint256 balance, uint256 withdrawalAmount, uint256 withdrawalRequestedAt,,) = escrow.buyers(buyer);
        assertEq(balance, 15_000_000);
        assertEq(withdrawalAmount, 0);
        assertEq(withdrawalRequestedAt, 0);
    }

    function testDepositSupportsNoReturnTokensAndReentrancyGuard() public {
        NoReturnUSDC noReturn = new NoReturnUSDC();
        AntseedEscrow noReturnEscrow = new AntseedEscrow(address(noReturn), feeCollector, 100);
        noReturn.mint(buyer, 9_000_000);
        vm.prank(buyer);
        noReturn.approve(address(noReturnEscrow), type(uint256).max);

        vm.prank(buyer);
        noReturnEscrow.deposit(4_000_000);
        (uint256 available,,) = noReturnEscrow.getBuyerBalance(buyer);
        assertEq(available, 4_000_000);

        ReentrantUSDC reentrant = new ReentrantUSDC();
        AntseedEscrow reentrantEscrow = new AntseedEscrow(address(reentrant), feeCollector, 100);
        reentrant.setEscrow(address(reentrantEscrow));
        reentrant.mint(buyer, 9_000_000);
        vm.prank(buyer);
        reentrant.approve(address(reentrantEscrow), type(uint256).max);
        reentrant.setTriggerReentry(true);

        vm.prank(buyer);
        reentrantEscrow.deposit(2_000_000);

        bytes memory expected = abi.encodeWithSelector(AntseedEscrow.Reentrancy.selector);
        assertEq(reentrant.lastRevertData(), expected);
    }

    function testNonReentrantGuardRevertsWhenLockPreSet() public {
        vm.store(address(escrow), bytes32(uint256(13)), bytes32(uint256(1)));
        vm.expectRevert(AntseedEscrow.Reentrancy.selector);
        vm.prank(buyer);
        escrow.deposit(1_000_000);
    }

    function testRequestWithdrawalAndCancelFlow() public {
        _deposit(buyer, 20_000_000);

        vm.expectRevert(AntseedEscrow.ZeroAmount.selector);
        vm.prank(buyer);
        escrow.requestWithdrawal(0);

        vm.prank(buyer);
        escrow.requestWithdrawal(9_000_000);
        (uint256 available, uint256 pending, uint256 readyAt) = escrow.getBuyerBalance(buyer);
        assertEq(available, 11_000_000);
        assertEq(pending, 9_000_000);
        assertEq(readyAt, block.timestamp + escrow.WITHDRAWAL_TIMELOCK());

        vm.warp(block.timestamp + 33);
        vm.prank(buyer);
        escrow.requestWithdrawal(1_000_000);
        (available, pending, readyAt) = escrow.getBuyerBalance(buyer);
        assertEq(available, 10_000_000);
        assertEq(pending, 10_000_000);
        assertEq(readyAt, block.timestamp + escrow.WITHDRAWAL_TIMELOCK());

        vm.prank(buyer);
        escrow.cancelWithdrawal();
        (available, pending, readyAt) = escrow.getBuyerBalance(buyer);
        assertEq(available, 20_000_000);
        assertEq(pending, 0);
        assertEq(readyAt, 0);
    }

    function testRequestWithdrawalRevertsForInsufficientAvailableAndPause() public {
        _deposit(buyer, 5_000_000);
        vm.prank(buyer);
        escrow.requestWithdrawal(4_000_000);

        vm.expectRevert(abi.encodeWithSelector(AntseedEscrow.InsufficientBalance.selector, 1_000_000, 2_000_000));
        vm.prank(buyer);
        escrow.requestWithdrawal(2_000_000);

        escrow.pause();
        vm.expectRevert(AntseedEscrow.Paused.selector);
        vm.prank(buyer);
        escrow.requestWithdrawal(1);
    }

    function testExecuteWithdrawalRevertsAndSucceeds() public {
        vm.expectRevert(AntseedEscrow.WithdrawalNotRequested.selector);
        vm.prank(buyer);
        escrow.executeWithdrawal();

        _deposit(buyer, 9_000_000);
        vm.prank(buyer);
        escrow.requestWithdrawal(7_000_000);

        uint256 readyAt = block.timestamp + escrow.WITHDRAWAL_TIMELOCK();
        vm.expectRevert(abi.encodeWithSelector(AntseedEscrow.WithdrawalTimelockActive.selector, readyAt));
        vm.prank(buyer);
        escrow.executeWithdrawal();

        vm.warp(readyAt);
        uint256 buyerBefore = usdc.balanceOf(buyer);
        vm.prank(buyer);
        escrow.executeWithdrawal();
        uint256 buyerAfter = usdc.balanceOf(buyer);
        assertEq(buyerAfter - buyerBefore, 7_000_000);
        (uint256 available, uint256 pending, uint256 nextReadyAt) = escrow.getBuyerBalance(buyer);
        assertEq(available, 2_000_000);
        assertEq(pending, 0);
        assertEq(nextReadyAt, 0);
    }

    function testExecuteWithdrawalTransferFailureReverts() public {
        FalseReturnUSDC falseToken = new FalseReturnUSDC();
        AntseedEscrow badEscrow = new AntseedEscrow(address(falseToken), feeCollector, 100);
        falseToken.mint(buyer, 9_000_000);
        vm.prank(buyer);
        falseToken.approve(address(badEscrow), type(uint256).max);

        vm.prank(buyer);
        badEscrow.deposit(4_000_000);
        vm.prank(buyer);
        badEscrow.requestWithdrawal(2_000_000);
        vm.warp(block.timestamp + badEscrow.WITHDRAWAL_TIMELOCK());

        falseToken.setFailTransfer(true);
        vm.expectRevert(AntseedEscrow.TransferFailed.selector);
        vm.prank(buyer);
        badEscrow.executeWithdrawal();
    }

    function testCancelWithdrawalRevertsWithoutPendingRequest() public {
        vm.expectRevert(AntseedEscrow.WithdrawalNotRequested.selector);
        vm.prank(buyer);
        escrow.cancelWithdrawal();
    }

    function testStakeAndUnstakeLifecycle() public {
        vm.expectRevert(AntseedEscrow.ZeroAmount.selector);
        vm.prank(sellerA);
        escrow.stake(0);

        uint256 stakeAt = block.timestamp;
        _stake(sellerA, MIN_STAKE);
        (, uint256 stakedAmount, uint256 stakedSince,,,,) = escrow.sellers(sellerA);
        assertEq(stakedAmount, MIN_STAKE);
        assertEq(stakedSince, stakeAt);

        vm.warp(block.timestamp + 1234);
        _stake(sellerA, 1_000_000);
        (, stakedAmount, stakedSince,,,,) = escrow.sellers(sellerA);
        assertEq(stakedAmount, MIN_STAKE + 1_000_000);
        assertEq(stakedSince, stakeAt);

        vm.expectRevert(abi.encodeWithSelector(
            AntseedEscrow.InsufficientStakedAmount.selector,
            MIN_STAKE + 1_000_000,
            MIN_STAKE + 1_000_001
        ));
        vm.prank(sellerA);
        escrow.unstake(MIN_STAKE + 1_000_001);

        vm.expectRevert(abi.encodeWithSelector(
            AntseedEscrow.StakeLocked.selector,
            stakeAt + escrow.STAKE_LOCK_PERIOD()
        ));
        vm.prank(sellerA);
        escrow.unstake(1_000_000);

        vm.warp(stakeAt + escrow.STAKE_LOCK_PERIOD());
        uint256 sellerBefore = usdc.balanceOf(sellerA);
        vm.prank(sellerA);
        escrow.unstake(1_000_000);
        uint256 sellerAfter = usdc.balanceOf(sellerA);
        assertEq(sellerAfter - sellerBefore, 1_000_000);
        (, stakedAmount,,,,,) = escrow.sellers(sellerA);
        assertEq(stakedAmount, MIN_STAKE);
    }

    function testStakeRevertsPausedAndTransferFailure() public {
        escrow.pause();
        vm.expectRevert(AntseedEscrow.Paused.selector);
        vm.prank(sellerA);
        escrow.stake(1_000_000);

        FalseReturnUSDC falseToken = new FalseReturnUSDC();
        AntseedEscrow badEscrow = new AntseedEscrow(address(falseToken), feeCollector, 100);
        falseToken.mint(sellerA, 10_000_000);
        vm.prank(sellerA);
        falseToken.approve(address(badEscrow), type(uint256).max);
        falseToken.setFailTransferFrom(true);
        vm.expectRevert(AntseedEscrow.TransferFailed.selector);
        vm.prank(sellerA);
        badEscrow.stake(1_000_000);
    }

    function testUnstakeZeroReverts() public {
        vm.expectRevert(AntseedEscrow.ZeroAmount.selector);
        vm.prank(sellerA);
        escrow.unstake(0);
    }

    function testChargeBasicRevertPaths() public {
        _deposit(buyer, 8_000_000);
        uint256 deadline = block.timestamp + 1 days;
        bytes32 sessionId = keccak256("session-basic-reverts");
        bytes memory sig = _signSpendingAuth(BUYER_PK, sellerA, sessionId, 4_000_000, 1, deadline, false);

        vm.expectRevert(AntseedEscrow.ZeroAmount.selector);
        vm.prank(sellerA);
        escrow.charge(buyer, 0, sessionId, 4_000_000, 1, deadline, sig);

        vm.expectRevert(abi.encodeWithSelector(AntseedEscrow.AuthNonceMismatch.selector, 0, 0));
        vm.prank(sellerA);
        escrow.charge(buyer, 1_000_000, sessionId, 4_000_000, 0, deadline, sig);

        vm.warp(deadline + 1);
        vm.expectRevert(abi.encodeWithSelector(AntseedEscrow.AuthExpired.selector, deadline, block.timestamp));
        vm.prank(sellerA);
        escrow.charge(buyer, 1_000_000, sessionId, 4_000_000, 1, deadline, sig);

        uint256 liveDeadline = block.timestamp + 1 days;
        bytes memory liveSig = _signSpendingAuth(BUYER_PK, sellerA, sessionId, 4_000_000, 1, liveDeadline, false);
        vm.expectRevert(abi.encodeWithSelector(AntseedEscrow.InsufficientStake.selector, 0, MIN_STAKE));
        vm.prank(sellerA);
        escrow.charge(buyer, 1_000_000, sessionId, 4_000_000, 1, liveDeadline, liveSig);

        _stake(sellerA, MIN_STAKE);
        escrow.pause();
        vm.expectRevert(AntseedEscrow.Paused.selector);
        vm.prank(sellerA);
        escrow.charge(buyer, 1_000_000, sessionId, 4_000_000, 1, liveDeadline, liveSig);
    }

    function testChargeRejectsInvalidSignatures() public {
        _deposit(buyer, 12_000_000);
        _stake(sellerA, MIN_STAKE);

        uint256 deadline = block.timestamp + 1 days;
        bytes32 sessionId = keccak256("session-invalid-sig");
        bytes memory wrongSig = _signSpendingAuth(BUYER_TWO_PK, sellerA, sessionId, 5_000_000, 1, deadline, false);

        vm.expectRevert(AntseedEscrow.AuthInvalidSig.selector);
        vm.prank(sellerA);
        escrow.charge(buyer, 1_000_000, sessionId, 5_000_000, 1, deadline, wrongSig);

        vm.expectRevert(AntseedEscrow.AuthInvalidSig.selector);
        vm.prank(sellerA);
        escrow.charge(buyer, 1_000_000, sessionId, 5_000_000, 1, deadline, hex"1234");
    }

    function testChargeNonceCapAndBalanceReverts() public {
        _deposit(buyer, 6_000_000);
        _stake(sellerA, MIN_STAKE);

        bytes32 sessionId = keccak256("session-nonce-cap");
        uint256 deadline = block.timestamp + 1 days;
        bytes memory auth1 = _signSpendingAuth(BUYER_PK, sellerA, sessionId, 3_000_000, 1, deadline, false);

        vm.prank(sellerA);
        escrow.charge(buyer, 1_000_000, sessionId, 3_000_000, 1, deadline, auth1);

        bytes memory badCapSig = _signSpendingAuth(BUYER_PK, sellerA, sessionId, 4_000_000, 1, deadline, false);
        vm.expectRevert(abi.encodeWithSelector(AntseedEscrow.AuthCapMismatch.selector, 3_000_000, 4_000_000));
        vm.prank(sellerA);
        escrow.charge(buyer, 1, sessionId, 4_000_000, 1, deadline, badCapSig);

        vm.expectRevert(abi.encodeWithSelector(AntseedEscrow.AuthCapExceeded.selector, 1_000_000, 2_500_001, 3_000_000));
        vm.prank(sellerA);
        escrow.charge(buyer, 2_500_001, sessionId, 3_000_000, 1, deadline, auth1);

        bytes memory skipNonceSig = _signSpendingAuth(BUYER_PK, sellerA, sessionId, 8_000_000, 3, deadline, false);
        vm.expectRevert(abi.encodeWithSelector(AntseedEscrow.AuthNonceMismatch.selector, 1, 3));
        vm.prank(sellerA);
        escrow.charge(buyer, 1, sessionId, 8_000_000, 3, deadline, skipNonceSig);

        bytes memory highChargeSig = _signSpendingAuth(BUYER_PK, sellerA, sessionId, 50_000_000, 2, deadline, false);
        vm.expectRevert(abi.encodeWithSelector(AntseedEscrow.InsufficientBalance.selector, 5_000_000, 7_000_000));
        vm.prank(sellerA);
        escrow.charge(buyer, 7_000_000, sessionId, 50_000_000, 2, deadline, highChargeSig);
    }

    function testChargeFlowUpdatesStatsFeesSessionAndWithdrawalReservation() public {
        _deposit(buyer, 20_000_000);
        _stake(sellerA, MIN_STAKE);

        vm.prank(buyer);
        escrow.requestWithdrawal(18_000_000);

        bytes32 sessionId = keccak256("session-flow");
        uint256 deadline = block.timestamp + 1 days;
        bytes memory auth1 = _signSpendingAuth(BUYER_PK, sellerA, sessionId, 10_000_000, 1, deadline, false);

        vm.prank(sellerA);
        escrow.charge(buyer, 5_000_000, sessionId, 10_000_000, 1, deadline, auth1);
        vm.prank(sellerA);
        escrow.charge(buyer, 2_000_000, sessionId, 10_000_000, 1, deadline, auth1);

        bytes memory authTopUp = _signSpendingAuth(BUYER_PK, sellerA, sessionId, 20_000_000, 2, deadline, false);
        vm.prank(sellerA);
        escrow.charge(buyer, 1_000_000, sessionId, 20_000_000, 2, deadline, authTopUp);

        (uint256 nonce, uint256 authMax, uint256 authUsed, uint256 authDeadline) =
            escrow.getSessionAuth(buyer, sellerA, sessionId);
        assertEq(nonce, 2);
        assertEq(authMax, 20_000_000);
        assertEq(authUsed, 1_000_000);
        assertEq(authDeadline, deadline);

        (uint256 available, uint256 pending,) = escrow.getBuyerBalance(buyer);
        assertEq(available, 0);
        assertEq(pending, 12_000_000);

        (uint256 pendingEarnings,,,,,,) = escrow.sellers(sellerA);
        assertEq(pendingEarnings, 7_840_000);
        assertEq(escrow.accumulatedFees(), 160_000);

        (uint256 buyerBalance, uint256 withdrawalAmount,, uint256 firstTxAt, uint256 uniqueSellers) = escrow.buyers(buyer);
        assertEq(buyerBalance, 12_000_000);
        assertEq(withdrawalAmount, 12_000_000);
        assertEq(uniqueSellers, 1);
        assertEq(firstTxAt, block.timestamp);

        (,
            uint256 stakedAmount,
            ,
            uint256 sellerFirstTxAt,
            uint256 totalTransactions,
            uint256 totalVolume,
            uint256 uniqueBuyers
        ) = escrow.sellers(sellerA);
        assertEq(stakedAmount, MIN_STAKE);
        assertEq(sellerFirstTxAt, block.timestamp);
        assertEq(totalTransactions, 3);
        assertEq(totalVolume, 8_000_000);
        assertEq(uniqueBuyers, 1);
    }

    function testChargeSupportsCompactVSignatureAndZeroFeeMode() public {
        _deposit(buyer, 8_000_000);
        _stake(sellerA, MIN_STAKE);
        escrow.setPlatformFee(0);

        bytes32 sessionId = keccak256("session-compact-v");
        uint256 deadline = block.timestamp + 1 days;
        bytes memory compactSig = _signSpendingAuth(BUYER_PK, sellerA, sessionId, 8_000_000, 1, deadline, true);

        vm.prank(sellerA);
        escrow.charge(buyer, 3_000_000, sessionId, 8_000_000, 1, deadline, compactSig);

        assertEq(escrow.accumulatedFees(), 0);
        (uint256 pendingEarnings,,,,,,) = escrow.sellers(sellerA);
        assertEq(pendingEarnings, 3_000_000);
    }

    function testClaimEarningsAndSweepFeesFlows() public {
        _deposit(buyer, 20_000_000);
        _stake(sellerA, MIN_STAKE);

        bytes32 sessionId = keccak256("session-claim-sweep");
        uint256 deadline = block.timestamp + 1 days;
        bytes memory sig = _signSpendingAuth(BUYER_PK, sellerA, sessionId, 20_000_000, 1, deadline, false);
        vm.prank(sellerA);
        escrow.charge(buyer, 10_000_000, sessionId, 20_000_000, 1, deadline, sig);

        uint256 sellerBefore = usdc.balanceOf(sellerA);
        vm.prank(sellerA);
        escrow.claimEarnings();
        uint256 sellerAfter = usdc.balanceOf(sellerA);
        assertEq(sellerAfter - sellerBefore, 9_800_000);

        vm.expectRevert(AntseedEscrow.ZeroAmount.selector);
        vm.prank(sellerA);
        escrow.claimEarnings();

        uint256 collectorBefore = usdc.balanceOf(feeCollector);
        escrow.sweepFees();
        uint256 collectorAfter = usdc.balanceOf(feeCollector);
        assertEq(collectorAfter - collectorBefore, 200_000);

        vm.expectRevert(AntseedEscrow.ZeroAmount.selector);
        escrow.sweepFees();
    }

    function testClaimAndSweepTransferFailureReverts() public {
        FalseReturnUSDC falseToken = new FalseReturnUSDC();
        AntseedEscrow badEscrow = new AntseedEscrow(address(falseToken), feeCollector, 200);
        _mintAndApprove(address(falseToken), buyer, 30_000_000);
        _mintAndApprove(address(falseToken), sellerA, 30_000_000);

        vm.prank(sellerA);
        falseToken.approve(address(badEscrow), type(uint256).max);
        vm.prank(buyer);
        falseToken.approve(address(badEscrow), type(uint256).max);

        vm.prank(buyer);
        badEscrow.deposit(10_000_000);
        vm.prank(sellerA);
        badEscrow.stake(MIN_STAKE);

        bytes32 sessionId = keccak256("session-failing-transfer");
        uint256 deadline = block.timestamp + 1 days;
        bytes memory sig = _signSpendingAuthForEscrow(
            badEscrow,
            BUYER_PK,
            sellerA,
            sessionId,
            10_000_000,
            1,
            deadline,
            false
        );
        vm.prank(sellerA);
        badEscrow.charge(buyer, 5_000_000, sessionId, 10_000_000, 1, deadline, sig);

        falseToken.setFailTransfer(true);

        vm.expectRevert(AntseedEscrow.TransferFailed.selector);
        vm.prank(sellerA);
        badEscrow.claimEarnings();

        vm.expectRevert(AntseedEscrow.TransferFailed.selector);
        badEscrow.sweepFees();
    }

    function testRateSellerRevertGuards() public {
        vm.expectRevert(abi.encodeWithSelector(AntseedEscrow.RatingOutOfRange.selector, uint8(101)));
        vm.prank(buyer);
        escrow.rateSeller(sellerA, 101);

        vm.expectRevert(abi.encodeWithSelector(
            AntseedEscrow.RatingAccountTooNew.selector,
            block.timestamp + escrow.BUYER_AGE_REQUIREMENT()
        ));
        vm.prank(buyer);
        escrow.rateSeller(sellerA, 70);
    }

    function testRateSellerNeedMoreSellersAndNoInteractionAndInsufficientSpend() public {
        _deposit(buyer, 30_000_000);
        _stake(sellerA, MIN_STAKE);
        _stake(sellerB, MIN_STAKE);
        _stake(sellerC, MIN_STAKE);

        _chargeForSeller(sellerA, BUYER_PK, keccak256("rate-needmore-1"), 500_000, 500_000, 1);
        vm.warp(block.timestamp + escrow.BUYER_AGE_REQUIREMENT());

        vm.expectRevert(abi.encodeWithSelector(AntseedEscrow.RatingNeedMoreSellers.selector, 1, 3));
        vm.prank(buyer);
        escrow.rateSeller(sellerA, 80);

        _chargeForSeller(sellerB, BUYER_PK, keccak256("rate-needmore-2"), 2_000_000, 2_000_000, 1);
        _chargeForSeller(sellerC, BUYER_PK, keccak256("rate-needmore-3"), 2_000_000, 2_000_000, 1);

        vm.expectRevert(AntseedEscrow.RatingNoInteraction.selector);
        vm.prank(buyer);
        escrow.rateSeller(sellerD, 80);

        vm.expectRevert(abi.encodeWithSelector(AntseedEscrow.RatingInsufficientSpend.selector, 500_000, 1_000_000));
        vm.prank(buyer);
        escrow.rateSeller(sellerA, 65);
    }

    function testRateSellerSuccessCooldownAndUpdate() public {
        _deposit(buyer, 40_000_000);
        _stake(sellerA, MIN_STAKE);
        _stake(sellerB, MIN_STAKE);
        _stake(sellerC, MIN_STAKE);

        _chargeForSeller(sellerA, BUYER_PK, keccak256("rate-success-1"), 2_000_000, 2_000_000, 1);
        _chargeForSeller(sellerB, BUYER_PK, keccak256("rate-success-2"), 2_000_000, 2_000_000, 1);
        _chargeForSeller(sellerC, BUYER_PK, keccak256("rate-success-3"), 2_000_000, 2_000_000, 1);

        vm.warp(block.timestamp + escrow.BUYER_AGE_REQUIREMENT());
        vm.prank(buyer);
        escrow.rateSeller(sellerA, 80);

        vm.expectRevert(abi.encodeWithSelector(
            AntseedEscrow.RatingCooldownActive.selector,
            block.timestamp + escrow.RATING_COOLDOWN()
        ));
        vm.prank(buyer);
        escrow.rateSeller(sellerA, 81);

        vm.warp(block.timestamp + escrow.RATING_COOLDOWN());
        vm.prank(buyer);
        escrow.rateSeller(sellerA, 90);

        AntseedEscrow.ReputationData memory rep = escrow.getReputation(sellerA);
        assertEq(rep.avgRating, 90);
        assertEq(rep.ratingCount, 1);
        assertEq(rep.stakedAmount, MIN_STAKE);
        assertEq(rep.totalTransactions, 1);
        assertEq(rep.totalVolume, 2_000_000);
        assertEq(rep.uniqueBuyersServed, 1);
        assertGt(rep.ageDays, 0);
    }

    function testCanRateAllGatesAndTruePath() public {
        assertEq(escrow.canRate(buyer, sellerA), false);

        _deposit(buyer, 50_000_000);
        _stake(sellerA, MIN_STAKE);
        _stake(sellerB, MIN_STAKE);
        _stake(sellerC, MIN_STAKE);

        _chargeForSeller(sellerA, BUYER_PK, keccak256("canrate-a"), 500_000, 500_000, 1);
        assertEq(escrow.canRate(buyer, sellerA), false); // age gate

        vm.warp(block.timestamp + escrow.BUYER_AGE_REQUIREMENT());
        assertEq(escrow.canRate(buyer, sellerA), false); // unique sellers gate

        _chargeForSeller(sellerB, BUYER_PK, keccak256("canrate-b"), 2_000_000, 2_000_000, 1);
        _chargeForSeller(sellerC, BUYER_PK, keccak256("canrate-c"), 2_000_000, 2_000_000, 1);

        assertEq(escrow.canRate(buyer, sellerD), false); // no interaction gate
        assertEq(escrow.canRate(buyer, sellerA), false); // min spend gate
        assertEq(escrow.canRate(buyer, sellerB), true);

        vm.prank(buyer);
        escrow.rateSeller(sellerB, 60);
        assertEq(escrow.canRate(buyer, sellerB), false); // cooldown gate

        vm.warp(block.timestamp + escrow.RATING_COOLDOWN());
        assertEq(escrow.canRate(buyer, sellerB), true);
    }

    function testGetReputationWithoutHistory() public {
        AntseedEscrow.ReputationData memory rep = escrow.getReputation(sellerA);
        assertEq(rep.avgRating, 0);
        assertEq(rep.ratingCount, 0);
        assertEq(rep.stakedAmount, 0);
        assertEq(rep.totalTransactions, 0);
        assertEq(rep.totalVolume, 0);
        assertEq(rep.uniqueBuyersServed, 0);
        assertEq(rep.ageDays, 0);
    }

    function _chargeForSeller(
        address seller,
        uint256 buyerKey,
        bytes32 sessionId,
        uint256 amount,
        uint256 maxAmount,
        uint256 nonce
    ) private {
        address payer = vm.addr(buyerKey);
        uint256 deadline = block.timestamp + 1 days;
        bytes memory sig = _signSpendingAuth(buyerKey, seller, sessionId, maxAmount, nonce, deadline, false);
        vm.prank(seller);
        escrow.charge(payer, amount, sessionId, maxAmount, nonce, deadline, sig);
    }

    function _signSpendingAuth(
        uint256 buyerKey,
        address seller,
        bytes32 sessionId,
        uint256 maxAmount,
        uint256 nonce,
        uint256 deadline,
        bool compactV
    ) private returns (bytes memory) {
        return _signSpendingAuthForEscrow(
            escrow,
            buyerKey,
            seller,
            sessionId,
            maxAmount,
            nonce,
            deadline,
            compactV
        );
    }

    function _signSpendingAuthForEscrow(
        AntseedEscrow targetEscrow,
        uint256 buyerKey,
        address seller,
        bytes32 sessionId,
        uint256 maxAmount,
        uint256 nonce,
        uint256 deadline,
        bool compactV
    ) private returns (bytes memory) {
        bytes32 structHash = keccak256(abi.encode(
            targetEscrow.SPENDING_AUTH_TYPEHASH(),
            seller,
            sessionId,
            maxAmount,
            nonce,
            deadline
        ));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", targetEscrow.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(buyerKey, digest);
        if (compactV && v >= 27) v -= 27;
        return abi.encodePacked(r, s, v);
    }

    function _deposit(address user, uint256 amount) private {
        vm.prank(user);
        escrow.deposit(amount);
    }

    function _stake(address seller, uint256 amount) private {
        vm.prank(seller);
        escrow.stake(amount);
    }

    function _mintAndApprove(address token, address user, uint256 amount) private {
        if (token == address(usdc)) {
            usdc.mint(user, amount);
            vm.prank(user);
            usdc.approve(address(escrow), type(uint256).max);
            return;
        }

        FalseReturnUSDC(token).mint(user, amount);
        vm.prank(user);
        FalseReturnUSDC(token).approve(address(escrow), type(uint256).max);
    }
}
