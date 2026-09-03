// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

import { ANTSToken } from "../../core/ANTSToken.sol";
import { AntseedRegistry } from "../../core/AntseedRegistry.sol";
import { AntseedEmissions } from "../../legacy/AntseedEmissions.sol";
import { AntseedEmissionsV2 } from "../../legacy/AntseedEmissionsV2.sol";
import { AntseedSellerRewardsPool } from "../../rewards/AntseedSellerRewardsPool.sol";
import { AntseedLegacySellerClaimPolicy } from "../../policies/AntseedLegacySellerClaimPolicy.sol";
import { M002DeployLegacySellerClaims } from "../../script/migrations/M002LegacySellerClaims/Deploy.s.sol";

contract MockGateForM002 {
    uint256 public effectiveEpoch;

    constructor(uint256 effectiveEpoch_) {
        effectiveEpoch = effectiveEpoch_;
    }
}

contract MockUsageAccountingForM002 {
    address public emissionsGate;

    constructor(address gate) {
        emissionsGate = gate;
    }
}

contract MockDepositsForM002 {
    function getOperator(address buyer) external pure returns (address) {
        return buyer;
    }
}

/// @dev Runs the real M002 Foundry script against a locally deployed legacy stack.
contract M002LegacySellerClaimsTest is Test {
    uint256 constant INITIAL_EMISSION = 1000 ether;
    uint256 constant EPOCH_DURATION = 1 weeks;
    uint256 constant POOL_OWNER_KEY = 0xA11CE;

    ANTSToken token;
    AntseedRegistry registry;
    AntseedEmissions legacy;
    AntseedEmissionsV2 v2;
    AntseedSellerRewardsPool pool;
    MockUsageAccountingForM002 usageAccounting;

    address poolOwner = vm.addr(POOL_OWNER_KEY);
    address seller = address(0x10);
    address newEmissions = address(0x2001);

    function setUp() public {
        vm.warp(1_700_000_000);

        token = new ANTSToken();
        registry = new AntseedRegistry();
        registry.setChannels(address(this));
        registry.setDeposits(address(new MockDepositsForM002()));
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
        vm.warp(legacy.genesis() + EPOCH_DURATION * 6 + 1);
        uint256[] memory epochs = new uint256[](1);
        epochs[0] = 4;
        vm.prank(seller);
        v2.claimSellerEmissions(epochs);
        assertGt(pool.lockedRewards(seller), 0);

        // Simulate the M001 flip: gate effective at epoch 6, registry now points elsewhere.
        usageAccounting = new MockUsageAccountingForM002(address(new MockGateForM002(6)));
    }

    function _config() internal view returns (M002DeployLegacySellerClaims.Config memory) {
        return M002DeployLegacySellerClaims.Config({
            poolOwnerPrivateKey: POOL_OWNER_KEY,
            registry: address(registry),
            legacyEmissionsV2: address(v2),
            usageAccounting: address(usageAccounting),
            lastEpochOverride: 0,
            releaseBps: 1538,
            vestStart: 0,
            vestEpochs: 0,
            washTradingRegistry: address(0)
        });
    }

    function test_refusesBeforeCutoverFlip() public {
        M002DeployLegacySellerClaims script = new M002DeployLegacySellerClaims();
        vm.expectRevert("M001 cutover has not flipped registry.emissions() yet");
        script.runWith(_config());
    }

    function test_installsPolicyAndSellerCanClaim() public {
        registry.setEmissions(newEmissions);

        M002DeployLegacySellerClaims script = new M002DeployLegacySellerClaims();
        script.runWith(_config());

        AntseedLegacySellerClaimPolicy policy = AntseedLegacySellerClaimPolicy(address(pool.sellerClaimPolicy()));
        assertTrue(address(policy) != address(0));
        assertEq(policy.owner(), poolOwner);
        assertEq(policy.lastEpoch(), 5);
        assertEq(policy.releaseBps(), 1538);
        assertEq(policy.vestEpochs(), 0);
        assertEq(address(policy.washTradingRegistry()), address(0), "no wash registry");

        uint256 locked = pool.lockedRewards(seller);
        uint256 expected = (locked * 1538) / 10_000;
        vm.prank(seller);
        pool.claim(seller);
        assertEq(token.balanceOf(seller), expected);
    }

    function test_idempotentWhenPolicyAlreadySet() public {
        registry.setEmissions(newEmissions);
        M002DeployLegacySellerClaims script = new M002DeployLegacySellerClaims();
        script.runWith(_config());
        address first = address(pool.sellerClaimPolicy());
        assertEq(script.runWith(_config()), first, "second run returns existing policy");
        assertEq(address(pool.sellerClaimPolicy()), first, "second run must not replace the policy");
    }

    function test_rejectsWrongPoolOwner() public {
        registry.setEmissions(newEmissions);
        vm.prank(poolOwner);
        pool.transferOwnership(address(0xB0B));
        M002DeployLegacySellerClaims script = new M002DeployLegacySellerClaims();
        vm.expectRevert("SELLER_REWARDS_POOL_OWNER_PRIVATE_KEY is not the pool owner");
        script.runWith(_config());
    }

    function test_rejectsLastEpochOverrideAtOrAfterEffective() public {
        registry.setEmissions(newEmissions);
        M002DeployLegacySellerClaims.Config memory cfg = _config();
        cfg.lastEpochOverride = 6;
        M002DeployLegacySellerClaims script = new M002DeployLegacySellerClaims();
        vm.expectRevert("LAST_LOCKED_EPOCH must precede the gate's effective epoch");
        script.runWith(cfg);
    }

    function test_rejectsLastEpochBeforeMigration() public {
        registry.setEmissions(newEmissions);
        // Effective epoch below the V2 migration epoch means lastEpoch (= effective - 1) precedes migration.
        usageAccounting = new MockUsageAccountingForM002(address(new MockGateForM002(4)));
        M002DeployLegacySellerClaims script = new M002DeployLegacySellerClaims();
        vm.expectRevert("LAST_LOCKED_EPOCH precedes the V2 migration epoch");
        script.runWith(_config());
    }
}
