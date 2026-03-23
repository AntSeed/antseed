#!/bin/bash
set -e

DEPLOYER=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
USDC=0x5FbDB2315678afecb367f032d93F642f64180aa3
ESCROW=0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9
IDENTITY=0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512
RPC=http://127.0.0.1:8545

cd /Users/shahafan/Development/antseed

# Ensure seller data dir and config exist
mkdir -p ~/.antseed-seller
if [ ! -f ~/.antseed-seller/config.json ]; then
cat > ~/.antseed-seller/config.json << 'EOF'
{
  "identity": { "displayName": "Local Codex Seller" },
  "seller": {
    "publicAddress": "127.0.0.1:6882",
    "pricing": { "defaults": { "inputUsdPerMillion": 3, "outputUsdPerMillion": 15 } }
  },
  "payments": {
    "crypto": {
      "chainId": "base-local",
      "rpcUrl": "http://127.0.0.1:8545",
      "escrowContractAddress": "0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9",
      "usdcContractAddress": "0x5FbDB2315678afecb367f032d93F642f64180aa3"
    }
  },
  "providers": [
    { "name": "openai-responses", "services": ["codex"] }
  ]
}
EOF
echo "Created seller config"
fi

# Ensure plugin is linked
mkdir -p ~/.antseed/plugins/node_modules/@antseed
ln -sf "$(pwd)/plugins/provider-openai-responses" ~/.antseed/plugins/node_modules/@antseed/provider-openai-responses 2>/dev/null || true

echo "=== Getting wallet addresses ==="
SELLER_ADDR=$(node -e "const{loadOrCreateIdentity}=require('./packages/node/dist/p2p/identity.js');const{identityToEvmAddress}=require('./packages/node/dist/payments/evm/keypair.js');(async()=>{console.log(identityToEvmAddress(await loadOrCreateIdentity('/Users/shahafan/.antseed-seller')))})()")
SELLER_KEY=$(node -e "const{loadOrCreateIdentity}=require('./packages/node/dist/p2p/identity.js');const{identityToEvmWallet}=require('./packages/node/dist/payments/evm/keypair.js');(async()=>{console.log(identityToEvmWallet(await loadOrCreateIdentity('/Users/shahafan/.antseed-seller')).privateKey)})()")
BUYER_ADDR=$(node -e "const{loadOrCreateIdentity}=require('./packages/node/dist/p2p/identity.js');const{identityToEvmAddress}=require('./packages/node/dist/payments/evm/keypair.js');(async()=>{console.log(identityToEvmAddress(await loadOrCreateIdentity('/Users/shahafan/.antseed')))})()")
BUYER_KEY=$(node -e "const{loadOrCreateIdentity}=require('./packages/node/dist/p2p/identity.js');const{identityToEvmWallet}=require('./packages/node/dist/payments/evm/keypair.js');(async()=>{console.log(identityToEvmWallet(await loadOrCreateIdentity('/Users/shahafan/.antseed')).privateKey)})()")
SELLER_PEER=$(cat ~/.antseed-seller/identity.key)

echo "Seller: $SELLER_ADDR"
echo "Buyer:  $BUYER_ADDR"
echo "Seller PeerId: ${SELLER_PEER:0:16}..."

echo "=== Funding ETH ==="
cast send --rpc-url $RPC --private-key $DEPLOYER $SELLER_ADDR --value 1ether > /dev/null
cast send --rpc-url $RPC --private-key $DEPLOYER $BUYER_ADDR --value 1ether > /dev/null
echo "Done"

echo "=== Minting USDC ==="
cast send --rpc-url $RPC --private-key $DEPLOYER $USDC "mint(address,uint256)" $SELLER_ADDR 100000000 > /dev/null
cast send --rpc-url $RPC --private-key $DEPLOYER $USDC "mint(address,uint256)" $BUYER_ADDR 100000000 > /dev/null
echo "Done"

echo "=== Registering seller identity ==="
cast send --rpc-url $RPC --private-key $SELLER_KEY $IDENTITY "register(bytes32,string)" "0x${SELLER_PEER}" "" > /dev/null
echo "Done"

echo "=== Seller: stake 50 USDC + set token rate ==="
cast send --rpc-url $RPC --private-key $SELLER_KEY $USDC "approve(address,uint256)" $ESCROW 50000000 > /dev/null
cast send --rpc-url $RPC --private-key $SELLER_KEY $ESCROW "stake(uint256)" 50000000 > /dev/null
cast send --rpc-url $RPC --private-key $SELLER_KEY $ESCROW "setTokenRate(uint256)" 1 > /dev/null
echo "Done"

echo "=== Buyer: deposit 10 USDC ==="
cast send --rpc-url $RPC --private-key $BUYER_KEY $USDC "approve(address,uint256)" $ESCROW 10000000 > /dev/null
cast send --rpc-url $RPC --private-key $BUYER_KEY $ESCROW "deposit(uint256)" 10000000 > /dev/null
echo "Done"

echo ""
echo "=== Verify ==="
echo "Seller account (stake, earnings, stakedAt, tokenRate):"
cast call --rpc-url $RPC $ESCROW "getSellerAccount(address)(uint256,uint256,uint256,uint256)" $SELLER_ADDR
echo ""
echo "Buyer balance (available, reserved, pendingWithdrawal, lastActivityAt):"
cast call --rpc-url $RPC $ESCROW "getBuyerBalance(address)(uint256,uint256,uint256,uint256)" $BUYER_ADDR

echo ""
echo "=== All set! ==="
echo ""
echo "Update ~/.antseed/config.json payments.crypto to:"
echo '  "crypto": { "chainId": "base-local" }'
echo ""
echo "Start seller:"
echo "  node apps/cli/dist/cli/index.js --data-dir ~/.antseed-seller seed --provider openai-responses --verbose --config ~/.antseed-seller/config.json"
echo ""
echo "Start desktop:"
echo "  cd apps/desktop && npm run dev"
