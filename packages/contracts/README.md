# AntSeed Smart Contracts

Solidity contracts implementing the streaming payment, staking, stats, and emission system.

## Contract Architecture

```
ANTSToken (ERC-20)          ── phase-locked transfers, mint restricted to AntseedEmissions
AntseedDeposits             ── buyer USDC deposits, holds ALL buyer USDC
AntseedChannels             ── Reserve→Settle/Close lifecycle, EIP-712 (swappable, holds NO USDC)
AntseedStaking              ── seller stake bound to ERC-8004 agentId
AntseedStats                ── optional external metadata sink (buyer/agent token + request stats)
AntseedEmissions            ── USDC volume-based epoch emissions
MockERC8004Registry         ── mock ERC-8004 IdentityRegistry (local testing only)
```

Identity uses the deployed ERC-8004 IdentityRegistry (Base: `0x8004A169...`).
Feedback uses the deployed ERC-8004 ReputationRegistry (Base: `0x8004BAa1...`).

Contracts reference each other by address set at deployment. No inheritance — only interface calls.

```
AntseedChannels ──calls──► AntseedDeposits.lockForChannel() (on reserve)
AntseedChannels ──calls──► AntseedDeposits.chargeAndCreditPayouts() (on settle/close)
AntseedChannels ──calls──► AntseedStats.recordMetadata() (optional, on settle path)
AntseedChannels ──calls──► AntseedEmissions.accrueSellerPoints() / accrueBuyerPoints()
AntseedChannels ──reads──► AntseedStaking (seller stake verification)
AntseedEmissions ──calls──► ANTSToken.mint()
```

## Build

```bash
cd packages/node
forge build
```

Requires [Foundry](https://getfoundry.sh/) and OpenZeppelin contracts (installed via `forge install`).

## Test

```bash
cd packages/node
forge test
```

Submit a development-only seller proof from the loop-proof checkout through a
digest-pinned verifier to the permissionless historical registry on Anvil. The
test stages one seller proof, authenticates every committed evidence block
through a local BlockhashStore mock, finalizes the result, and checks its wash
volume and evidence digest:

```bash
LOOP_PROOF_DIR=/path/to/loop-proof \
WASH_TRADING_ARTIFACT_DIR=/path/to/unified-development-artifacts \
  node --test scripts/wash-trading-development-anvil.test.mjs
```

This test exercises the full local integration path but does not provide
production cryptographic assurance. Production deployments must use a real SP1
Groth16 proof and verifier plus `AntseedSparseBlockhashStore`, whose historical
hashes are verified backwards from Base Chainlink `BlockhashStore` anchors
(Chainlink's store reverts for unknown blocks; the sparse store maps that to
`bytes32(0)` so its own `MissingAnchor` / the registry's `NonCanonicalBlock`
errors fire instead). A staged proof changes no seller result until every committed block-reference
chunk has been authenticated. The registry stores the greatest proven
wash-volume lower bound for each seller as `{provenWashVolume, evidenceDigest}`.
Later proofs must strictly increase the seller's proven wash volume.

Prepare the immutable constructor values from any seller proof produced by the
pinned programs:

```bash
SELLER_PROOF=/path/to/loop-proof/out/production/sellers/0x....json
export WASH_TRADING_SELLER_AGGREGATOR_PROGRAM_VKEY=$(jq -r .aggregatorProgramVKey "$SELLER_PROOF")
export WASH_TRADING_CLOSED_LOOP_PROGRAM_VKEY=$(jq -r .closedLoopProgramVKey "$SELLER_PROOF")
export WASH_TRADING_RECIPROCAL_PROGRAM_VKEY=$(jq -r .reciprocalProgramVKey "$SELLER_PROOF")
export HISTORICAL_PERIOD_START_BLOCK=$(jq -r .periodStartBlock "$SELLER_PROOF")
export HISTORICAL_PERIOD_END_BLOCK=$(jq -r .periodEndBlock "$SELLER_PROOF")
export CHAINLINK_BLOCKHASH_STORE=<base-chainlink-blockhash-store>
export WASH_TRADING_BLOCKHASH_STORE=<deployed-antseed-sparse-blockhash-store>
```

Set `SP1_VERIFIER`, `SP1_VERIFIER_HASH`, and `DEPLOYER_PRIVATE_KEY` separately.
`SP1_VERIFIER` must be the **concrete** `SP1VerifierGroth16` deployment for the
SP1 release the guests were built with — never the `SP1VerifierGateway`
(`0x397A5f7f3dBd538f23DE225B51f532c34448dA9B` on Base). The gateway is owned and
routable: its owner can add a route for a new proof selector, and that route
could accept foreign "proofs" against the registry's immutable program vkeys.
The registry constructor calls `VERIFIER_HASH()` on the verifier and reverts
with `InvalidVerifier` if it is missing (the gateway does not implement it) or
differs from `SP1_VERIFIER_HASH`, and records the hash as `verifierHash`.

For SP1 `v6.1.0` (the pinned `sp1-sdk` in loop-proof) on Base:

```bash
export SP1_VERIFIER=0xb69f2584CBcFf99a58C4e7002E8b89Af54a6f4e2
export SP1_VERIFIER_HASH=0x4388a21c687fdd5f218d7e3d13190cac4c5355818d3605fd5fb811df468ee696
cast call "$SP1_VERIFIER" 'VERSION()(string)' --rpc-url <rpc>        # "v6.1.0"
cast call "$SP1_VERIFIER" 'VERIFIER_HASH()(bytes32)' --rpc-url <rpc> # == SP1_VERIFIER_HASH
```

`VERIFIER_HASH` is `sha256` of the Groth16 verifying key shipped in the matching
`sp1-verifier` crate (`vk-artifacts/groth16_vk.bin`); its first four bytes are
the selector prefix of every proof the guests produce. Re-derive both values
whenever `sp1-sdk` is bumped. Deploy the sparse store if it was not already
deployed by the backfill executor, then deploy the registry:

```bash
forge script script/DeployWashTradingBlockhashStore.s.sol --rpc-url <rpc> --broadcast
forge script script/DeployWashTradingRegistry.s.sol --rpc-url <rpc> --broadcast
```

After deployment, call `stageSellerProof`, submit each artifact chunk with
`authenticateBlockReferences(proofId, ...)`, then call
`finalizeSellerProof(proofId)`. The contract never adds claims onchain and never
accepts a lower or equal result.

### Backfill historical Base block hashes

Production seller proofs authenticate every committed Base block hash against a
sparse store anchored to Chainlink's `BlockhashStore`. Generate a digest-pinned
plan containing the exact missing proof targets. Intermediate headers are still
verified, but only bitmap-selected proof hashes are persisted:

```bash
export BASE_RPC_URL=<base-archive-rpc-with-debug_getRawHeader>
export WASH_TRADING_ARTIFACT_DIR=/path/to/production/sellers
export CHAINLINK_ANCHOR_CATALOG=/path/to/chainlink-blockhash-anchor-catalog.json
export BACKFILL_PLAN=/path/to/wash-trading-blockhash-backfill-plan.json

export MIN_REQUIRED_BLOCK=$(jq -s 'map(.periodStartBlock) | min' "$WASH_TRADING_ARTIFACT_DIR"/*.json)
export CURRENT_BASE_BLOCK=$(cast block-number --rpc-url "$BASE_RPC_URL")
node scripts/enumerate-chainlink-blockhash-anchors.mjs \
  --rpc-url "$BASE_RPC_URL" \
  --start-block "$MIN_REQUIRED_BLOCK" \
  --end-block "$CURRENT_BASE_BLOCK" \
  --concurrency 4 \
  --out "$CHAINLINK_ANCHOR_CATALOG"

node scripts/plan-wash-trading-blockhash-backfill.mjs \
  --artifact-dir "$WASH_TRADING_ARTIFACT_DIR" \
  --rpc-url "$BASE_RPC_URL" \
  --anchor-catalog "$CHAINLINK_ANCHOR_CATALOG" \
  --out "$BACKFILL_PLAN"

jq '{digest, artifacts, liveCoverage, totals}' "$BACKFILL_PLAN"

export HEADER_CACHE=/path/to/wash-trading-header-cache
node scripts/prefetch-wash-trading-blockhash-headers.mjs \
  --plan "$BACKFILL_PLAN" \
  --rpc-url "$BASE_RPC_URL" \
  --cache-dir "$HEADER_CACHE" \
  --chunk-size 500 \
  --rpc-batch-size 50 \
  --rpc-batch-delay-ms 500 \
  --concurrency 4
```

Verify the first batch without sending a transaction:

```bash
node scripts/execute-wash-trading-blockhash-backfill.mjs \
  --plan "$BACKFILL_PLAN" \
  --rpc-url "$BASE_RPC_URL" \
  --header-rpc-url "$BASE_RPC_URL" \
  --header-cache "$HEADER_CACHE" \
  --batch-size 200 \
  --maximum-complete-ranges 64 \
  --header-rpc-batch-size 50 \
  --header-rpc-batch-delay-ms 500 \
  --maximum-batches 1
```

Test the exact transaction path against a Base-forked Anvil before live use:

```bash
anvil --fork-url "$BASE_RPC_URL" --port 8555

export BACKFILL_PLAN_DIGEST=$(jq -r .digest "$BACKFILL_PLAN")
node scripts/execute-wash-trading-blockhash-backfill.mjs \
  --plan "$BACKFILL_PLAN" \
  --rpc-url http://127.0.0.1:8555 \
  --header-rpc-url "$BASE_RPC_URL" \
  --header-cache "$HEADER_CACHE" \
  --batch-size 200 \
  --maximum-complete-ranges 64 \
  --header-rpc-batch-size 50 \
  --header-rpc-batch-delay-ms 500 \
  --maximum-batches 1 \
  --execute \
  --approve-plan-digest "$BACKFILL_PLAN_DIGEST"
```

Live Base execution additionally requires `BACKFILL_PRIVATE_KEY` and the
explicit `--allow-live` guard. Start with one batch, inspect the receipt and
checkpoint, then repeat the same command to resume:

```bash
export BACKFILL_PRIVATE_KEY=<funded-base-private-key>
node scripts/execute-wash-trading-blockhash-backfill.mjs \
  --plan "$BACKFILL_PLAN" \
  --rpc-url "$BASE_RPC_URL" \
  --header-rpc-url "$BASE_RPC_URL" \
  --header-cache "$HEADER_CACHE" \
  --batch-size 200 \
  --maximum-complete-ranges 64 \
  --header-rpc-batch-size 50 \
  --header-rpc-batch-delay-ms 500 \
  --maximum-batches 1 \
  --execute \
  --allow-live \
  --approve-plan-digest "$BACKFILL_PLAN_DIGEST"
```

The executor deploys `AntseedSparseBlockhashStore` once and stores its address,
completed short ranges, and long-range cursors in `<plan>.checkpoint.json`.
Independent short paths are packed into one transaction without permanent
frontiers. Long paths retain a signer-namespaced onchain frontier so another
caller cannot poison or skip work in the active session; resume live runs with
the same `BACKFILL_PRIVATE_KEY`. Never delete or replace the checkpoint during
a live run.
Backfilling does not submit seller proofs; after all ranges complete, deploy the
registry with the sparse-store address, then stage, authenticate, and finalize
the existing paid seller proof artifacts.

## Contracts

### ANTSToken.sol

ERC-20 token (`AntSeed` / `ANTS`). No pre-mine, no initial supply.

- `mint(address to, uint256 amount)` — restricted to emissions contract
- `setEmissionsContract(address)` — owner-only, one-time setter
- `enableTransfers()` — owner-only, one-way toggle (Phase 1: transfers disabled)
- `transferOwnership(address)` — transfer owner role
- `_update()` override — reverts on transfer/transferFrom unless `transfersEnabled == true` (mint/burn always allowed)

### AntseedDeposits.sol

Buyer USDC deposit management with dynamic credit limits and seller payouts.

**Buyer operations:**
- `deposit(address buyer, uint256 amount)` — deposit USDC for a buyer (anyone can call, USDC pulled from msg.sender; pass your own address to deposit for yourself)
- `withdraw(address buyer, uint256 amount)` — immediate withdrawal (operator-only, sends USDC to buyer)
- `getBuyerBalance(address)` → available, reserved, lastActivity
- `getOperator(address)` / `getOperatorNonce(address)` — operator views
- Seller payouts are transferred directly on `settle()` / `close()` — no separate claim step
- `setCreditLimitOverride(address, uint256)` — owner overrides buyer limit

### AntseedChannels.sol

Session lifecycle with EIP-712 ReserveAuth + SpendingAuth. Holds NO USDC — all funds stay in AntseedDeposits. Swappable: can be redeployed by re-pointing stable contracts.

**Seller operations:**
- `reserve(address buyer, bytes32 salt, uint128 maxAmount, uint256 deadline, bytes calldata buyerSig)` — validates ReserveAuth EIP-712 sig, calls Deposits.lockForChannel()
- `settle(bytes32 channelId, uint128 amount, bytes calldata metadata, bytes calldata buyerSig)` — validates SpendingAuth, calls Deposits.chargeAndCreditPayouts(), session stays open
- `close(bytes32 channelId, uint128 amount, bytes calldata metadata, bytes calldata buyerSig)` — like settle but finalizes session, releases remaining lock

**Timeout (buyer/operator):**
- `requestClose(bytes32 channelId)` — buyer/operator, anytime while active; starts grace period
- `withdraw(bytes32 channelId)` — after 15min grace, releases remaining locked funds to buyer deposit

**EIP-712 types (domain: name="AntseedChannels", version="7"):**
```
ReserveAuth(bytes32 channelId, uint128 maxAmount, uint256 deadline)
SpendingAuth(bytes32 channelId, uint256 cumulativeAmount, bytes32 metadataHash)
```

`metadataHash` is the hash of buyer metadata bytes. Current metadata keeps the
first four ABI fields stable for legacy decoders:
`version, cumulativeInputTokens, cumulativeOutputTokens, cumulativeRequestCount`,
then appends service attribution data for off-chain indexers.

channelId = keccak256(abi.encode(buyer, seller, salt))

**Owner functions:**
- `pause()` / `unpause()` — emergency circuit breaker

### AntseedFreeUsage.sol

Zero-price usage channel lifecycle with buyer-signed EIP-712 proofs. Holds NO USDC and never locks or charges buyer funds. Sellers still need to be staked, and each usage update must be signed by the buyer.

**Seller operations:**
- `open(address buyer, bytes32 salt, uint256 deadline, bytes calldata buyerSig)` — validates `FreeUsageOpen` and starts a free usage channel
- `record(bytes32 channelId, uint256 sequence, bytes calldata metadata, uint256 deadline, bytes calldata buyerSig)` — validates `FreeUsageAuth`, enforces a monotonic sequence, and stores/emits raw metadata
- `close(bytes32 channelId, uint256 sequence, bytes calldata metadata, uint256 deadline, bytes calldata buyerSig)` — records the final signed usage and closes the free channel

**EIP-712 types (domain: name="AntseedFreeUsage", version="1"):**
```
FreeUsageOpen(bytes32 channelId,uint256 deadline)
FreeUsageAuth(bytes32 channelId,uint256 sequence,bytes32 metadataHash,uint256 deadline)
```

Metadata is buyer-signed opaque bytes, bound only by `metadataHash`. Indexers parse the metadata version and service attribution off-chain. If `AntseedStats` is configured and this contract is granted writer access, free usage metadata is forwarded there with the same optional `try/catch` behavior used by paid channels.

Free usage channel IDs are domain-separated from paid channels:
`keccak256(abi.encode(FREE_USAGE_CHANNEL_DOMAIN, buyer, seller, salt))`.
Buyers send `FreeUsageOpen` before a free request and answer seller
`NeedFreeUsageAuth` messages after the response, allowing sellers to report
buyer signatures on-chain even when the buyer has no USDC deposit.

### AntseedStats.sol

Optional external metadata sink keyed by ERC-8004 agentId plus buyer address. Writers are managed with `AccessControl`.

- `setWriter(address writer, bool allowed)` — admin grants or revokes write access
- `recordMetadata(uint256 agentId, address buyer, bytes32 channelId, bytes calldata metadata)` — decodes cumulative per-channel metadata, computes deltas, and aggregates buyer-level totals
- `getBuyerMetadataStats(uint256 agentId, address buyer)` — returns cumulative input tokens, output tokens, request count, and last update time

### AntseedStaking.sol

Seller USDC staking bound to ERC-8004 agentId.

- `stake(uint256 agentId, uint256 amount)` — locks USDC, binds to agentId
- `unstake(uint256 agentId)` — returns stake

### AntseedEmissions.sol

ANTS emission controller using the Synthetix reward-per-point pattern. O(1) gas per interaction.

**Epoch management:**
- `advanceEpoch()` — callable by anyone when `EPOCH_DURATION` has passed
- `getEpochInfo()` → current epoch, emission amount, time remaining

**Point accrual (restricted to AntseedChannels):**
- `accrueSellerPoints(address seller, uint256 pointsDelta)`
- `accrueBuyerPoints(address buyer, uint256 pointsDelta)`

**Claiming:**
- `claimEmissions()` — mints accrued ANTS. 15% per-seller cap, excess to reserve
- `pendingEmissions(address)` → ANTS available to claim

**Reserve:**
- `setReserveDestination(address)` — owner-only
- `flushReserve()` — sends accumulated reserve to destination

## Deployment Order

1. **ANTSToken** — deploy (no dependencies)
2. **MockERC8004Registry** — deploy for local testing (on mainnet use deployed ERC-8004)
3. **AntseedDeposits** — deploy with `(usdcAddress)`
4. **AntseedStaking** — deploy with `(usdcAddress, registryAddress)`
5. **AntseedStats** — optional: deploy, set in `AntseedRegistry`, and grant writer access to Channels and FreeUsage
6. **AntseedFreeUsage** — optional zero-price signed usage recorder; deploy with the AntseedRegistry address
6. **AntseedChannels** — deploy with `(registryAddress)`
7. **AntseedEmissions** — deploy with `(antsTokenAddress, channelsAddress)`, then call `antsToken.setEmissionsContract(emissions)`

## Configuration

All constants are configurable by the contract owner via dedicated setter functions (e.g., `setFirstSignCap()`, `setWithdrawalDelay()`).

### AntseedDeposits / AntseedChannels / AntseedStaking

| Constant | Default | Description |
|---|---|---|
| `MIN_BUYER_DEPOSIT` | 10 USDC | Minimum deposit to participate |
| `MIN_SELLER_STAKE` | 10 USDC | Minimum stake to accept sessions |
| `TIMEOUT_GRACE_PERIOD` | 15 min | Grace period after requestClose before withdraw |
| `PLATFORM_FEE_BPS` | 500 (5%) | Platform fee in basis points |
| `MAX_PLATFORM_FEE_BPS` | 1000 (10%) | Maximum platform fee |

### AntseedEmissions

| Constant | Default | Description |
|---|---|---|
| `EPOCH_DURATION` | 1 week | Duration of each emission epoch |
| `HALVING_INTERVAL` | 104 epochs (~2 years) | Epochs between emission halvings |
| `INITIAL_EMISSION` | Set at deployment | Total ANTS emitted in epoch 0 |
| `SELLER_SHARE_PCT` | 65% | Seller share of epoch emissions |
| `BUYER_SHARE_PCT` | 25% | Buyer share of epoch emissions |
| `RESERVE_SHARE_PCT` | 10% | Reserve share of epoch emissions |
| `MAX_SELLER_SHARE_PCT` | 15% | Per-seller cap of seller pool |

### Deployed Contracts

#### Base Mainnet (Production)

| Contract | Address |
|---|---|
| **USDC (Circle)** | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| **ANTSToken** | `0xa87EE81b2C0Bc659307ca2D9ffdC38514DD85263` |
| **AntseedRegistry** | `0xf33fC901BFa97326379A369401F4490E231B69B0` |
| **AntseedStaking** | `0x3652E6B22919bd322A25723B94BB207602E5c8e6` |
| **AntseedDeposits** | `0x0F7a3a8f4Da01637d1202bb5443fcF7F88F99fD2` |
| **AntseedChannels** | `0xBA66d3b4fbCf472F6F11D6F9F96aaCE96516F09d` |
| **AntseedStats** | `0x15649ff076BFa5e37e24EE3154a00503149954Fd` |
| **AntseedEmissionsV2** | `0xF13bE52c4A3afC6AE29536f073588d01A0564088` |
| **ERC-8004 IdentityRegistry** | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` (external) |

All verified on [BaseScan](https://basescan.org). Contract addresses are built into `@antseed/node` chain-config — no manual configuration needed when `chainId: "base-mainnet"` is set.

#### Base Sepolia (Testnet)

Used for testing and development. Uses MockUSDC with permissionless minting. See `.deployments/README.md` for testnet addresses.

#### Base Local (Development)

Local anvil chain (chain ID 31337) for development. Deploy with `forge script script/Deploy.s.sol`.
