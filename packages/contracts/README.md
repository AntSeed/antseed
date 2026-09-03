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

### Recognized-Usage Cutover Foundation

`script/migrations/M001RecognizedUsage/Deploy.s.sol` deploys the shared
recognized-usage contracts before
the epoch-boundary registry flip. The deployment includes an empty
`AntseedPointsPolicyRegistry` and permanently points `AntseedUsageAccounting`
at that registry. Feature branches deploy and register their own penalty-policy
leaves; the foundation broadcast does not deploy or register wash-trading or
model-verification policies.

`script/migrations/M001RecognizedUsage/Cutover.s.sol` performs the matching
epoch-boundary activation. Both scripts require expected legacy addresses and
abort if the live Registry does not match them. Cutover re-checks that the 10%
verification bucket is editable, no policy is active, and both administrative
contracts remain owned by the deployer. After each non-fork broadcast, the
CLI records Foundry receipts using the append-only process in
`deployments/README.md`; it updates `current.json` only after activation checks pass.

Use the repository deployment CLI instead of invoking the Foundry scripts
directly:

```bash
# Simulate the next safe phase without sending transactions. A pre-boundary
# cutover review runs on a disposable Anvil fork advanced past the boundary.
pnpm contracts:deploy -- M001 --network base-sepolia --dry-run

# Broadcast on Base Sepolia. During cutover, the M001 scheduler waits until the
# pause window and epoch boundary, then prompts to unlock each wallet.
pnpm contracts:deploy -- M001 --network base-sepolia --broadcast \
  --signer deployer=account:sepolia-owner

# Rehearse both phases against a pinned Base-mainnet Anvil fork.
BASE_MAINNET_RPC_URL=https://... \
  pnpm contracts:deploy -- M001 --network base-mainnet --fork-test

# After the fork rehearsal and plan review, simulate or broadcast against Base mainnet.
pnpm contracts:deploy -- M001 --network base-mainnet --dry-run
pnpm contracts:deploy -- M001 --network base-mainnet --broadcast \
  --signer deployer=account:antseed-owner   # + cutover roles, see the M001 README
```

Testnet deployment phases require `BASESCAN_API_KEY`; the runner submits
new contracts for explorer verification as part of the broadcast.

A dry run writes `deployments/<network>/pending/<release>.plan.json` and a
matching `VALIDATION.md` describing every transaction it would send. Review
those artifacts rather than terminal output; a successful broadcast removes
them once the history record exists.

The cutover phase pauses `AntseedChannels` 60 seconds before the epoch
boundary, flips the registry pointers, and unpauses **only** after both
pointers are verified on chain. Any other outcome leaves Channels paused for a
human to resume, because settlements against a half-migrated ledger could not
be paid. M001-specific sequencing lives in `scripts/deployments/m001-cutover.mjs`;
the shared runtime contains only reusable guarded-maintenance primitives. Run
`pnpm contracts:check` to exercise both layers and the complete contract suite.

M001 supports Base Sepolia and Base mainnet dry runs and broadcasts. Before a
mainnet broadcast, run the pinned `--fork-test`, commit and review the generated
pending plan, and run `pnpm contracts:check -- <base-commit>`. Production
broadcasts still require a clean tree, one explicitly named wallet per signer
role (`--signer role=account:…|keystore:…|ledger`; none are defaulted from one
another and no private key is ever read by the repository), source
verification, explicit network confirmation, and the canonical Registry/ANTS
baseline. The cutover phase reads
its inputs from the committed `001-recognized-usage-deployed.json` record and
refuses to broadcast unless the local build matches the deployed code, so it
can run from any machine and any later commit that has not changed those
contracts. Operator runbook and post-flip checklist:
`script/migrations/M001RecognizedUsage/README.md`.

The CLI derives `ready`, `awaiting-epoch`, `cutover-ready`,
`cutover-incomplete`, `active`, or `invalid` from live RPC reads. A broadcast
requires typing the network name, while non-interactive automation must set
`ANTSEED_DEPLOY_CONFIRM` to that same name. Deployment records and validation
are automatic after each successful broadcast.

The same broadcast deploys `AntseedPositionInit`, an immutable starter-position
faucet for eligible legacy sellers. Fund it conservatively and have sellers call
`initPosition()` before the first rewarded epoch if their usage must count from
that epoch. Every starter position uses the shared `POSITION_INIT_END_EPOCH`, so
claiming later never gives a seller more power than an earlier claimant. The
faucet pins the deployed `AntseedWashTradingRegistry` (`WASH_TRADING_REGISTRY`,
required — deploy the registry before M001) and refuses sellers it has proven
as wash traders, so a wash trader never gets the starter position that would
switch their recognized-usage accounting on. The `--fork-test` mode deploys an
always-false stub when `WASH_TRADING_REGISTRY` is unset, because the pinned
fork predates the registry.

The verification emission bucket initially remains controlled by
`VERIFICATION_WALLET`. A separate verification deployment may transfer that
controller to its rewards contract.
M001 leaves the bucket at 10% and editable, registers no points policies, and
leaves `AntseedEmissionsGate` and `AntseedPointsPolicyRegistry` owned by the
deployer.
Do not renounce gate ownership or replace/lock the verification minter before
that rollout has transferred the controller and passed its post-deployment checks.
Run `M001RecognizedUsageFork.t.sol` with `BASE_MAINNET_RPC_URL` to validate the
live canonical starting state. Set `BASE_MAINNET_FORK_BLOCK` when using an
archive-capable RPC to pin the check to a specific block.

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
