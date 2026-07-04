// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

import {AntseedChannels} from "../../payments/AntseedChannels.sol";
import {AntseedDeposits} from "../../payments/AntseedDeposits.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";

/**
 * @title ProtocolHandler
 * @notice Stateful fuzzing handler that drives the AntseedChannels ↔ AntseedDeposits ↔
 *         payment lifecycle (reserve/settle/topUp/close/withdraw) with a small fixed set of
 *         buyers/sellers. Emissions is left unwired by the fixture, so accrual is skipped.
 *
 *         The invariant test (AntseedProtocol.invariant.t.sol) deploys + wires the protocol,
 *         registers/stakes the actors, sets buyer operators to this handler, then targets the
 *         action functions below. Every protocol call is wrapped in try/catch so reverts on
 *         invalid (but reachable) inputs are treated as no-ops rather than fuzzer failures.
 *
 *         The handler mirrors per-channel (deposit, settled, active) so the test can assert
 *         the custody invariant `reserved == Σ(active channel deposit − settled)` without
 *         reaching into the contract's private channel storage.
 */
contract ProtocolHandler is Test {
    AntseedChannels public channels;
    AntseedDeposits public deposits;
    MockUSDC public usdc;
    bool public protocolReserveSet;

    bytes32 constant SPENDING_AUTH_TYPEHASH =
        keccak256("SpendingAuth(bytes32 channelId,uint256 cumulativeAmount,bytes32 metadataHash)");
    bytes32 constant RESERVE_AUTH_TYPEHASH =
        keccak256("ReserveAuth(bytes32 channelId,uint128 maxAmount,uint256 deadline)");

    // ── Actors (deterministic keys) ──────────────────────────────────────
    uint256[2] public buyerPks = [uint256(0xB001), uint256(0xB002)];
    uint256[2] public sellerPks = [uint256(0x5001), uint256(0x5002)];

    // ── Mirrored channel state ───────────────────────────────────────────
    struct Chan {
        bytes32 id;
        uint256 buyerPk;
        uint256 sellerPk;
        uint128 deposit;
        uint128 settled;
        bool active;
    }

    Chan[] public chans;
    uint256 public saltNonce;

    // ── Ghost accounting (USDC conservation cross-checks) ────────────────
    uint256 public ghostDeposited; // USDC pulled into Deposits via deposit()
    uint256 public ghostWithdrawn; // USDC sent out via Deposits.withdraw()
    uint256 public ghostToSellers; // USDC paid to sellers on settle/close
    uint256 public ghostToReserve; // USDC paid to protocol reserve as fee

    constructor(AntseedChannels _channels, AntseedDeposits _deposits, MockUSDC _usdc, bool _protocolReserveSet) {
        channels = _channels;
        deposits = _deposits;
        usdc = _usdc;
        protocolReserveSet = _protocolReserveSet;
    }

    // ── Views used by invariants ─────────────────────────────────────────
    function buyerAt(uint256 i) external view returns (address) {
        return vm.addr(buyerPks[i % buyerPks.length]);
    }

    function sellerAt(uint256 i) external view returns (address) {
        return vm.addr(sellerPks[i % sellerPks.length]);
    }

    function buyerCount() external pure returns (uint256) {
        return 2;
    }

    function sellerCount() external pure returns (uint256) {
        return 2;
    }

    /// @notice Number of channels ever opened (active or terminal), for enumeration in invariants.
    function chanCount() external view returns (uint256) {
        return chans.length;
    }

    /// @notice Expected reserved balance for a buyer = Σ over active channels of (deposit − settled).
    function expectedReservedOf(address buyer) external view returns (uint256 total) {
        for (uint256 i = 0; i < chans.length; i++) {
            Chan storage c = chans[i];
            if (c.active && vm.addr(c.buyerPk) == buyer) {
                total += uint256(c.deposit) - uint256(c.settled);
            }
        }
    }

    // ═════════════════════════════════════════════════════════════════════
    //                              ACTIONS
    // ═════════════════════════════════════════════════════════════════════

    function deposit(uint256 buyerSeed, uint128 amount) external {
        address b = vm.addr(buyerPks[buyerSeed % buyerPks.length]);
        amount = uint128(bound(amount, 1_000_000, 100_000_000));
        usdc.mint(address(this), amount);
        usdc.approve(address(deposits), amount);
        try deposits.deposit(b, amount) {
            ghostDeposited += amount;
        } catch {}
    }

    function withdrawDeposit(uint256 buyerSeed, uint128 amount) external {
        address b = vm.addr(buyerPks[buyerSeed % buyerPks.length]);
        (uint256 avail,,) = deposits.getBuyerBalance(b);
        if (avail == 0) return;
        amount = uint128(bound(amount, 1, avail));
        // operator == this handler, so it can withdraw; USDC lands here.
        try deposits.withdraw(b, amount) {
            ghostWithdrawn += amount;
        } catch {}
    }

    function reserve(uint256 buyerSeed, uint256 sellerSeed, uint128 amount) external {
        uint256 bpk = buyerPks[buyerSeed % buyerPks.length];
        uint256 spk = sellerPks[sellerSeed % sellerPks.length];
        address b = vm.addr(bpk);
        address s = vm.addr(spk);

        (uint256 avail,,) = deposits.getBuyerBalance(b);
        uint256 cap = channels.FIRST_SIGN_CAP();
        uint256 hi = avail < cap ? avail : cap;
        if (hi == 0) return;
        amount = uint128(bound(amount, 1, hi));

        bytes32 salt = keccak256(abi.encode(saltNonce++, b, s));
        bytes32 id = channels.computeChannelId(b, s, salt);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signReserve(bpk, id, amount, deadline);

        vm.prank(s);
        try channels.reserve(b, salt, amount, deadline, sig) {
            chans.push(Chan({id: id, buyerPk: bpk, sellerPk: spk, deposit: amount, settled: 0, active: true}));
        } catch {}
    }

    function settle(uint256 chanSeed, uint128 cumSeed) external {
        if (chans.length == 0) return;
        Chan storage c = chans[chanSeed % chans.length];
        if (!c.active || c.deposit <= c.settled) return;

        uint128 cum = uint128(bound(cumSeed, uint256(c.settled) + 1, c.deposit));
        bytes memory meta = _meta();
        bytes memory sig = _signSpend(c.buyerPk, c.id, cum);
        uint128 delta = cum - c.settled;
        address s = vm.addr(c.sellerPk);

        vm.prank(s);
        try channels.settle(c.id, cum, meta, sig) {
            c.settled = cum;
            _accountSettle(delta);
        } catch {}
    }

    function topUp(uint256 chanSeed, uint128 cumSeed, uint128 addSeed) external {
        if (chans.length == 0) return;
        Chan storage c = chans[chanSeed % chans.length];
        if (!c.active) return;

        // settle ≥85% of current deposit so the threshold passes
        uint256 threshold = (uint256(c.deposit) * channels.TOP_UP_SETTLED_THRESHOLD_BPS()) / 10000;
        uint128 cum = uint128(bound(cumSeed, threshold, c.deposit));
        if (cum <= c.settled) return;

        address b = vm.addr(c.buyerPk);
        (uint256 avail,,) = deposits.getBuyerBalance(b);
        if (avail == 0) return;
        uint128 add = uint128(bound(addSeed, 1, avail));
        uint128 newMax = c.deposit + add;

        uint256 deadline = block.timestamp + 1 hours;
        bytes memory meta = _meta();
        bytes memory spendSig = _signSpend(c.buyerPk, c.id, cum);
        bytes memory reserveSig = _signReserve(c.buyerPk, c.id, newMax, deadline);
        uint128 delta = cum - c.settled;
        address s = vm.addr(c.sellerPk);

        vm.prank(s);
        try channels.topUp(c.id, cum, meta, spendSig, newMax, deadline, reserveSig) {
            c.settled = cum;
            c.deposit = newMax;
            _accountSettle(delta);
        } catch {}
    }

    function close(uint256 chanSeed, uint128 finalSeed, bool closeAtSettled) external {
        if (chans.length == 0) return;
        Chan storage c = chans[chanSeed % chans.length];
        if (!c.active) return;

        uint128 finalAmount = closeAtSettled ? c.settled : uint128(bound(finalSeed, c.settled, c.deposit));
        bytes memory meta = _meta();
        bytes memory sig = finalAmount > c.settled ? _signSpend(c.buyerPk, c.id, finalAmount) : bytes("");
        uint128 delta = finalAmount - c.settled;
        address s = vm.addr(c.sellerPk);

        vm.prank(s);
        try channels.close(c.id, finalAmount, meta, sig) {
            c.settled = finalAmount;
            c.active = false;
            if (delta > 0) _accountSettle(delta);
        } catch {}
    }

    function requestClose(uint256 chanSeed) external {
        if (chans.length == 0) return;
        Chan storage c = chans[chanSeed % chans.length];
        if (!c.active) return;
        // operator == this handler
        try channels.requestClose(c.id) {} catch {}
    }

    function withdrawChannel(uint256 chanSeed) external {
        if (chans.length == 0) return;
        Chan storage c = chans[chanSeed % chans.length];
        if (!c.active) return;
        try channels.withdraw(c.id) {
            c.active = false;
        } catch {}
    }

    function warp(uint256 secs) external {
        secs = bound(secs, 1 hours, 21 days);
        vm.warp(block.timestamp + secs);
    }

    // ═════════════════════════════════════════════════════════════════════
    //                              INTERNAL
    // ═════════════════════════════════════════════════════════════════════

    function _accountSettle(uint128 delta) internal {
        uint256 fee = (uint256(delta) * channels.PLATFORM_FEE_BPS()) / 10000;
        if (!protocolReserveSet) fee = 0;
        ghostToReserve += fee;
        ghostToSellers += uint256(delta) - fee;
    }

    function _meta() internal pure returns (bytes memory) {
        return abi.encode(uint256(1), uint256(0), uint256(0), uint256(0));
    }

    function _signReserve(uint256 pk, bytes32 id, uint128 maxAmount, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        bytes32 structHash = keccak256(abi.encode(RESERVE_AUTH_TYPEHASH, id, maxAmount, deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", channels.domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _signSpend(uint256 pk, bytes32 id, uint256 cum) internal view returns (bytes memory) {
        bytes32 metadataHash = keccak256(_meta());
        bytes32 structHash = keccak256(abi.encode(SPENDING_AUTH_TYPEHASH, id, cum, metadataHash));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", channels.domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }
}
