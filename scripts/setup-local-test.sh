#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CONTRACTS_DIR="$REPO_ROOT/packages/contracts"
RPC_URL="${ANTSEED_LOCAL_RPC_URL:-http://127.0.0.1:8545}"
CHAIN_ID="${ANTSEED_LOCAL_CHAIN_ID:-31337}"
DEPLOYER_PRIVATE_KEY="${DEPLOYER_PRIVATE_KEY:-0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80}"
LOCAL_ROOT="${ANTSEED_LOCAL_DATA_ROOT:-$HOME/.antseed-local}"
VENICE_PEER_ID="${ANTSEED_REFERENCE_PEER_ID:-9e8f9aaee684298b7f2af2ae008e3692f0e9f4f7}"
REFERENCE_API_KEY_ENV="${ANTSEED_REFERENCE_API_KEY_ENV:-ANTSEED_REFERENCE_API_KEY}"
REFERENCE_API_KEY_VALUE="${!REFERENCE_API_KEY_ENV:-local-smoke}"

SELLER_DIR="$LOCAL_ROOT/seller"
BUYER_DIR="$LOCAL_ROOT/buyer"
VERIFIER_DIR="$LOCAL_ROOT/verifier"
BROADCAST_FILE="$CONTRACTS_DIR/broadcast/Deploy.s.sol/$CHAIN_ID/run-latest.json"
ADDRESSES_FILE="$LOCAL_ROOT/contracts.json"

for command in forge cast node pnpm; do
  command -v "$command" >/dev/null || { echo "missing required command: $command" >&2; exit 1; }
done

cast chain-id --rpc-url "$RPC_URL" >/dev/null 2>&1 || {
  echo "Anvil is not reachable at $RPC_URL. Start it with: anvil" >&2
  exit 1
}

mkdir -p "$SELLER_DIR" "$BUYER_DIR" "$VERIFIER_DIR"

printf '\n=== Build runtime dependencies ===\n'
(cd "$REPO_ROOT" && pnpm --filter @antseed/node build >/dev/null)

printf '\n=== Deploy fresh local contracts ===\n'
(
  cd "$CONTRACTS_DIR"
  DEPLOYER_PRIVATE_KEY="$DEPLOYER_PRIVATE_KEY" forge script script/Deploy.s.sol \
    --rpc-url "$RPC_URL" --broadcast
)

[[ -f "$BROADCAST_FILE" ]] || { echo "missing Foundry broadcast output: $BROADCAST_FILE" >&2; exit 1; }
node --input-type=module - "$BROADCAST_FILE" "$ADDRESSES_FILE" <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs'
const [input, output] = process.argv.slice(2)
const broadcast = JSON.parse(readFileSync(input, 'utf8'))
const wanted = [
  'MockUSDC', 'MockERC8004Registry', 'ANTSToken', 'AntseedRegistry', 'AntseedStaking',
  'AntseedDeposits', 'AntseedChannels', 'AntseedStats', 'AntseedSellerPools',
  'AntseedSellerRegistry', 'AntseedEmissionsGate', 'AntseedUsageAccounting',
  'AntseedVerifierRegistry', 'AntseedVerifierRewards', 'AntseedVerifierPointsPolicy',
  'AntseedSellerPoolsRewards', 'AntseedUsageRewards',
]
const result = {}
for (const transaction of broadcast.transactions ?? []) {
  if (transaction.transactionType === 'CREATE' && wanted.includes(transaction.contractName)) {
    result[transaction.contractName] = transaction.contractAddress
  }
}
const missing = wanted.filter((name) => !result[name])
if (missing.length > 0) throw new Error(`broadcast missing deployments: ${missing.join(', ')}`)
writeFileSync(output, JSON.stringify(result, null, 2) + '\n')
NODE

address() {
  node --input-type=module - "$ADDRESSES_FILE" "$1" <<'NODE'
import { readFileSync } from 'node:fs'
const [path, key] = process.argv.slice(2)
const value = JSON.parse(readFileSync(path, 'utf8'))[key]
if (!value) throw new Error(`missing address ${key}`)
process.stdout.write(value)
NODE
}

USDC="$(address MockUSDC)"
IDENTITY_REGISTRY="$(address MockERC8004Registry)"
ANTS_TOKEN="$(address ANTSToken)"
REGISTRY="$(address AntseedRegistry)"
LEGACY_STAKING="$(address AntseedStaking)"
DEPOSITS="$(address AntseedDeposits)"
CHANNELS="$(address AntseedChannels)"
STATS="$(address AntseedStats)"
SELLER_POOLS="$(address AntseedSellerPools)"
SELLER_REGISTRY="$(address AntseedSellerRegistry)"
EMISSIONS_GATE="$(address AntseedEmissionsGate)"
USAGE_ACCOUNTING="$(address AntseedUsageAccounting)"
VERIFIER_REGISTRY="$(address AntseedVerifierRegistry)"
VERIFIER_REWARDS="$(address AntseedVerifierRewards)"
VERIFIER_POINTS_POLICY="$(address AntseedVerifierPointsPolicy)"

identity_json() {
  node --input-type=module - "$1" "$REPO_ROOT" <<'NODE'
const [dataDir, root] = process.argv.slice(2)
const { loadOrCreateIdentity } = await import(`${root}/packages/node/dist/index.js`)
const identity = await loadOrCreateIdentity(dataDir)
process.stdout.write(JSON.stringify({
  address: identity.wallet.address,
  privateKey: identity.wallet.privateKey,
  peerId: identity.peerId,
}))
NODE
}

SELLER_IDENTITY="$(identity_json "$SELLER_DIR")"
BUYER_IDENTITY="$(identity_json "$BUYER_DIR")"
VERIFIER_IDENTITY="$(identity_json "$VERIFIER_DIR")"
json_value() { node -e 'process.stdout.write(JSON.parse(process.argv[1])[process.argv[2]])' "$1" "$2"; }
SELLER_ADDRESS="$(json_value "$SELLER_IDENTITY" address)"
SELLER_KEY="$(json_value "$SELLER_IDENTITY" privateKey)"
BUYER_ADDRESS="$(json_value "$BUYER_IDENTITY" address)"
BUYER_KEY="$(json_value "$BUYER_IDENTITY" privateKey)"
VERIFIER_ADDRESS="$(json_value "$VERIFIER_IDENTITY" address)"
VERIFIER_KEY="$(json_value "$VERIFIER_IDENTITY" privateKey)"

send() { cast send --rpc-url "$RPC_URL" --private-key "$1" "${@:2}" >/dev/null; }
for wallet in "$SELLER_ADDRESS" "$BUYER_ADDRESS" "$VERIFIER_ADDRESS"; do
  send "$DEPLOYER_PRIVATE_KEY" "$wallet" --value 2ether
done
for wallet in "$SELLER_ADDRESS" "$BUYER_ADDRESS" "$VERIFIER_ADDRESS"; do
  send "$DEPLOYER_PRIVATE_KEY" "$USDC" 'mint(address,uint256)' "$wallet" 100000000
done
send "$DEPLOYER_PRIVATE_KEY" "$VERIFIER_REGISTRY" 'setVerifier(address,bool)' "$VERIFIER_ADDRESS" true

send "$SELLER_KEY" "$IDENTITY_REGISTRY" 'register()'
AGENT_ID=1
send "$SELLER_KEY" "$USDC" 'approve(address,uint256)' "$LEGACY_STAKING" 50000000
send "$SELLER_KEY" "$LEGACY_STAKING" 'stake(uint256,uint256)' "$AGENT_ID" 50000000
send "$SELLER_KEY" "$SELLER_REGISTRY" 'registerSeller(uint256)' "$AGENT_ID"

set_operator_and_deposit() {
  local address="$1" private_key="$2"
  local domain typehash struct_hash digest signature
  domain="$(cast call --rpc-url "$RPC_URL" "$DEPOSITS" 'domainSeparator()(bytes32)')"
  typehash="$(cast keccak 'SetOperator(address operator,uint256 nonce)')"
  struct_hash="$(cast keccak "$(cast abi-encode 'f(bytes32,address,uint256)' "$typehash" "$address" 0)")"
  digest="$(cast keccak "$(cast concat-hex 0x1901 "$domain" "$struct_hash")")"
  signature="$(cast wallet sign --no-hash --private-key "$private_key" "$digest")"
  send "$private_key" "$DEPOSITS" 'setOperator(address,address,uint256,bytes)' "$address" "$address" 0 "$signature"
  send "$private_key" "$USDC" 'approve(address,uint256)' "$DEPOSITS" 10000000
  send "$private_key" "$DEPOSITS" 'deposit(address,uint256)' "$address" 10000000
}
set_operator_and_deposit "$BUYER_ADDRESS" "$BUYER_KEY"
set_operator_and_deposit "$VERIFIER_ADDRESS" "$VERIFIER_KEY"

write_config() {
  local path="$1" role="$2" proxy_port="$3"
  node --input-type=module - "$path" "$role" "$proxy_port" "$RPC_URL" \
    "$DEPOSITS" "$CHANNELS" "$SELLER_REGISTRY" "$USDC" "$IDENTITY_REGISTRY" "$USAGE_ACCOUNTING" \
    "$VERIFIER_REGISTRY" "$VERIFIER_REWARDS" "$VERIFIER_POINTS_POLICY" "$VENICE_PEER_ID" "$REFERENCE_API_KEY_ENV" <<'NODE'
import { writeFileSync } from 'node:fs'
const [path, role, proxyPort, rpcUrl, deposits, channels, staking, usdc, identityRegistry,
  emissions, verifierRegistry, verifierRewards, verifierPointsPolicy, peerId, apiKeyEnv] = process.argv.slice(2)
const chain = {
  chainId: 'base-local', rpcUrl,
  depositsContractAddress: deposits, channelsContractAddress: channels,
  stakingContractAddress: staking, usdcContractAddress: usdc,
  identityRegistryAddress: identityRegistry, emissionsContractAddress: emissions,
  verifierRegistryAddress: verifierRegistry, verifierRewardsAddress: verifierRewards,
  verifierPointsPolicyAddress: verifierPointsPolicy,
}
const config = {
  identity: { displayName: `Local ${role}` },
  seller: {
    reserveFloor: 0,
    maxConcurrentBuyers: 8,
    publicAddress: role === 'seller' ? '127.0.0.1:6882' : undefined,
    providers: role === 'seller' ? {
      'venice-proxy': {
        plugin: 'openai',
        baseUrl: 'http://127.0.0.1:8377',
        apiKeyEnv,
        defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 },
        services: {
          'gpt-5.6-sol': {
            upstreamModel: 'gpt-5.6-sol', categories: ['coding'],
            pricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 },
          },
        },
      },
    } : {},
  },
  buyer: {
    maxPricing: { defaults: { inputUsdPerMillion: 100, outputUsdPerMillion: 100 } },
    minPeerReputation: 0,
    proxyPort: Number(proxyPort),
    peerRefreshIntervalMs: 30000,
    metadataFetchTimeoutMs: 5000,
    disableMetadataV2Services: false,
    verification: { sampleRate: 1, maxSampleBytes: 10485760 },
  },
  payments: { preferredMethod: 'crypto', platformFeeRate: 0.05, crypto: chain },
  network: { bootstrapNodes: [] },
}
if (role === 'verifier') {
  config.verifier = {
    services: ['gpt-5.6-sol'],
    auditIntervalMs: 300000,
    maxAuditsPerEpoch: 50,
    probeRequestTimeoutMs: 120000,
    maxConcurrentProbeRequests: 2,
    referenceEndpoint: {
      baseUrl: 'http://127.0.0.1:8377/v1', apiKeyEnv,
      sourceId: 'antseed-venice-sol-smoke-v1', trust: 'smoke', antseedPeerId: peerId,
      models: {
        'gpt-5.6-sol': {
          upstreamModel: 'gpt-5.6-sol',
          contrastModels: ['kimi-k3', 'gpt-5.6-luna', 'sonnet-4.8'],
        },
      },
    },
    referencePolicy: {
      minimumAuditProbeCount: 100, maximumAuditProbeCount: 750, auditProbeStep: 10,
      minimumStatisticalPower: 0.9, minimumMismatchDelta: 0.1,
      familyWideAlpha: 0.05, referenceConfidence: 0.99, minimumAuthenticatedCoverage: 1,
      maxReferenceAgeDays: 49, maxRequestsPerRound: 2000,
      requestTimeoutMs: 120000, batchRetryCount: 3,
      generationDomainConcurrency: 3, maxConcurrentReferenceRequests: 4,
      maxConcurrentRequestsPerModel: 2,
    },
  }
}
writeFileSync(path, JSON.stringify(config, null, 2) + '\n')
NODE
}

write_config "$SELLER_DIR/config.json" seller 8379
write_config "$BUYER_DIR/config.json" buyer 8377
write_config "$VERIFIER_DIR/config.json" verifier 8380
cat > "$SELLER_DIR/smoke.env" <<EOF_ENV
export $REFERENCE_API_KEY_ENV='$REFERENCE_API_KEY_VALUE'
export OPENAI_EXTRA_HEADERS_JSON='{"x-antseed-pin-peer":"$VENICE_PEER_ID"}'
EOF_ENV
cat > "$VERIFIER_DIR/smoke.env" <<EOF_ENV
export $REFERENCE_API_KEY_ENV='$REFERENCE_API_KEY_VALUE'
EOF_ENV

assert_address() {
  local label="$1" actual="$2" expected="$3"
  actual="$(printf '%s' "$actual" | tr '[:upper:]' '[:lower:]')"
  expected="$(printf '%s' "$expected" | tr '[:upper:]' '[:lower:]')"
  [[ "$actual" == "$expected" ]] || { echo "$label mismatch: $actual != $expected" >&2; exit 1; }
}
assert_address 'registry.deposits' "$(cast call --rpc-url "$RPC_URL" "$REGISTRY" 'deposits()(address)')" "$DEPOSITS"
assert_address 'registry.channels' "$(cast call --rpc-url "$RPC_URL" "$REGISTRY" 'channels()(address)')" "$CHANNELS"
assert_address 'registry.staking' "$(cast call --rpc-url "$RPC_URL" "$REGISTRY" 'staking()(address)')" "$SELLER_REGISTRY"
assert_address 'registry.emissions' "$(cast call --rpc-url "$RPC_URL" "$REGISTRY" 'emissions()(address)')" "$USAGE_ACCOUNTING"
assert_address 'verifier rewards registry' "$(cast call --rpc-url "$RPC_URL" "$VERIFIER_REWARDS" 'verifierRegistry()(address)')" "$VERIFIER_REGISTRY"
[[ "$(cast call --rpc-url "$RPC_URL" "$VERIFIER_REGISTRY" 'approvedVerifiers(address)(bool)' "$VERIFIER_ADDRESS")" == 'true' ]]
assert_address 'seller agent owner' "$(cast call --rpc-url "$RPC_URL" "$IDENTITY_REGISTRY" 'ownerOf(uint256)(address)' "$AGENT_ID")" "$SELLER_ADDRESS"

printf '\n=== Local verifier environment ready ===\n'
printf 'Contracts: %s\n' "$ADDRESSES_FILE"
printf 'Seller config: %s\nBuyer config: %s\nVerifier config: %s\n' \
  "$SELLER_DIR/config.json" "$BUYER_DIR/config.json" "$VERIFIER_DIR/config.json"
printf '\nStart order (after pnpm run build):\n'
printf '1. source %q && antseed --data-dir %q --config %q seller start\n' "$SELLER_DIR/smoke.env" "$SELLER_DIR" "$SELLER_DIR/config.json"
printf '2. source %q && antseed --data-dir %q --config %q verifier start\n' "$VERIFIER_DIR/smoke.env" "$VERIFIER_DIR" "$VERIFIER_DIR/config.json"
printf '3. optional buyer: antseed --data-dir %q --config %q buyer start\n' "$BUYER_DIR" "$BUYER_DIR/config.json"
printf '\nVenice is pinned only through configuration/header state; no peer ID is hard-coded in runtime code.\n'
