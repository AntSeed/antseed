# M001 — Recognized usage cutover

Two broadcasts, one epoch apart. Run both through the deployment CLI:

```bash
pnpm contracts:deploy -- M001 --network <base-sepolia|base-mainnet> --dry-run
pnpm contracts:deploy -- M001 --network <base-sepolia|base-mainnet> --broadcast \
  --signer <role>=<wallet> [...]
```

The CLI reads live chain state and runs whichever phase is next. Rerunning
after a failure is safe: every step is idempotent.

## Signers

No private key is ever read by this repository. Each role is named on the
command line as `--signer <role>=<wallet>`; the CLI resolves the wallet to an
**address**, checks on chain that the address holds the role, passes the
address to the Solidity script, and hands the wallet selection to Foundry,
which prompts to unlock it at the moment it signs. Wallet forms:

| Form | Meaning |
| --- | --- |
| `account:<name>` | encrypted keystore in `~/.foundry/keystores` (`cast wallet import <name> --interactive`) |
| `keystore:<path>` | encrypted keystore file at a path |
| `ledger[:<index>]` | Ledger hardware wallet, HD index (default 0). One Ledger per run. |
| `unlocked:<address>` | RPC-unlocked account; Anvil / fork tests only |

Two roles held by the same key map to a single wallet flag. Foundry refuses
to broadcast when any `vm.startBroadcast(address)` has no matching wallet, so
a mis-mapped role fails before the first transaction. Dry runs need no
wallets: each role is simulated as its live on-chain owner.

The scheduler that waits for the epoch boundary therefore holds no secrets
while it sleeps; a person unlocks the keystore or confirms on the Ledger when
the boundary arrives.

## Broadcast 1 — `Deploy.s.sol`

Deploys the recognized-usage stack, moves ANTS mint authority to
`AntseedEmissionsGate`, funds the legacy escrow, and re-points legacy
emissions at it. Registry `emissions`/`staking` pointers are **not** touched:
the network keeps running on the legacy stack until the in-flight epoch
finalizes.

Signer: `--signer deployer=…` must own `ANTSToken` and the legacy emissions
contract (checked before anything is sent).

```bash
pnpm contracts:deploy -- M001 --network base-mainnet --broadcast \
  --signer deployer=account:antseed-owner
```

Writes `deployments/<network>/history/001-recognized-usage-deployed.json`.
Commit that record; broadcast 2 can then run from any machine.

## Broadcast 2 — `Cutover.s.sol` (next epoch)

The CLI pauses `AntseedChannels` 60 s before the epoch boundary so no usage can
land on the legacy ledger for the new epoch, waits for the boundary, runs
`Cutover.s.sol`, and unpauses **only** after verifying on chain that both
registry pointers reached the new stack. If the flip fails, Channels stays
paused: fix the cause and rerun, or force-unpause manually with the Channels
owner key.

`Cutover.s.sol` itself:

1. (staker key) syncs the DiemStakingProxy reward epochs and claims every
   pre-effective epoch whose pot is not yet funded, so each pot is stored with
   its real ANTS amount before the pointer moves.
2. (pool owner key) pins `AntseedSellerRewardsPool` to a dedicated registry
   facade so locked-path legacy sellers keep claiming.
3. (registry owner key) `setEmissions(usageAccounting)` and
   `setStaking(sellerRegistry)`.

Roles are never defaulted from one another. Required for the cutover:

| `--signer` role | Must be |
| --- | --- |
| `registryOwner` | `AntseedRegistry.owner()` |
| `channelsOwner` | `AntseedChannels.owner()` (signs pause/unpause via `cast`) |
| `deployer` | owner of the gate and points-policy registry from broadcast 1 (read-only check) |
| `diemStaker` | address with DIEM staked on the proxy (mainnet, or when `DIEM_STAKING_PROXY` is set) |
| `sellerRewardsPoolOwner` | `AntseedSellerRewardsPool.owner()` (same condition) |

On Base mainnet today every role is one of two EOAs, so the full command is:

```bash
pnpm contracts:deploy -- M001 --network base-mainnet --broadcast \
  --signer deployer=account:antseed-owner \
  --signer registryOwner=account:antseed-owner \
  --signer channelsOwner=account:antseed-ops \
  --signer sellerRewardsPoolOwner=account:antseed-ops \
  --signer diemStaker=account:antseed-ops
```

`USAGE_ACCOUNTING`, `SELLER_REGISTRY`, and the `EXPECTED_*` legacy addresses
are supplied by the CLI from the deployment record.

Writes `history/001-recognized-usage-activated.json` and updates
`current.json`.

## Post-flip checklist (manual)

- Create and seed an ANTS seller pool for the proxy's agent id right after the
  flip: usage of pool-less agents is not accounted, so the proxy earns nothing
  in the new stack until it has a pool.
- Do **not** renounce `AntseedEmissionsGate` ownership before the verification
  rollout: that rollout rotates the editable 10% controller from
  `VERIFICATION_WALLET` to `AntseedVerification`.
- `ANTSToken` and the remaining ownable contracts still require their
  separately reviewed production ownership handoff.
- Keep `AntseedRegistry` ownership: it is the only key that can open the
  temporary `setStaking(legacy)` window needed to withdraw the proxy's legacy
  USDC stake (`SellerRegistry.unstake` reverts by design).
- Sellers staked in legacy USDC staking stay eligible via the `SellerRegistry`
  legacy fallback. Call `setLegacyStakeEligibilityEnabled(false)` only after
  seller pools are seeded with ANTS stake.
- Sellers cannot stake ANTS into pools until they are transfer-whitelisted or
  transfers are enabled.
- Fund the `AntseedPositionInit` faucet with ANTS from a wallet that already
  holds them (temporarily whitelist that wallet as a sender via
  `ANTSToken.setTransferWhitelist`, transfer, then de-whitelist). Fund in small
  increments: the faucet has no owner and no sweep, leftovers strand forever.
  Grants staked before the flip epoch's boundary have power at the first
  rewarded epoch; later claims activate one epoch after staking.
- Legacy EmissionsV2 is registered against the escrow: all its claims and
  team/reserve flushes pay from the pre-minted pot. Sweep escrow leftovers only
  after legacy claim activity has wound down.
- Fallback for locked-path stragglers: `EmissionsV2.setSellerUnlockPolicy`
  (plain `onlyOwner`, works even after any registry renouncement).

## Local CLI rehearsal

Use the persistent M001 sandbox to rehearse CLI behavior on the same pinned Base mainnet fork as the migration fork test. The sandbox runs the deploy phase first and deliberately stops before cutover, preserving the Anvil process between commands.

```bash
export BASE_MAINNET_RPC_URL=https://your-archive-base-rpc.example
export ANTS_HOLDER=0x... # ANTS balance at BASE_MAINNET_FORK_BLOCK

pnpm m001:sandbox up --port 8545 --out .m001-sandbox
pnpm m001:sandbox status --out .m001-sandbox
```

The deploy command writes a copied deployment ledger and `.m001-sandbox/cli-config.json`. Point CLI commands at that file to verify legacy mode, then cut over and reuse the refreshed file:

```bash
antseed --config .m001-sandbox/cli-config.json --data-dir /tmp/antseed-m001 seller emissions info
antseed --config .m001-sandbox/cli-config.json --data-dir /tmp/antseed-m001 network contracts

pnpm m001:sandbox cutover --out .m001-sandbox
pnpm m001:sandbox fund-position-init 5 --out .m001-sandbox
pnpm m001:sandbox advance-epoch 2 --out .m001-sandbox
pnpm m001:sandbox fund-ants 0xYourCliWallet 100 --out .m001-sandbox

antseed --config .m001-sandbox/cli-config.json --data-dir /tmp/antseed-m001 seller pool bootstrap
antseed --config .m001-sandbox/cli-config.json --data-dir /tmp/antseed-m001 seller stake 100 --epochs 4
antseed --config .m001-sandbox/cli-config.json --data-dir /tmp/antseed-m001 seller pool positions

pnpm m001:sandbox down --out .m001-sandbox
```

Additional helpers are `fund-seller <address>`, `advance-epoch [n]`, `fund-ants <address> <amount>`, and `fund-position-init <n>`. The generated config carries all ledger-derived address overrides; the CLI still reads the registry and refuses commands if either active pointer disagrees.
