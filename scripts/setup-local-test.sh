#!/bin/bash
set -e

DEPLOYER=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
RPC=http://127.0.0.1:8545

# Contract addresses (deterministic from anvil nonce 0)
USDC=0x5FbDB2315678afecb367f032d93F642f64180aa3
IDENTITY=0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512
STAKING=0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9
DEPOSITS=0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9
STREAM_CHANNEL=0x5FC8d32690cc91D4c39d9d3abcBD16989F875707
SESSIONS=0x0165878A594ca255338adfa4d48449f69242Eb8F

cd /Users/shahafan/Development/antseed

echo "=== Step 1: Deploy contracts ==="
echo "Make sure anvil is running: anvil"
echo ""

cd packages/node
forge script contracts/script/Deploy.s.sol --rpc-url $RPC --broadcast
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
      "sessionsContractAddress": "$SESSIONS",
      "stakingContractAddress": "$STAKING",
      "usdcContractAddress": "$USDC",
      "identityContractAddress": "$IDENTITY"
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
SELLER_ADDR=$(node -e "const{loadOrCreateIdentity}=require('./packages/node/dist/p2p/identity.js');const{identityToEvmAddress}=require('./packages/node/dist/payments/evm/keypair.js');(async()=>{console.log(identityToEvmAddress(await loadOrCreateIdentity('/Users/shahafan/.antseed-seller')))})()")
SELLER_KEY=$(node -e "const{loadOrCreateIdentity}=require('./packages/node/dist/p2p/identity.js');const{identityToEvmWallet}=require('./packages/node/dist/payments/evm/keypair.js');(async()=>{console.log(identityToEvmWallet(await loadOrCreateIdentity('/Users/shahafan/.antseed-seller')).privateKey)})()")
BUYER_ADDR=$(node -e "const{loadOrCreateIdentity}=require('./packages/node/dist/p2p/identity.js');const{identityToEvmAddress}=require('./packages/node/dist/payments/evm/keypair.js');(async()=>{console.log(identityToEvmAddress(await loadOrCreateIdentity('/Users/shahafan/.antseed')))})()")
BUYER_KEY=$(node -e "const{loadOrCreateIdentity}=require('./packages/node/dist/p2p/identity.js');const{identityToEvmWallet}=require('./packages/node/dist/payments/evm/keypair.js');(async()=>{console.log(identityToEvmWallet(await loadOrCreateIdentity('/Users/shahafan/.antseed')).privateKey)})()")
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
echo "=== Step 6: Register seller identity ==="
cast send --rpc-url $RPC --private-key $SELLER_KEY $IDENTITY "register(bytes32,string)" "0x${SELLER_PEER}" "" > /dev/null
echo "Done"

echo ""
echo "=== Step 7: Seller stake 50 USDC ==="
cast send --rpc-url $RPC --private-key $SELLER_KEY $USDC "approve(address,uint256)" $STAKING 50000000 > /dev/null
cast send --rpc-url $RPC --private-key $SELLER_KEY $STAKING "stake(uint256)" 50000000 > /dev/null
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
echo "Buyer balance (available, reserved, pendingWithdrawal, lastActivityAt):"
cast call --rpc-url $RPC $DEPOSITS "getBuyerBalance(address)(uint256,uint256,uint256,uint256)" $BUYER_ADDR

echo ""
echo "=== All set! ==="
echo ""
echo "Contract addresses:"
echo "  USDC:      $USDC"
echo "  Identity:  $IDENTITY"
echo "  Staking:   $STAKING"
echo "  Deposits:  $DEPOSITS"
echo "  Sessions:  $SESSIONS"
echo ""
echo "Desktop config (Settings > Chain Config):"
echo "  Chain ID:    base-local"
echo "  RPC URL:     $RPC"
echo "  Deposits:    $DEPOSITS"
echo "  Sessions:    $SESSIONS"
echo ""
echo "Start seller:"
echo "  node apps/cli/dist/cli/index.js --data-dir ~/.antseed-seller seed --provider openai-responses --verbose --config ~/.antseed-seller/config.json"
echo ""
echo "Start desktop:"
echo "  cd apps/desktop && npm run dev"
