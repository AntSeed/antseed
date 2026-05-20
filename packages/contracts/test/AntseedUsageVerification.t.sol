// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../AntseedRegistry.sol";
import "../AntseedUsageVerification.sol";

contract MockChannelsForUsageVerification {
    struct Channel {
        address buyer;
        address seller;
        uint128 deposit;
        uint128 settled;
        bytes32 metadataHash;
        uint256 deadline;
        uint256 settledAt;
        uint256 closeRequestedAt;
        uint8 status;
    }

    mapping(bytes32 => Channel) public channels;

    function setChannel(bytes32 channelId, address buyer, address seller, uint128 settled) external {
        channels[channelId] = Channel({
            buyer: buyer,
            seller: seller,
            deposit: settled,
            settled: settled,
            metadataHash: bytes32(0),
            deadline: block.timestamp + 1 days,
            settledAt: block.timestamp,
            closeRequestedAt: 0,
            status: 1
        });
    }
}

contract MockStakingForUsageVerification {
    mapping(address => uint256) public agentIds;

    function setAgentId(address seller, uint256 agentId) external {
        agentIds[seller] = agentId;
    }

    function getAgentId(address seller) external view returns (uint256) {
        return agentIds[seller];
    }

    function isStakedAboveMin(address) external pure returns (bool) {
        return true;
    }
}

contract AntseedUsageVerificationTest is Test {
    AntseedRegistry public registry;
    AntseedUsageVerification public usage;
    MockChannelsForUsageVerification public channels;
    MockStakingForUsageVerification public staking;

    uint256 buyerPk = 0xA11CE;
    uint256 sellerPk = 0xB0B;
    address buyer;
    address seller;
    uint256 agentId = 42;
    bytes32 channelId = keccak256("channel");
    bytes32 serviceKey = keccak256(abi.encode("openai", "gpt-4o-mini"));

    function setUp() public {
        buyer = vm.addr(buyerPk);
        seller = vm.addr(sellerPk);
        registry = new AntseedRegistry();
        channels = new MockChannelsForUsageVerification();
        staking = new MockStakingForUsageVerification();
        usage = new AntseedUsageVerification(address(registry), block.timestamp, 7 days);

        registry.setChannels(address(channels));
        registry.setStaking(address(staking));
        registry.setUsageVerification(address(usage));
        staking.setAgentId(seller, agentId);
        channels.setChannel(channelId, buyer, seller, 1000);
    }

    function test_commitAndReveal_recordsServiceScopedDeltas() public {
        IAntseedUsageVerification.UsageClaim memory claim = _claim(100, 25, 75, 40, 2, 900, 900);
        bytes32 buyerNonce = keccak256("buyer nonce");
        bytes32 sellerNonce = keccak256("seller nonce");
        bytes32 claimHash = usage.hashUsageClaim(claim);
        bytes32 buyerRevealHash = usage.revealHash(claimHash, buyerNonce);
        bytes32 sellerRevealHash = usage.revealHash(claimHash, sellerNonce);
        (bytes memory buyerSig, bytes memory sellerSig) = _signCommits(claimHash, buyerRevealHash, sellerRevealHash, usage.currentEpoch());

        usage.commitPair(AntseedUsageVerification.CommitPairInput({
            claimHash: claimHash,
            channelId: channelId,
            buyer: buyer,
            seller: seller,
            sellerAgentId: agentId,
            serviceKey: serviceKey,
            buyerRevealHash: buyerRevealHash,
            sellerRevealHash: sellerRevealHash,
            expectedEpoch: usage.currentEpoch(),
            buyerSig: buyerSig,
            sellerSig: sellerSig
        }));

        usage.revealPair(claim, buyerNonce, sellerNonce);

        IAntseedUsageVerification.UsageStats memory sellerStats = usage.getSellerServiceStats(agentId, serviceKey, 0);
        IAntseedUsageVerification.UsageStats memory buyerStats = usage.getBuyerServiceStats(buyer, serviceKey, 0);
        assertEq(sellerStats.inputTokens, 100);
        assertEq(sellerStats.cachedInputTokens, 25);
        assertEq(sellerStats.freshInputTokens, 75);
        assertEq(sellerStats.outputTokens, 40);
        assertEq(sellerStats.requestCount, 2);
        assertEq(sellerStats.costUsdc, 900);
        assertEq(sellerStats.attestationCount, 2);
        assertEq(buyerStats.inputTokens, 100);
    }

    function test_reveal_requiresPaymentCoverage() public {
        IAntseedUsageVerification.UsageClaim memory claim = _claim(100, 0, 100, 40, 2, 1200, 1200);
        bytes32 buyerNonce = keccak256("buyer nonce");
        bytes32 sellerNonce = keccak256("seller nonce");
        bytes32 claimHash = usage.hashUsageClaim(claim);
        bytes32 buyerRevealHash = usage.revealHash(claimHash, buyerNonce);
        bytes32 sellerRevealHash = usage.revealHash(claimHash, sellerNonce);
        (bytes memory buyerSig, bytes memory sellerSig) = _signCommits(claimHash, buyerRevealHash, sellerRevealHash, usage.currentEpoch());

        usage.commitPair(AntseedUsageVerification.CommitPairInput({
            claimHash: claimHash,
            channelId: channelId,
            buyer: buyer,
            seller: seller,
            sellerAgentId: agentId,
            serviceKey: serviceKey,
            buyerRevealHash: buyerRevealHash,
            sellerRevealHash: sellerRevealHash,
            expectedEpoch: usage.currentEpoch(),
            buyerSig: buyerSig,
            sellerSig: sellerSig
        }));

        vm.expectRevert(AntseedUsageVerification.PaymentNotCovered.selector);
        usage.revealPair(claim, buyerNonce, sellerNonce);
    }

    function test_commit_rejectsWrongEpoch() public {
        IAntseedUsageVerification.UsageClaim memory claim = _claim(1, 0, 1, 1, 1, 1, 1);
        bytes32 claimHash = usage.hashUsageClaim(claim);
        bytes32 buyerRevealHash = usage.revealHash(claimHash, keccak256("b"));
        bytes32 sellerRevealHash = usage.revealHash(claimHash, keccak256("s"));
        (bytes memory buyerSig, bytes memory sellerSig) = _signCommits(claimHash, buyerRevealHash, sellerRevealHash, 999);

        vm.expectRevert(AntseedUsageVerification.InvalidEpoch.selector);
        usage.commitPair(AntseedUsageVerification.CommitPairInput({
            claimHash: claimHash,
            channelId: channelId,
            buyer: buyer,
            seller: seller,
            sellerAgentId: agentId,
            serviceKey: serviceKey,
            buyerRevealHash: buyerRevealHash,
            sellerRevealHash: sellerRevealHash,
            expectedEpoch: 999,
            buyerSig: buyerSig,
            sellerSig: sellerSig
        }));
    }

    function _claim(
        uint256 inputTokens,
        uint256 cachedInputTokens,
        uint256 freshInputTokens,
        uint256 outputTokens,
        uint256 requestCount,
        uint256 costUsdc,
        uint256 paymentCumulativeAmount
    ) internal view returns (IAntseedUsageVerification.UsageClaim memory) {
        return IAntseedUsageVerification.UsageClaim({
            version: 1,
            channelId: channelId,
            buyer: buyer,
            seller: seller,
            sellerAgentId: agentId,
            serviceKey: serviceKey,
            providerName: "openai",
            serviceName: "gpt-4o-mini",
            cumulativeInputTokens: inputTokens,
            cumulativeCachedInputTokens: cachedInputTokens,
            cumulativeFreshInputTokens: freshInputTokens,
            cumulativeOutputTokens: outputTokens,
            cumulativeRequestCount: requestCount,
            cumulativeCostUsdc: costUsdc,
            paymentCumulativeAmount: paymentCumulativeAmount
        });
    }

    function _signCommits(bytes32 claimHash, bytes32 buyerRevealHash, bytes32 sellerRevealHash, uint256 epoch)
        internal
        view
        returns (bytes memory buyerSig, bytes memory sellerSig)
    {
        bytes32 buyerStructHash = keccak256(abi.encode(usage.USAGE_COMMIT_TYPEHASH(), claimHash, buyerRevealHash, epoch, usage.PARTY_BUYER()));
        bytes32 sellerStructHash = keccak256(abi.encode(usage.USAGE_COMMIT_TYPEHASH(), claimHash, sellerRevealHash, epoch, usage.PARTY_SELLER()));
        bytes32 buyerDigest = keccak256(abi.encodePacked("\x19\x01", usage.domainSeparator(), buyerStructHash));
        bytes32 sellerDigest = keccak256(abi.encodePacked("\x19\x01", usage.domainSeparator(), sellerStructHash));
        (uint8 bv, bytes32 br, bytes32 bs) = vm.sign(buyerPk, buyerDigest);
        (uint8 sv, bytes32 sr, bytes32 ss) = vm.sign(sellerPk, sellerDigest);
        buyerSig = abi.encodePacked(br, bs, bv);
        sellerSig = abi.encodePacked(sr, ss, sv);
    }
}
