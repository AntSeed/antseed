// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { DiemStakingProxy } from "../DiemStakingProxy.sol";
import { IAntseedRegistry } from "../interfaces/IAntseedRegistry.sol";

interface IERC8004RegisterAndTransfer {
    function register(string calldata uri) external returns (uint256 agentId);
    function transferFrom(address from, address to, uint256 tokenId) external;
}

interface IAntseedStakingForDiemProxyDeploy {
    function stakeFor(address seller, uint256 agentId, uint256 amount) external;
}

/**
 * @title DeployDiemStakingProxy
 * @notice Deploys DiemStakingProxy and optionally stakes its AntSeed seller identity.
 *
 * Required env:
 *   DEPLOYER_PRIVATE_KEY   Broadcaster private key.
 *   DIEM_ADDRESS           DIEM staking token/adapter address.
 *   USDC_ADDRESS           USDC token used by AntSeed staking/deposits.
 *   ANTSEED_REGISTRY       AntseedRegistry address.
 *   DIEM_PROXY_OPERATOR    Initial authorized operator and default operator-fee recipient.
 *
 * Optional env:
 *   DIEM_PROXY_AGENT_URI   If set, registers a new ERC-8004 agent and transfers it to the proxy.
 *   DIEM_PROXY_AGENT_ID    Existing ERC-8004 agent id. If deployer owns it, it is transferred to the proxy.
 *   DIEM_PROXY_STAKE_USDC  USDC amount to stake for the proxy seller identity. Defaults to 0.
 *
 * Usage:
 *   cd packages/contracts
 *   source .env
 *   forge script script/DeployDiemStakingProxy.s.sol \
 *     --rpc-url $BASE_MAINNET_RPC_URL \
 *     --broadcast \
 *     --verify \
 *     --etherscan-api-key $BASESCAN_API_KEY \
 *     --via-ir
 */
contract DeployDiemStakingProxy is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);

        address diem = vm.envAddress("DIEM_ADDRESS");
        address usdc = vm.envAddress("USDC_ADDRESS");
        address registryAddress = vm.envAddress("ANTSEED_REGISTRY");
        address operator = vm.envAddress("DIEM_PROXY_OPERATOR");
        uint256 stakeAmount = vm.envOr("DIEM_PROXY_STAKE_USDC", uint256(0));

        IAntseedRegistry registry = IAntseedRegistry(registryAddress);
        address identityRegistry = registry.identityRegistry();
        address antseedStaking = registry.staking();

        require(identityRegistry != address(0), "identity registry not set");
        require(antseedStaking != address(0), "staking not set");

        vm.startBroadcast(deployerPrivateKey);

        console.log("=== DiemStakingProxy Deployment ===");
        console.log("Deployer:              ", deployer);
        console.log("DIEM:                  ", diem);
        console.log("USDC:                  ", usdc);
        console.log("AntseedRegistry:       ", registryAddress);
        console.log("ERC-8004 Registry:     ", identityRegistry);
        console.log("AntseedStaking:        ", antseedStaking);
        console.log("Operator/FeeRecipient: ", operator);
        console.log("");

        DiemStakingProxy proxy = new DiemStakingProxy(diem, usdc, registryAddress, operator);
        console.log("DiemStakingProxy:      ", address(proxy));
        console.log("Operator fee bps:      ", proxy.operatorFeeBps());
        console.log("Operator fee recipient:", proxy.operatorFeeRecipient());
        console.log("");

        uint256 agentId = _resolveAgentId(identityRegistry, deployer, address(proxy));
        if (agentId != 0) {
            console.log("Agent ID:              ", agentId);
        } else {
            console.log("Agent ID:              ", "not configured");
        }

        if (stakeAmount > 0) {
            require(agentId != 0, "agent id required for staking");
            IERC20(usdc).approve(antseedStaking, stakeAmount);
            IAntseedStakingForDiemProxyDeploy(antseedStaking).stakeFor(address(proxy), agentId, stakeAmount);
            console.log("Staked USDC:           ", stakeAmount);
        }

        vm.stopBroadcast();

        console.log("");
        console.log("=== DiemStakingProxy deployment complete ===");
        console.log("proxy:                 ", address(proxy));
        if (agentId != 0) console.log("agentId:               ", agentId);
        if (stakeAmount > 0) console.log("stake:                 ", stakeAmount);
    }

    function _resolveAgentId(address identityRegistry, address deployer, address proxy)
        internal
        returns (uint256 agentId)
    {
        string memory agentUri = vm.envOr("DIEM_PROXY_AGENT_URI", string(""));
        if (bytes(agentUri).length != 0) {
            agentId = IERC8004RegisterAndTransfer(identityRegistry).register(agentUri);
            IERC8004RegisterAndTransfer(identityRegistry).transferFrom(deployer, proxy, agentId);
            require(_ownerOf(identityRegistry, agentId) == proxy, "registered agent not transferred");
            return agentId;
        }

        agentId = vm.envOr("DIEM_PROXY_AGENT_ID", uint256(0));
        if (agentId == 0) return 0;

        address owner = _ownerOf(identityRegistry, agentId);
        if (owner == deployer) {
            IERC8004RegisterAndTransfer(identityRegistry).transferFrom(deployer, proxy, agentId);
            owner = _ownerOf(identityRegistry, agentId);
        }
        require(owner == proxy, "agent not owned by proxy");
    }

    function _ownerOf(address identityRegistry, uint256 agentId) internal view returns (address owner) {
        (bool ok, bytes memory data) = identityRegistry.staticcall(abi.encodeWithSignature("ownerOf(uint256)", agentId));
        require(ok && data.length >= 32, "ownerOf failed");
        owner = abi.decode(data, (address));
    }
}
