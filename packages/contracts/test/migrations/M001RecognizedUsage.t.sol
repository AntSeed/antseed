// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

import { AntseedRegistry } from "../../core/AntseedRegistry.sol";
import { AntseedEmissionsGate } from "../../emissions/AntseedEmissionsGate.sol";
import { AntseedPointsPolicyRegistry } from "../../policies/AntseedPointsPolicyRegistry.sol";
import { ANTSToken } from "../../core/ANTSToken.sol";
import { AntseedEmissions } from "../../legacy/AntseedEmissions.sol";
import { AntseedEmissionsV2 } from "../../legacy/AntseedEmissionsV2.sol";
import { AntseedSellerRewardsPool } from "../../rewards/AntseedSellerRewardsPool.sol";
import { AntseedLegacySellerClaimPolicy } from "../../policies/AntseedLegacySellerClaimPolicy.sol";
import { M001CutoverRecognizedUsage } from "../../script/migrations/M001RecognizedUsage/Cutover.s.sol";

contract M001RecognizedUsageTest is Test {
    AntseedRegistry internal registry;

    address internal constant LEGACY_EMISSIONS = address(0x1001);
    address internal constant LEGACY_STAKING = address(0x1002);
    address internal constant USAGE_ACCOUNTING = address(0x2001);
    address internal constant SELLER_REGISTRY = address(0x2002);
    address internal constant VERIFICATION_WALLET = address(0x3001);
    bytes32 internal constant VERIFICATION_MINTER_ID = keccak256("antseed.emissions.verification.v1");

    function setUp() public {
        registry = new AntseedRegistry();
        registry.setEmissions(LEGACY_EMISSIONS);
        registry.setStaking(LEGACY_STAKING);
    }

    function test_cutoverStartingStateAcceptsLegacyAndCompletedPointers() public {
        _assertExpectedStartingState();

        registry.setEmissions(USAGE_ACCOUNTING);
        _assertExpectedStartingState();

        registry.setStaking(SELLER_REGISTRY);
        _assertExpectedStartingState();
    }

    function test_cutoverStartingStateRejectsUnknownEmissions() public {
        registry.setEmissions(address(0xDEAD));
        vm.expectRevert("unexpected emissions starting state");
        this.assertExpectedStartingState();
    }

    function test_cutoverStartingStateRejectsUnknownStaking() public {
        registry.setStaking(address(0xBEEF));
        vm.expectRevert("unexpected staking starting state");
        this.assertExpectedStartingState();
    }

    function test_m001LeavesVerificationConfigurationWithDeployer() public {
        AntseedEmissionsGate gate = new AntseedEmissionsGate(address(0x4001), address(0x4002), 15_000, 15_000);
        AntseedPointsPolicyRegistry pointsPolicyRegistry = new AntseedPointsPolicyRegistry(address(this));

        gate.setMinter(VERIFICATION_MINTER_ID, VERIFICATION_WALLET, 10_000, true);
        (address controller, uint32 shareBps, bool editable) = gate.minters(VERIFICATION_MINTER_ID);
        assertEq(controller, VERIFICATION_WALLET);
        assertEq(shareBps, 10_000);
        assertTrue(editable);
        assertEq(pointsPolicyRegistry.policyCount(), 0);
        assertEq(gate.owner(), address(this));
        assertEq(gate.pendingOwner(), address(0));
        assertEq(pointsPolicyRegistry.owner(), address(this));
        assertEq(pointsPolicyRegistry.pendingOwner(), address(0));
    }

    function assertExpectedStartingState() external view {
        _assertExpectedStartingState();
    }

    function _assertExpectedStartingState() internal view {
        address emissions = registry.emissions();
        require(emissions == LEGACY_EMISSIONS || emissions == USAGE_ACCOUNTING, "unexpected emissions starting state");

        address staking = registry.staking();
        require(staking == LEGACY_STAKING || staking == SELLER_REGISTRY, "unexpected staking starting state");
    }
}

// ═══════════════════════════════════════════════════════════════════════
//            Legacy seller claim policy install (cutover step)
// ═══════════════════════════════════════════════════════════════════════

contract MockDepositsForM001Claims {
    function getOperator(address buyer) external pure returns (address) {
        return buyer;
    }
}

contract MockWashRegistryForM001Claims {
    mapping(address => bool) public wash;

    function set(address seller, bool value) external {
        wash[seller] = value;
    }

    function isProvenWashTrader(address seller) external view returns (bool) {
        return wash[seller];
    }
}

/// @dev Exposes the cutover's pool step so it can be driven without the
///      rest of the recognized-usage stack.
contract CutoverClaimPolicyHarness is M001CutoverRecognizedUsage {
    function installSellerClaimPolicy(
        address legacyEmissions,
        uint256 effectiveEpoch,
        SellerClaimPolicyConfig memory cfg
    ) external {
        _installSellerClaimPolicy(legacyEmissions, effectiveEpoch, cfg);
    }

    function configFromEnv() external view returns (SellerClaimPolicyConfig memory) {
        return _sellerClaimPolicyConfigFromEnv();
    }
}

contract M001LegacySellerClaimPolicyInstallTest is Test {
    uint256 constant INITIAL_EMISSION = 1000 ether;
    uint256 constant EPOCH_DURATION = 1 weeks;

    ANTSToken token;
    AntseedRegistry registry;
    AntseedEmissions legacy;
    AntseedEmissionsV2 v2;
    AntseedSellerRewardsPool pool;
    MockWashRegistryForM001Claims washRegistry;
    CutoverClaimPolicyHarness harness;

    address poolOwner = address(0xA11CE);
    address seller = address(0x10);
    address washSeller = address(0x11);

    function setUp() public {
        vm.warp(1_700_000_000);

        token = new ANTSToken();
        registry = new AntseedRegistry();
        registry.setChannels(address(this));
        registry.setDeposits(address(new MockDepositsForM001Claims()));
        registry.setAntsToken(address(token));
        registry.setProtocolReserve(address(0x50));
        registry.setTeamWallet(address(0x51));

        legacy = new AntseedEmissions(address(registry), INITIAL_EMISSION, EPOCH_DURATION);
        registry.setEmissions(address(legacy));
        token.setRegistry(address(registry));

        vm.warp(legacy.genesis() + EPOCH_DURATION * 4 + 1);
        pool = new AntseedSellerRewardsPool(address(registry));
        pool.transferOwnership(poolOwner);
        v2 = new AntseedEmissionsV2(address(registry), address(legacy), address(pool));
        registry.setEmissions(address(v2));
        token.setTransferWhitelist(address(pool), true);

        v2.accrueSellerPoints(seller, 100);
        v2.accrueSellerPoints(washSeller, 100);
        vm.warp(legacy.genesis() + EPOCH_DURATION * 6 + 1);
        uint256[] memory epochs = new uint256[](1);
        epochs[0] = 4;
        vm.prank(seller);
        v2.claimSellerEmissions(epochs);
        vm.prank(washSeller);
        v2.claimSellerEmissions(epochs);
        assertGt(pool.lockedRewards(seller), 0);

        washRegistry = new MockWashRegistryForM001Claims();
        washRegistry.set(washSeller, true);

        harness = new CutoverClaimPolicyHarness();
    }

    function _cfg() internal view returns (M001CutoverRecognizedUsage.SellerClaimPolicyConfig memory) {
        return M001CutoverRecognizedUsage.SellerClaimPolicyConfig({
            poolOwner: poolOwner,
            releaseBps: 1538,
            vestStart: 0,
            vestEpochs: 0,
            washTradingRegistry: address(washRegistry)
        });
    }

    function _policy() internal view returns (AntseedLegacySellerClaimPolicy) {
        return AntseedLegacySellerClaimPolicy(address(pool.sellerClaimPolicy()));
    }

    function test_installsPolicyWithCutoverBounds() public {
        harness.installSellerClaimPolicy(address(v2), 6, _cfg());

        AntseedLegacySellerClaimPolicy policy = _policy();
        assertTrue(address(policy) != address(0), "policy installed");
        assertEq(policy.owner(), poolOwner, "pool owner owns the policy");
        assertEq(address(policy.v1()), address(legacy), "v1 derived from v2");
        assertEq(policy.lastEpoch(), 5, "last epoch = effective - 1");
        assertEq(policy.releaseBps(), 1538);
        assertEq(policy.vestEpochs(), 0);
        assertEq(address(policy.washTradingRegistry()), address(washRegistry), "wash registry wired");
    }

    function test_honestSellerClaimsReleasedShare_washTraderGetsNothing() public {
        harness.installSellerClaimPolicy(address(v2), 6, _cfg());

        uint256 locked = pool.lockedRewards(seller);
        vm.prank(seller);
        pool.claim(seller);
        assertEq(token.balanceOf(seller), (locked * 1538) / 10_000);

        vm.prank(washSeller);
        vm.expectRevert(AntseedSellerRewardsPool.NothingToClaim.selector);
        pool.claim(washSeller);
        assertEq(pool.lockedRewards(washSeller), locked, "wash trader's rewards stay locked");
    }

    function test_skipsWhenPolicyAlreadySet() public {
        harness.installSellerClaimPolicy(address(v2), 6, _cfg());
        address first = address(pool.sellerClaimPolicy());
        harness.installSellerClaimPolicy(address(v2), 6, _cfg());
        assertEq(address(pool.sellerClaimPolicy()), first, "rerun must not replace the policy");
    }

    function test_skipsWhenNoPoolOnLegacyEmissions() public {
        // A legacy emissions contract without sellerRewardsPool() (V1-only testnets) is a no-op.
        harness.installSellerClaimPolicy(address(legacy), 6, _cfg());
        assertEq(address(pool.sellerClaimPolicy()), address(0));
    }

    function test_rejectsWrongPoolOwner() public {
        M001CutoverRecognizedUsage.SellerClaimPolicyConfig memory cfg = _cfg();
        cfg.poolOwner = address(0xB0B);
        vm.expectRevert("SELLER_REWARDS_POOL_OWNER is not the pool owner");
        harness.installSellerClaimPolicy(address(v2), 6, cfg);
    }

    function test_rejectsMissingPoolOwner() public {
        M001CutoverRecognizedUsage.SellerClaimPolicyConfig memory cfg = _cfg();
        cfg.poolOwner = address(0);
        vm.expectRevert("SELLER_REWARDS_POOL_OWNER not set (pool needs a claim policy)");
        harness.installSellerClaimPolicy(address(v2), 6, cfg);
    }

    function test_rejectsEffectiveEpochAtOrBeforeMigration() public {
        vm.expectRevert("claim policy last epoch precedes the V2 migration epoch");
        harness.installSellerClaimPolicy(address(v2), 4, _cfg());
    }

    function test_rejectsWashRegistryWithoutCode() public {
        M001CutoverRecognizedUsage.SellerClaimPolicyConfig memory cfg = _cfg();
        cfg.washTradingRegistry = address(0xDEAD);
        vm.expectRevert("WASH_TRADING_REGISTRY has no code");
        harness.installSellerClaimPolicy(address(v2), 6, cfg);
    }

    function test_optionalVestAndRelease() public {
        M001CutoverRecognizedUsage.SellerClaimPolicyConfig memory cfg = _cfg();
        cfg.releaseBps = 5000;
        cfg.vestStart = 6;
        cfg.vestEpochs = 10;
        harness.installSellerClaimPolicy(address(v2), 6, cfg);
        AntseedLegacySellerClaimPolicy policy = _policy();
        assertEq(policy.releaseBps(), 5000);
        assertEq(policy.vestStart(), 6);
        assertEq(policy.vestEpochs(), 10);
    }

    function test_noWashRegistryLeavesOwnerFlagOnly() public {
        M001CutoverRecognizedUsage.SellerClaimPolicyConfig memory cfg = _cfg();
        cfg.washTradingRegistry = address(0);
        harness.installSellerClaimPolicy(address(v2), 6, cfg);
        AntseedLegacySellerClaimPolicy policy = _policy();
        assertEq(address(policy.washTradingRegistry()), address(0));
        assertFalse(policy.isWashTrader(washSeller), "registry not wired yet");
        vm.prank(poolOwner);
        policy.setSellerFlagged(washSeller, true);
        assertTrue(policy.isWashTrader(washSeller));
    }
}

/// @dev Single env-driven test kept in its own contract: vm.setEnv is
///      process-global, so it must not share a suite with other tests
///      that would race on the same variables.
contract M001LegacySellerClaimPolicyEnvTest is Test {
    function test_configFromEnv_defaultsAndNoOwnerFallback() public {
        CutoverClaimPolicyHarness harness = new CutoverClaimPolicyHarness();

        // The pool owner is never inferred from another role.
        vm.setEnv("SELLER_REWARDS_POOL_OWNER", "");
        vm.setEnv("DIEM_STAKER", vm.toString(address(0xA11CE)));
        vm.setEnv("RELEASE_BPS", "");
        vm.setEnv("VEST_START_EPOCH", "");
        vm.setEnv("VEST_EPOCHS", "");
        vm.setEnv("WASH_TRADING_REGISTRY", "");
        M001CutoverRecognizedUsage.SellerClaimPolicyConfig memory cfg = harness.configFromEnv();
        assertEq(cfg.poolOwner, address(0), "pool owner is not defaulted from the staker");
        assertEq(cfg.releaseBps, 1538);
        assertEq(cfg.vestStart, 0);
        assertEq(cfg.vestEpochs, 0);
        assertEq(cfg.washTradingRegistry, address(0));

        vm.setEnv("SELLER_REWARDS_POOL_OWNER", vm.toString(address(0xB0B)));
        vm.setEnv("RELEASE_BPS", "5000");
        vm.setEnv("VEST_START_EPOCH", "6");
        vm.setEnv("VEST_EPOCHS", "10");
        vm.setEnv("WASH_TRADING_REGISTRY", vm.toString(address(0xCAFE)));
        cfg = harness.configFromEnv();
        assertEq(cfg.poolOwner, address(0xB0B), "explicit pool owner address");
        assertEq(cfg.releaseBps, 5000);
        assertEq(cfg.vestStart, 6);
        assertEq(cfg.vestEpochs, 10);
        assertEq(cfg.washTradingRegistry, address(0xCAFE));

        vm.setEnv("SELLER_REWARDS_POOL_OWNER", "");
        vm.setEnv("DIEM_STAKER", "");
        vm.setEnv("RELEASE_BPS", "");
        vm.setEnv("VEST_START_EPOCH", "");
        vm.setEnv("VEST_EPOCHS", "");
        vm.setEnv("WASH_TRADING_REGISTRY", "");
    }
}
