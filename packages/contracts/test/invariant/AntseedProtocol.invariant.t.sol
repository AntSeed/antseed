// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

import {AntseedChannels} from "../../AntseedChannels.sol";
import {AntseedDeposits} from "../../AntseedDeposits.sol";
import {AntseedEmissions} from "../../AntseedEmissions.sol";
import {AntseedStaking} from "../../AntseedStaking.sol";
import {AntseedStats} from "../../AntseedStats.sol";
import {AntseedRegistry} from "../../AntseedRegistry.sol";
import {ANTSToken} from "../../ANTSToken.sol";
import {MockUSDC} from "../../MockUSDC.sol";
import {MockERC8004Registry} from "../../MockERC8004Registry.sol";

import {ProtocolHandler} from "./ProtocolHandler.sol";

/**
 * @title AntseedProtocolInvariants
 * @notice Stateful invariant suite over the live-mainnet payment core:
 *         AntseedDeposits (custody) ↔ AntseedChannels (lifecycle) ↔ AntseedEmissions (points).
 *
 *         Deployment hierarchy mirrors script/Deploy.s.sol:
 *           USDC → ERC8004 identity → ANTSToken → AntseedRegistry → Staking →
 *           Deposits → Channels → Stats → Emissions, then registry wiring +
 *           Stats writer authorization.
 *
 *         These invariants encode the protocol's *custody & conservation* guarantees, which
 *         hold regardless of the economic/reputation findings from the audit (wash-trading,
 *         slashing evasion, migration double-claim do NOT move custody or break point
 *         conservation — they would need dedicated economic property tests, noted at bottom).
 */
contract AntseedProtocolInvariants is Test {
    MockUSDC usdc;
    MockERC8004Registry identity;
    ANTSToken ants;
    AntseedRegistry registry;
    AntseedStaking staking;
    AntseedDeposits deposits;
    AntseedChannels channels;
    AntseedStats stats;
    AntseedEmissions emissions;

    ProtocolHandler handler;

    address protocolReserve = address(0xFEE);
    address teamWallet = address(0x7EA3);

    uint256 constant INITIAL_EMISSION = 5_000_000e18;
    uint256 constant EPOCH_DURATION = 7 days;
    uint256 constant STAKE_AMOUNT = 10_000_000; // MIN_SELLER_STAKE
    uint256 constant SEED_DEPOSIT = 50_000_000; // 50 USDC per buyer

    function setUp() public {
        // ── Deploy ────────────────────────────────────────────────────────
        usdc = new MockUSDC();
        identity = new MockERC8004Registry();
        ants = new ANTSToken();
        registry = new AntseedRegistry();
        staking = new AntseedStaking(address(usdc), address(registry));
        deposits = new AntseedDeposits(address(usdc));
        channels = new AntseedChannels(address(registry));
        stats = new AntseedStats();
        emissions = new AntseedEmissions(address(registry), INITIAL_EMISSION, EPOCH_DURATION);

        // ── Wire registry ─────────────────────────────────────────────────
        registry.setChannels(address(channels));
        registry.setDeposits(address(deposits));
        registry.setStaking(address(staking));
        registry.setStats(address(stats));
        registry.setEmissions(address(emissions));
        registry.setAntsToken(address(ants));
        registry.setIdentityRegistry(address(identity));
        registry.setProtocolReserve(protocolReserve);
        registry.setTeamWallet(teamWallet);

        deposits.setRegistry(address(registry));
        ants.setRegistry(address(registry));
        stats.setWriter(address(channels), true);

        // Raise the first-sign cap so reserves up to a full seed deposit are allowed.
        channels.setFirstSignCap(100_000_000);

        // ── Handler ───────────────────────────────────────────────────────
        handler = new ProtocolHandler(channels, deposits, emissions, usdc, true);

        // ── Register + stake sellers, register buyers, set operators ──────
        _setUpSellers();
        _setUpBuyers();

        // ── Target the handler's action selectors only ───────────────────
        bytes4[] memory selectors = new bytes4[](12);
        selectors[0] = handler.deposit.selector;
        selectors[1] = handler.withdrawDeposit.selector;
        selectors[2] = handler.reserve.selector;
        selectors[3] = handler.settle.selector;
        selectors[4] = handler.topUp.selector;
        selectors[5] = handler.close.selector;
        selectors[6] = handler.requestClose.selector;
        selectors[7] = handler.withdrawChannel.selector;
        selectors[8] = handler.claimSeller.selector;
        selectors[9] = handler.claimBuyer.selector;
        selectors[10] = handler.warp.selector;
        selectors[11] = handler.deposit.selector; // weight deposits a bit higher for liveness

        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    function _setUpSellers() internal {
        for (uint256 i = 0; i < handler.sellerCount(); i++) {
            uint256 pk = handler.sellerPks(i);
            address s = vm.addr(pk);
            vm.prank(s);
            uint256 agentId = identity.register();
            usdc.mint(s, STAKE_AMOUNT);
            vm.startPrank(s);
            usdc.approve(address(staking), STAKE_AMOUNT);
            staking.stake(agentId, STAKE_AMOUNT);
            vm.stopPrank();
        }
    }

    function _setUpBuyers() internal {
        for (uint256 i = 0; i < handler.buyerCount(); i++) {
            uint256 pk = handler.buyerPks(i);
            address b = vm.addr(pk);

            vm.prank(b);
            identity.register();

            // Remove credit-limit friction so fuzzing exercises the channel logic.
            deposits.setCreditLimitOverride(b, type(uint256).max);

            // Operator = handler, so the handler can drive withdraw/requestClose/claimBuyer.
            uint256 nonce = deposits.getOperatorNonce(b);
            bytes32 structHash =
                keccak256(abi.encode(deposits.SET_OPERATOR_TYPEHASH(), address(handler), nonce));
            bytes32 digest = keccak256(abi.encodePacked("\x19\x01", deposits.domainSeparator(), structHash));
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
            deposits.setOperator(b, address(handler), nonce, abi.encodePacked(r, s, v));

            // Seed an initial deposit so reserves can happen from run 1.
            usdc.mint(address(this), SEED_DEPOSIT);
            usdc.approve(address(deposits), SEED_DEPOSIT);
            deposits.deposit(b, SEED_DEPOSIT);
        }
    }

    // ═════════════════════════════════════════════════════════════════════
    //                  CUSTODY INVARIANTS (AntseedDeposits)
    // ═════════════════════════════════════════════════════════════════════

    /// @notice Deposits holds exactly the sum of all buyer balances — no USDC leaks or appears.
    function invariant_depositsSolvent() public view {
        uint256 sumBalances;
        for (uint256 i = 0; i < handler.buyerCount(); i++) {
            (uint256 balance,,,,,) = deposits.buyers(handler.buyerAt(i));
            sumBalances += balance;
        }
        assertEq(usdc.balanceOf(address(deposits)), sumBalances, "deposits insolvent");
    }

    /// @notice Reserved never exceeds balance for any buyer (custody can't over-lock).
    function invariant_reservedLeqBalance() public view {
        for (uint256 i = 0; i < handler.buyerCount(); i++) {
            (uint256 balance, uint256 reserved,,,,) = deposits.buyers(handler.buyerAt(i));
            assertLe(reserved, balance, "reserved exceeds balance");
        }
    }

    /// @notice Global reserved per buyer equals Σ(active channel deposit − settled).
    function invariant_reservedMatchesChannels() public view {
        for (uint256 i = 0; i < handler.buyerCount(); i++) {
            address b = handler.buyerAt(i);
            (, uint256 reserved,,,,) = deposits.buyers(b);
            assertEq(reserved, handler.expectedReservedOf(b), "reserved != sum of channel locks");
        }
    }

    /// @notice The swappable Channels contract never custodies USDC.
    function invariant_channelsHoldNoUsdc() public view {
        assertEq(usdc.balanceOf(address(channels)), 0, "channels holds USDC");
    }

    /// @notice Full USDC conservation across Deposits: held + paid-out = total deposited.
    function invariant_usdcConservation() public view {
        uint256 held = usdc.balanceOf(address(deposits));
        uint256 paidOut = handler.ghostWithdrawn() + handler.ghostToSellers() + handler.ghostToReserve();
        // Seed deposits (done in setUp) are not in ghostDeposited, so account for them.
        uint256 seeded = SEED_DEPOSIT * handler.buyerCount();
        assertEq(held + paidOut, handler.ghostDeposited() + seeded, "USDC not conserved");
    }

    // ═════════════════════════════════════════════════════════════════════
    //                  EMISSIONS INVARIANTS (AntseedEmissions)
    // ═════════════════════════════════════════════════════════════════════

    /// @notice Per epoch, the recorded total seller/buyer points equal the sum over all actors.
    function invariant_pointsConserved() public view {
        uint256 cur = emissions.currentEpoch();
        for (uint256 e = 0; e <= cur; e++) {
            uint256 sumSeller;
            for (uint256 i = 0; i < handler.sellerCount(); i++) {
                sumSeller += emissions.userSellerPoints(handler.sellerAt(i), e);
            }
            assertEq(emissions.epochTotalSellerPoints(e), sumSeller, "seller points not conserved");

            uint256 sumBuyer;
            for (uint256 i = 0; i < handler.buyerCount(); i++) {
                sumBuyer += emissions.userBuyerPoints(handler.buyerAt(i), e);
            }
            assertEq(emissions.epochTotalBuyerPoints(e), sumBuyer, "buyer points not conserved");
        }
    }

    /// @notice Minted ANTS never exceeds the hard cap.
    function invariant_antsWithinMaxSupply() public view {
        assertLe(ants.totalSupply(), ants.MAX_SUPPLY(), "ANTS over max supply");
    }

    // NOTE — economic findings from the 2026-06-16 audit are intentionally NOT encoded here as
    // invariants because they don't violate custody or conservation:
    //   • self-deal emissions wash-trading — points stay conserved; needs a fairness property.
    //   • close() slashing-evasion — channelCount vs ghostCount; needs a reputation property.
    //   • migration-epoch double-claim — requires a V1+V2 two-contract harness.
    // These belong in a dedicated economic-properties suite (follow-up).
}
