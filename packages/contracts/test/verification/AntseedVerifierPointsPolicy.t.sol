// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";

import { AntseedVerifierPointsPolicy } from "../../verification/AntseedVerifierPointsPolicy.sol";

contract MockPointsPolicyRegistry {
    address public staking;

    /// @notice Sets the staking contract returned by the registry.
    function setStaking(address _staking) external {
        staking = _staking;
    }
}

contract MockPointsPolicyStaking {
    mapping(address seller => uint256 agentId) public getAgentId;

    /// @notice Links one seller address to one agent ID.
    function setAgentId(address seller, uint256 agentId) external {
        getAgentId[seller] = agentId;
    }
}

contract MockPointsPolicyVerifier {
    mapping(uint256 agentId => uint16 penaltyBps) public agentPointsPenaltyBps;

    /// @notice Sets the live seller-points discount for one agent.
    function setPenaltyBps(uint256 agentId, uint16 penaltyBps) external {
        agentPointsPenaltyBps[agentId] = penaltyBps;
    }
}

contract EmptyPointsPolicyTarget { }

contract AntseedVerifierPointsPolicyTest is Test {
    uint256 internal constant AGENT_ID = 42;
    uint256 internal constant RAW_POINTS = 1_000;

    address internal seller = address(0xA11CE);
    address internal buyer = address(0xB0B);

    MockPointsPolicyRegistry internal registry;
    MockPointsPolicyStaking internal staking;
    MockPointsPolicyVerifier internal verifier;
    AntseedVerifierPointsPolicy internal policy;

    function setUp() public {
        registry = new MockPointsPolicyRegistry();
        staking = new MockPointsPolicyStaking();
        verifier = new MockPointsPolicyVerifier();

        registry.setStaking(address(staking));
        staking.setAgentId(seller, AGENT_ID);

        policy = new AntseedVerifierPointsPolicy(address(registry), address(verifier));
    }

    /// @notice No DIFF discount keeps both point amounts unchanged.
    function test_noPenaltyPassesAllPointsThrough() public view {
        _assertPoints(RAW_POINTS, RAW_POINTS, RAW_POINTS);
    }

    /// @notice A 25% DIFF share removes 25% of seller points only.
    function test_proportionalPenaltyDiscountsSellerPoints() public {
        verifier.setPenaltyBps(AGENT_ID, 2_500);
        _assertPoints(RAW_POINTS, 750, RAW_POINTS);
    }

    /// @notice The discount stays active until the verifier clears it.
    function test_penaltyStaysActiveUntilCleared() public {
        verifier.setPenaltyBps(AGENT_ID, 2_500);
        _assertPoints(RAW_POINTS, 750, RAW_POINTS);

        verifier.setPenaltyBps(AGENT_ID, 0);
        _assertPoints(RAW_POINTS, RAW_POINTS, RAW_POINTS);
    }

    /// @notice A full DIFF discount removes all seller points.
    function test_fullPenaltyZeroesSellerPoints() public {
        verifier.setPenaltyBps(AGENT_ID, 10_000);
        _assertPoints(RAW_POINTS, 0, RAW_POINTS);
    }

    /// @notice A seller without an agent link is not discounted.
    function test_unknownSellerPassesAllPointsThrough() public view {
        (uint256 sellerPoints, uint256 buyerPoints) = policy.points(bytes32(0), buyer, address(0xCAFE), RAW_POINTS);
        assertEq(sellerPoints, RAW_POINTS);
        assertEq(buyerPoints, RAW_POINTS);
    }

    /// @notice Broken verifier reads do not block settlement or remove points.
    function test_brokenVerifierPassesAllPointsThrough() public {
        AntseedVerifierPointsPolicy brokenPolicy =
            new AntseedVerifierPointsPolicy(address(registry), address(new EmptyPointsPolicyTarget()));

        (uint256 sellerPoints, uint256 buyerPoints) = brokenPolicy.points(bytes32(0), buyer, seller, RAW_POINTS);
        assertEq(sellerPoints, RAW_POINTS);
        assertEq(buyerPoints, RAW_POINTS);
    }

    /// @notice The discount math works for the largest possible point value.
    function test_extremePointsDoNotOverflow() public {
        verifier.setPenaltyBps(AGENT_ID, 2_500);
        uint256 rawPoints = type(uint256).max;
        uint256 expectedSellerPoints = (rawPoints / 10_000) * 7_500 + ((rawPoints % 10_000) * 7_500) / 10_000;

        _assertPoints(rawPoints, expectedSellerPoints, rawPoints);
    }

    /// @notice The constructor rejects missing contract addresses.
    function test_constructorRejectsZeroAddress() public {
        vm.expectRevert(AntseedVerifierPointsPolicy.InvalidAddress.selector);
        new AntseedVerifierPointsPolicy(address(0), address(verifier));
    }

    /// @notice Checks the two point amounts returned by the policy.
    function _assertPoints(uint256 rawPoints, uint256 expectedSellerPoints, uint256 expectedBuyerPoints)
        internal
        view
    {
        (uint256 sellerPoints, uint256 buyerPoints) = policy.points(bytes32(0), buyer, seller, rawPoints);
        assertEq(sellerPoints, expectedSellerPoints);
        assertEq(buyerPoints, expectedBuyerPoints);
    }
}
