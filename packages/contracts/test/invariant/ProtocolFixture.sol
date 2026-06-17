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
 * @title ProtocolFixture
 * @notice Shared deploy + wire + actor setup for the protocol invariant suites. Mirrors
 *         script/Deploy.s.sol, registers/stakes sellers, registers buyers, sets buyer
 *         operators to the handler, seeds deposits, and targets the handler's action
 *         selectors. Custody and Channels-state-machine invariant tests both inherit this.
 */
abstract contract ProtocolFixture is Test {
    MockUSDC internal usdc;
    MockERC8004Registry internal identity;
    ANTSToken internal ants;
    AntseedRegistry internal registry;
    AntseedStaking internal staking;
    AntseedDeposits internal deposits;
    AntseedChannels internal channels;
    AntseedStats internal stats;
    AntseedEmissions internal emissions;

    ProtocolHandler internal handler;

    address internal protocolReserve = address(0xFEE);
    address internal teamWallet = address(0x7EA3);

    uint256 internal constant INITIAL_EMISSION = 5_000_000e18;
    uint256 internal constant EPOCH_DURATION = 7 days;
    uint256 internal constant STAKE_AMOUNT = 10_000_000; // MIN_SELLER_STAKE
    uint256 internal constant SEED_DEPOSIT = 50_000_000; // 50 USDC per buyer

    function setUp() public virtual {
        // ── Deploy (mirrors script/Deploy.s.sol) ─────────────────────────
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

        channels.setFirstSignCap(100_000_000);

        // ── Handler + actors ──────────────────────────────────────────────
        handler = new ProtocolHandler(channels, deposits, emissions, usdc, true);
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

            deposits.setCreditLimitOverride(b, type(uint256).max);

            uint256 nonce = deposits.getOperatorNonce(b);
            bytes32 structHash = keccak256(abi.encode(deposits.SET_OPERATOR_TYPEHASH(), address(handler), nonce));
            bytes32 digest = keccak256(abi.encodePacked("\x19\x01", deposits.domainSeparator(), structHash));
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
            deposits.setOperator(b, address(handler), nonce, abi.encodePacked(r, s, v));

            usdc.mint(address(this), SEED_DEPOSIT);
            usdc.approve(address(deposits), SEED_DEPOSIT);
            deposits.deposit(b, SEED_DEPOSIT);
        }
    }
}
