#!/bin/bash
set -e

DEPLOYER=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
RPC=http://127.0.0.1:8545

# Contract addresses (deterministic from anvil nonce sequence)
USDC=0x5FbDB2315678afecb367f032d93F642f64180aa3          # nonce 0
REGISTRY=0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512      # nonce 1 — MockERC8004Registry
# ANTSToken = nonce 2, AntseedRegistry = nonce 3
STAKING=0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9       # nonce 4
DEPOSITS=0x5FC8d32690cc91D4c39d9d3abcBD16989F875707      # nonce 5
CHANNELS=0x0165878A594ca255338adfa4d48449f69242Eb8F      # nonce 6
# Emissions = nonce 7, SubPool = nonce 8

cd /Users/shahafan/Development/antseed

echo "=== Step 1: Deploy contracts ==="
echo "Make sure anvil is running: anvil"
echo ""

cd packages/contracts
forge script script/Deploy.s.sol --rpc-url $RPC --broadcast
cd ../..

echo ""
echo "=== Step 2: Setup seller ==="

# Ensure seller data dir and config exist
mkdir -p ~/.antseed-seller
cat > ~/.antseed-seller/config.json << EOF
{
  "identity": { "displayName": "Local Test Seller" },
  "seller": {
    "publicAddress": "127.0.0.1:6882",
    "pricing": { "defaults": { "inputUsdPerMillion": 3, "outputUsdPerMillion": 15 } }
  },
  "payments": {
    "preferredMethod": "crypto",
    "crypto": {
      "chainId": "base-local",
      "rpcUrl": "$RPC",
      "depositsContractAddress": "$DEPOSITS",
      "channelsContractAddress": "$CHANNELS",
      "stakingContractAddress": "$STAKING",
      "usdcContractAddress": "$USDC",
      "identityRegistryAddress": "$REGISTRY",
      "statsAddress": "$STATS"
    }
  },
  "providers": [
    { "name": "openai-responses", "services": ["codex"] }
  ]
}
EOF
echo "Created seller config at ~/.antseed-seller/config.json"

# Ensure plugin is linked
mkdir -p ~/.antseed/plugins/node_modules/@antseed
ln -sf "$(pwd)/plugins/provider-openai-responses" ~/.antseed/plugins/node_modules/@antseed/provider-openai-responses 2>/dev/null || true

echo ""
echo "=== Step 3: Get wallet addresses ==="
SELLER_ADDR=$(node -e "const{loadOrCreateIdentity}=require('./packages/node/dist/p2p/identity.js');(async()=>{const i=await loadOrCreateIdentity('/Users/shahafan/.antseed-seller');console.log(i.wallet.address)})()")
SELLER_KEY=$(node -e "const{loadOrCreateIdentity}=require('./packages/node/dist/p2p/identity.js');(async()=>{const i=await loadOrCreateIdentity('/Users/shahafan/.antseed-seller');console.log(i.wallet.privateKey)})()")
BUYER_ADDR=$(node -e "const{loadOrCreateIdentity}=require('./packages/node/dist/p2p/identity.js');(async()=>{const i=await loadOrCreateIdentity('/Users/shahafan/.antseed');console.log(i.wallet.address)})()")
BUYER_KEY=$(node -e "const{loadOrCreateIdentity}=require('./packages/node/dist/p2p/identity.js');(async()=>{const i=await loadOrCreateIdentity('/Users/shahafan/.antseed');console.log(i.wallet.privateKey)})()")
SELLER_PEER=$(cat ~/.antseed-seller/identity.key)

echo "Seller EVM: $SELLER_ADDR"
echo "Buyer EVM:  $BUYER_ADDR"
echo "Seller PeerId: ${SELLER_PEER:0:16}..."

echo ""
echo "=== Step 4: Fund ETH ==="
cast send --rpc-url $RPC --private-key $DEPLOYER $SELLER_ADDR --value 1ether > /dev/null
cast send --rpc-url $RPC --private-key $DEPLOYER $BUYER_ADDR --value 1ether > /dev/null
echo "Done"

echo ""
echo "=== Step 5: Mint USDC ==="
cast send --rpc-url $RPC --private-key $DEPLOYER $USDC "mint(address,uint256)" $SELLER_ADDR 100000000 > /dev/null
cast send --rpc-url $RPC --private-key $DEPLOYER $USDC "mint(address,uint256)" $BUYER_ADDR 100000000 > /dev/null
echo "Done"

echo ""
echo "=== Step 6: Register seller identity (ERC-8004) ==="
cast send --rpc-url $RPC --private-key $SELLER_KEY $REGISTRY "register()" > /dev/null
# agentId=1 for first registration on fresh chain
AGENT_ID=1
echo "Done"

echo ""
echo "=== Step 7: Seller stake 50 USDC ==="
cast send --rpc-url $RPC --private-key $SELLER_KEY $USDC "approve(address,uint256)" $STAKING 50000000 > /dev/null
cast send --rpc-url $RPC --private-key $SELLER_KEY $STAKING "stake(uint256,uint256)" $AGENT_ID 50000000 > /dev/null
echo "Done"

echo ""
echo "=== Step 8: Buyer deposit 10 USDC ==="
cast send --rpc-url $RPC --private-key $BUYER_KEY $USDC "approve(address,uint256)" $DEPOSITS 10000000 > /dev/null
cast send --rpc-url $RPC --private-key $BUYER_KEY $DEPOSITS "deposit(uint256)" 10000000 > /dev/null
echo "Done"

echo ""
echo "=== Verify ==="
echo "Seller account (stake, stakedAt):"
cast call --rpc-url $RPC $STAKING "getSellerAccount(address)(uint256,uint256)" $SELLER_ADDR
echo ""
echo "Buyer balance (available, reserved, lastActivityAt):"
cast call --rpc-url $RPC $DEPOSITS "getBuyerBalance(address)(uint256,uint256,uint256)" $BUYER_ADDR

echo ""
echo "=== All set! ==="
echo ""
echo "Contract addresses:"
echo "  USDC:      $USDC"
echo "  Registry:  $REGISTRY"
echo "  Staking:   $STAKING"
echo "  Deposits:  $DEPOSITS"
echo "  Channels:  $CHANNELS"
echo ""
echo "Desktop config (Settings > Chain Config):"
echo "  Chain ID:    base-local"
echo "  RPC URL:     $RPC"
echo "  Deposits:    $DEPOSITS"
echo "  Channels:    $CHANNELS"
echo ""
echo "Start seller:"
echo "  node apps/cli/dist/cli/index.js --data-dir ~/.antseed-seller seed --provider openai-responses --verbose --config ~/.antseed-seller/config.json"
echo ""
echo "Start desktop:"
echo "  cd apps/desktop && npm run dev"
