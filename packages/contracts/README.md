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
cd packages/contracts
forge build
```

Requires [Foundry](https://getfoundry.sh/) and OpenZeppelin contracts (installed via `forge install`).

## Test

```bash
cd packages/node
forge test
```

## Recognized Usage and Integrity Deployment

The recognized-usage migration is intentionally split from the epoch-boundary
pointer flip. It is not one automatic deployment transaction.

1. Run `DeployRecognizedUsage.s.sol` early enough in the current epoch. It
   deploys `AntseedEmissionsGate`, seller pools and registries, usage accounting
   and reward controllers, `AntseedPointsPolicyRegistry`, and
   `AntseedVerification`. The verification contract controls the 10% verifier
   minter bucket. `AntseedUsageAccounting.pointsPolicy` is set only to the
   policy registry. No wash or verification leaf is registered by this script.
2. Deploy `AntseedWashTradingRegistry` with
   `DeployWashTradingEnforcement.s.sol` using the approved vkeys, batch count,
   and digest.
3. Run `ConfigureIntegrityPolicies.s.sol` with the printed
   `POINTS_POLICY_REGISTRY`, the wash registry, and `VERIFICATION`. It deploys
   missing wash and verification leaves, or reuses the optional
   `WASH_TRADING_POINTS_POLICY` and `VERIFICATION_POINTS_POLICY` addresses.
   Registration is idempotent. `REGISTER_WASH_POLICY` defaults to `true`;
   `REGISTER_VERIFICATION_POLICY` defaults to `false`. A false flag never
   removes an already registered policy.
4. Install `AntseedWashTradingRewardPolicy` separately with
   `DeploySellerRewardGate.s.sol` for the legacy emissions and locked seller
   reward-pool claim paths. This reward policy is not a points-registry leaf.
5. Submit and verify the historical wash-proof batch. The registered wash
   points policy returns zero penalty until `backfillComplete`, so installing it
   before the batch does not suppress seller or buyer points.
6. At the next epoch boundary, run `scripts/cutover-flip.sh` (or manage the
   equivalent pause, wait, `CutoverFlip.s.sol`, verification, and unpause steps
   manually). Only this second broadcast changes the protocol registry's
   emissions and staking pointers.

`AntseedEmissionsGate.effectiveEpoch` is the epoch after broadcast one. All
minter shares must be configured in the gate's deployment epoch, which is why
`DeployRecognizedUsage` refuses to start within one hour of a boundary. The
legacy stack remains active until the boundary flip, and the wrapper pauses
channels before the boundary so new-epoch usage cannot land on the legacy
ledger. Verification attestations and rewards may be collected after verifier
approval, but verification cannot change routing points until governance later
registers `AntseedVerificationPointsPolicy`.

```bash
forge script script/DeployRecognizedUsage.s.sol --rpc-url "$BASE_MAINNET_RPC_URL" --broadcast --via-ir
forge script script/DeployWashTradingEnforcement.s.sol --rpc-url "$BASE_MAINNET_RPC_URL" --broadcast --via-ir
forge script script/ConfigureIntegrityPolicies.s.sol --rpc-url "$BASE_MAINNET_RPC_URL" --broadcast --via-ir
```

## Wash-Trading Enforcement

`AntseedWashTradingRegistry` pins the closed-loop and reciprocal SP1 vkeys, the
Chainlink Base BlockhashStore at
`0x78b69899C8cD252126cBB1A50171ec37286C3877`, and the approved historical
batch count and digest in its constructor. Each journal contains one or two
subjects, their proven wash and settled volumes, and authenticated Base block
references. Solidity checks each block with
`BlockhashStore.getBlockhash(blockNumber)` and exact hash equality.

The initial history is submitted with one `submitBatch(publicValues,
proofBytes)` transaction. The ordered `(claimId, sha256(publicValues))`
commitments must reproduce the constructor-pinned digest, every proof and
journal invariant must pass, and any failure reverts the entire batch.
`backfillComplete` becomes true only after the full loop succeeds. Before that,
individual submissions are rejected; afterward, anyone may submit new evidence
or a stronger ratio. Exact claim replays are idempotent.

The registry never adds wash volumes from overlapping claims. For each subject
it retains only the greatest proven `washVolume / settledVolume` ratio using
full-precision cross multiplication. A positive numerator with a zero
denominator, or a numerator at least as large as its denominator, is 100%.
Because claims materialize only their greatest individually proven ratio, the
journal ABI does not need an `economicId`, and the external `loop-proof`
programs and public-value shapes remain unchanged.

Future points and seller reward claims use separate policy hooks:

- `AntseedPointsPolicyRegistry` is the `AntseedUsageAccounting` points hook. It
  evaluates at most eight category-aware leaves with a 100,000-gas allowance
  each. Same-category penalties take the maximum, different categories add,
  soft penalties cap at 9,000 BPS, and 10,000 BPS is a hard veto. An empty
  registry passes raw points through. `AntseedWashTradingPointsPolicy` passes
  points through before the historical batch completes. Afterward it applies
  the shared proportional seller penalty and always returns zero buyer penalty.
- `AntseedWashTradingRewardPolicy` implements both seller reward hooks directly.
  Before `backfillComplete`, immediate rewards remain locked and historical
  claims retain 0 BPS. Afterward, unproven sellers retain 100% and proven
  sellers retain the proportional BPS returned by `WashPenaltyMath`.

`AntseedSellerRewardsPool` records cumulative earned and paid amounts. A claim
can pay at most `cumulativeRecorded × retainedBps / 10_000 - cumulativePaid`,
so repeated claims cannot gradually drain the withheld balance. A later stronger
proof can stop future payouts but does not claw back rewards already paid.

The exact guarantees, thresholds, pinned addresses/code hashes/storage slots,
journal schemas, explicit non-guarantees, and production commands are specified
in [`../../../loop-proof/README.md`](../../../loop-proof/README.md). That file is
the canonical human-readable proof contract; the pinned SP1 programs, receipt
verification, Base chain binding, and canonical-block checks are the executable
authority.

### Proof deployment gates

The safe deployment and release order is:

1. Finalize the detection AIP's penalty formula and threshold in
   `WashPenaltyMath`; deployment scripts intentionally reject the placeholder
   configuration.
2. Generate and approve the production proof manifest, ordered commitments,
   batch digest, vkeys, and count.
3. Deploy the registry with that exact count and digest, then install both
   policies while historical rewards are frozen and points pass through.
4. Verify or populate every required Chainlink BlockhashStore entry.
5. Simulate the single `submitBatch` call, validate calldata and gas, and send
   it only if the full transaction remains below the production limits.
6. Verify `backfillComplete`, every claim digest, every final subject ratio,
   and both policies after the same transaction succeeds.

```bash
# Verify or backfill required Chainlink BlockhashStore entries.
node scripts/backfill-blockhash-store.mjs --help

# Recompute the constructor digest, simulate and estimate the one atomic
# transaction, enforce gas/calldata limits, submit, and verify post-state.
node scripts/submit-wash-trading-proofs.mjs --help
```

Run the deterministic production-shaped Anvil lifecycle test to verify that
proof submission is blocked before canonical block backfill, interrupted
backfill resumes, and the atomic proof batch succeeds only after every required
block hash is present. The test deploys the real registry and policy contracts
with a local verifier fixture.

```bash
node --test --test-name-pattern="production-shaped proof submission" \
  scripts/backfill-blockhash-store.anvil.test.mjs
```

Set `BASE_MAINNET_RPC_URL` to additionally exercise the deployed Base
BlockhashStore against the pinned fork fixture.

Before proof submission, `verify-proof-volumes.mjs` requires the trusted public
key for the signed approved-claim baseline, refetches every selected settlement
receipt, and writes `antseed-proof-volume-report` v2. Submission remains blocked
unless baseline, planner, receipt-delta, and host-verified raw volumes are
exactly equal and no claim/evidence identity changed.

### Local P0 development submission

The Anvil-only harness accepts atomic development manifests containing only
`P0_CLOSED_LOOP` and `P0_RECIPROCAL` entries. It deploys local verifier and
BlockhashStore mocks, rebinds the manifest's atomic digest to that deployed
store, seeds every exact block hash, submits the batch, verifies wash records,
and confirms an identical replay returns `already-complete`.

```bash
anvil --chain-id 8453 --gas-limit 1000000000
node scripts/submit-aip4-proof-anvil.mjs \
  --manifest /path/to/development-proof-results.json \
  --rpc-url http://127.0.0.1:8545 \
  --submit-local
```

Development manifests and `proofBytes: 0x01` are rejected by the production
submission path and by this harness when the RPC URL is not loopback.

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

**Timeout (permissionless):**
- `requestTimeout(bytes32 channelId)` — after deadline, marks session timed out
- `withdraw(bytes32 channelId)` — after 15min grace, releases locked funds to buyer

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
| `TIMEOUT_GRACE_PERIOD` | 15 min | Grace period after requestTimeout before withdraw |
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
