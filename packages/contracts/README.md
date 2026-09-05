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
Groth16 proof and verifier, and authenticate every committed block reference
against Chainlink's public `BlockhashStore` on Base
(`0x78b69899C8cD252126cBB1A50171ec37286C3877`). Chainlink's store reverts for
unknown blocks; the registry maps that revert to `bytes32(0)` so its own
`NonCanonicalBlock` error fires instead. No AntSeed-owned contract sits in the
block-hash path. A staged proof changes no seller result until every committed block-reference
chunk has been authenticated. The registry stores the greatest proven
wash-volume lower bound for each seller as `{provenWashVolume, totalSellerVolume, evidenceDigest}`.
The total is the authenticated period-end channels counter; this enforcement period
starts at protocol genesis, so no opening counter is subtracted. The registry exposes
`provenWashShareBps(seller)` as `provenWashVolume * 10000 / totalSellerVolume`.
Later proofs must strictly increase the seller's proven wash volume and preserve
the recorded total. Zero totals and mismatched replacement totals are rejected.

For a Base-fork rehearsal, the development submission script also accepts
`--use-chainlink-blockhash-store`. This uses the existing Chainlink store without
seeding or replacing it, while retaining the digest-pinned development verifier.
Missing hashes must be backfilled on the local fork before finalization can pass.
The RPC remains restricted to loopback URLs; this mode is not a live deployment
or a test of real Groth16 proof verification.

The updated seller guest uses a fixed 50% return-coverage floor for closed-loop
evidence (`returnedCredit / provenWashVolume`), distinct from the registry's
`provenWashShareBps` ratio (`provenWashVolume / totalSellerVolume`). The floor is
pinned by the guest vkey, not a mutable registry setting. Each seller input contains
exactly one closed-loop or reciprocal evidence bundle.

The current total-volume witness requires a nonzero seller-to-agent binding at
period end. Unstaking clears that binding, so those sellers currently fail proof
generation even if historical wash evidence exists. The agent counter excludes
settlements made without an agent binding; it is not an unconditional wallet-wide
lifetime-volume total. Supporting historical bindings requires a separately
validated predicate update and a new guest vkey.

Prepare the immutable constructor values from any schema-1 direct seller proof
produced by the pinned seller program:

```bash
SELLER_PROOF=/path/to/loop-proof/out/production/sellers/0x....json
export WASH_TRADING_SELLER_PROGRAM_VKEY=$(jq -r .sellerProgramVKey "$SELLER_PROOF")
export HISTORICAL_PERIOD_START_BLOCK=$(jq -r .periodStartBlock "$SELLER_PROOF")
export HISTORICAL_PERIOD_END_BLOCK=$(jq -r .periodEndBlock "$SELLER_PROOF")
# Chainlink BlockhashStore on Base mainnet. The deploy script defaults to this
# address and refuses any other store on chain ID 8453.
export WASH_TRADING_BLOCKHASH_STORE=0x78b69899C8cD252126cBB1A50171ec37286C3877
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

The direct proof journal uses schema 1 and contains no child-program vkeys.
Its ABI includes `uint128 totalSellerVolume` immediately after `uint128 provenWashVolume`.
Previous journal encodings and guest vkeys are incompatible: build the new guest
and deploy a new registry with its matching seller vkey before production submission.
The registry verifies every seller proof against only
`WASH_TRADING_SELLER_PROGRAM_VKEY`; the proof itself re-runs the closed-loop and
reciprocal predicates over raw authenticated evidence.

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
whenever `sp1-sdk` is bumped. Complete the Chainlink backfill below first
(the registry only reads hashes, so a proof whose blocks are missing from the
store cannot be authenticated), then deploy the registry:

```bash
forge script script/DeployWashTradingRegistry.s.sol --rpc-url <rpc> --broadcast
```

After deployment, call `stageSellerProof`, submit each artifact chunk with
`authenticateBlockReferences(proofId, ...)`, then call
`finalizeSellerProof(proofId)`. The contract never adds claims onchain and never
accepts a lower or equal result.

### Backfill historical Base block hashes

Production seller proofs authenticate every committed Base block hash against
Chainlink's `BlockhashStore`, which only holds hashes that were stored while the
block was inside the EVM's 256-block `blockhash()` window. Every other hash the
proofs need is written into the same store permissionlessly with
`storeVerifyHeader(n, rawHeader(n + 1))`, walking the parent-hash chain
backwards from the nearest block Chainlink already knows. Generate a
digest-pinned plan containing the exact missing proof targets and the anchor
each walk starts from:

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

### Executing the Chainlink backfill

Each header becomes one `storeVerifyHeader(n, rawHeader(n + 1))` call; ~138 of
them are packed per transaction through the canonical `Multicall3`
(`0xcA11bde05977b3631167028862bE2a173976CA11`), which is atomic, so one
transaction either stores a whole descending run of hashes or nothing. Chainlink
verifies `keccak256(header)` against the hash it already holds for `n + 1` and
stores the header's `parentHash` as `hash(n)`; the executor additionally checks
the same chain locally against the cached headers and the proofs' committed
hashes before sending. Measured cost is ~36k gas per header, of which ~20k is
Chainlink's storage write.

Dry run (estimates gas for the first batch, sends nothing):

```bash
node scripts/execute-wash-trading-chainlink-backfill.mjs \
  --plan "$BACKFILL_PLAN" \
  --rpc-url "$BASE_RPC_URL" \
  --header-cache "$HEADER_CACHE" \
  --checkpoint "$HEADER_CACHE/mainnet-chainlink-backfill.checkpoint.json" \
  --batch-size 150
```

Test the exact transaction path against a Base-forked Anvil (`anvil --fork-url
"$BASE_RPC_URL" --port 8555`) by adding `--execute --approve-plan-digest
"$BACKFILL_PLAN_DIGEST"` with `--rpc-url http://127.0.0.1:8555`. Live Base
execution additionally requires `BACKFILL_PRIVATE_KEY` and the explicit
`--allow-live` guard. Start with one batch, inspect the receipt and the stored
hashes on Chainlink, then repeat the same command without `--maximum-batches`
to resume:

```bash
export BACKFILL_PLAN_DIGEST=$(jq -r .digest "$BACKFILL_PLAN")
export BACKFILL_PRIVATE_KEY=<funded-base-private-key>
node scripts/execute-wash-trading-chainlink-backfill.mjs \
  --plan "$BACKFILL_PLAN" \
  --rpc-url "$BASE_RPC_URL" \
  --header-cache "$HEADER_CACHE" \
  --checkpoint "$HEADER_CACHE/mainnet-chainlink-backfill.checkpoint.json" \
  --batch-size 150 \
  --in-flight 4 \
  --maximum-batches 1 \
  --execute \
  --allow-live \
  --approve-plan-digest "$BACKFILL_PLAN_DIGEST"
```

`--in-flight N` keeps N transactions pending with consecutive nonces and
settles them in order; every range is checkpointed only after its receipt
succeeds and the required hashes read back from Chainlink. Ranges longer than
one batch resume through the per-range `cursors` in the checkpoint because the
previous transaction already stored the hash the next one verifies against.

Never delete or replace the checkpoint during a live run. Base's sequencer
rejects raw transactions above 128 KiB, which is what bounds the batch to ~138
headers. Backfilling does not submit seller proofs; after all ranges complete,
deploy the registry against the Chainlink store, then stage, authenticate, and
finalize the existing paid seller proof artifacts.

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
at that registry. Feature branches deploy and register their own points-modifier
leaves; the foundation broadcast does not deploy or register wash-trading or
model-verification modifiers.

`script/migrations/M001RecognizedUsage/Cutover.s.sol` performs the matching
epoch-boundary activation. Both scripts require expected legacy addresses and
abort if the live Registry does not match them. Cutover re-checks that the 10%
verification bucket is editable, no policy is active, and both administrative
contracts remain owned by the deployer. After each non-fork broadcast, the
CLI records Foundry receipts using the append-only process in
`deployments/README.md`; it updates `current.json` only after activation checks pass.

#### Operator walkthrough: deploy, then start the waiting cutover process

**There are two separate CLI runs. The first deploys and exits. The second
stays running, waits for the next epoch boundary, and performs the cutover.**
The CLI chooses the phase from live chain state; there is no separate
`deploy`/`cutover` subcommand and no background scheduler after the CLI exits.

Run the commands below from the repository root. These examples target Base
mainnet. Before starting, configure the RPC, explorer API key, deployment
inputs, and wallets described in
[the M001 runbook](script/migrations/M001RecognizedUsage/README.md).
The required wash-trading registry must already be deployed. Account names
below are examples, not defaults: each wallet must hold its named on-chain
role. Deploy well before the boundary; the deployment script refuses to start
with one hour or less remaining in the current epoch.

**1. Rehearse, simulate, and review deployment.**

```bash
# Rehearse both phases against a pinned Base-mainnet Anvil fork.
BASE_MAINNET_RPC_URL=https://... \
  pnpm contracts:deploy -- M001 --network base-mainnet --fork-test

# Simulate deployment against the configured mainnet RPC without sending transactions.
pnpm contracts:deploy -- M001 --network base-mainnet --dry-run
```

Review the generated pending plan and `VALIDATION.md`, commit the reviewed
artifacts, and run `pnpm contracts:check -- <base-commit>` before broadcasting.

**2. Broadcast deployment. This command finishes and exits.**

```bash
pnpm contracts:deploy -- M001 --network base-mainnet --broadcast \
  --signer deployer=account:antseed-owner
```

This deploys the new stack, moves ANTS mint authority to the emissions gate,
funds the legacy escrow, and connects legacy emissions to that escrow. It
does **not** flip Registry `emissions`/`staking` pointers or pause Channels;
the network continues using the legacy stack.

The CLI prints the cutover timestamp and writes
`packages/contracts/deployments/base-mainnet/history/001-recognized-usage-deployed.json`.
Commit and share that record before handing the cutover to another operator.
The timestamp is the activation boundary, **not the time to start the second
command**. Even if the deployment output says to rerun after that time, start
the cutover process before its pause window as described below.

**3. Review cutover before the boundary.**

```bash
pnpm contracts:deploy -- M001 --network base-mainnet --dry-run
```

Because deployment is now recorded, the same command simulates the next phase:
cutover. It advances a disposable Anvil fork to the boundary rather than
waiting or pausing live Channels. Review and commit this phase's generated
plan and validation document, and rerun the checks before broadcasting.

**4. Start the cutover command early and leave it running.**

```bash
pnpm contracts:deploy -- M001 --network base-mainnet --broadcast \
  --signer deployer=account:antseed-owner \
  --signer registryOwner=account:antseed-owner \
  --signer channelsOwner=account:antseed-ops \
  --signer sellerRewardsPoolOwner=account:antseed-ops \
  --signer diemStaker=account:antseed-ops
```

Start comfortably before **boundary minus 60 seconds**, complete the initial
checks and network confirmation, and keep the machine awake and connected.
The process waits locally; it does not schedule a future on-chain transaction.
Keep the signing operator available for wallet unlocks or hardware approvals.

```text
Wait until boundary − 60 seconds
  → Sign and submit Channels.pause()
  → Wait until the effective epoch has started on chain
  → Prepare legacy rewards and flip Registry emissions/staking pointers
  → Verify both pointers on chain
  → Sign and submit Channels.unpause()
  → Write activation history and current.json, then exit
```

The 60-second window is when the CLI attempts to pause, not a guarantee of
timely transaction inclusion. Allow for signing and confirmation delays. If
the window is missed, stop and reconcile with the migration operator rather
than treating a late run as the normal procedure.

**5. Verify completion and hand off.**

Review and commit `001-recognized-usage-activated.json` and the updated
`current.json`, and complete the M001 runbook's manual post-flip checklist.
A subsequent invocation against those records and the completed on-chain
state reports `M001 is already active; no transactions required.`
If execution fails during the flip, inspect the receipts and live state; do
not blindly unpause Channels or start a new deployment.

For Base Sepolia, use `--network base-sepolia` and its configured wallets/RPC.
Cutover requires `deployer`, `registryOwner`, and `channelsOwner`; the two
legacy-proxy roles are also required when `DIEM_STAKING_PROXY` is configured.
Non-fork deployment phases require `BASESCAN_API_KEY` for explorer verification.

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

#### Shared fork-test framework

`--fork-test` runs a practice deployment on one disposable, pinned Anvil fork;
it never broadcasts to the source network. The deployment runtime loads
`packages/contracts/.env`, copies the repository deployment ledger into a
temporary directory, and runs the selected migration's declared prerequisites
before its own rehearsal. Each prerequisite runs once, in dependency order.
Missing prerequisites, cycles, unsupported networks, and conflicting fork
configurations fail before Anvil starts. Real `--dry-run` and `--broadcast`
commands do not execute prerequisites automatically.

Migration modules declare `rehearsal: { prerequisites, fork, run }` alongside
their normal phases. `prerequisites` lists registered migration IDs. `fork`
contains `rpcEnv`, `forkBlockNumber`, and `chainId`; a later migration can omit
it to inherit its prerequisites' configuration. All migrations in a rehearsal
must use the same fork. No migration imports another migration's test helper.

The `run({ rpcUrl, outputRoot, network, runMigration })` hook owns only its
migration-specific fixtures, time advancement, and success checks. Its bound
`runMigration({ environment, signers })` driver runs that migration's next phase
in broadcast mode against the local fork, with isolated records and no live
wallet arguments inherited from the CLI. M001's hook prepares owners and its
wash-registry fixture, deploys, advances past the cutover boundary, activates,
and checks an idempotent rerun.

Later migrations read the temporary ledger updated by their prerequisites.
That ledger never regenerates repository chain configuration. The framework
stops Anvil on success or failure and prints the retained temporary records'
location for inspection; remove that directory manually when no longer needed.

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
