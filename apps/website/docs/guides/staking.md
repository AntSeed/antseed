---
sidebar_position: 8
slug: /guides/staking
title: ANTS Staking
hide_title: true
---

# ANTS Staking

`antseed ants` opens a local staking dashboard for the recognized-usage
protocol: stake ANTS into seller pools, manage locked positions, claim or
restake rewards, and handle seller-side verification. Every dashboard action is
also a CLI command, so the dashboard is optional. The protocol mechanics
(epochs, pools, power, slashing, reward buckets) are described in
[Recognized usage](/docs/recognized-usage); this guide covers the
tooling.

## Opening the dashboard

```bash
antseed ants                # start on http://127.0.0.1:3119 and open the browser
antseed ants --no-open      # print the URL only
antseed ants --port 4000    # use another port
```

The dashboard opens in your system browser. Browse pools before connecting, then
connect a wallet to approve transactions. The dashboard cannot sign transactions
with the local identity key. Terminal commands still use that local identity.
The originating CLI/VPR buyer account remains separate: buyer usage rewards require
its on-chain authorized wallet, even when that differs from the buyer address.
If no wallet is authorized, use the existing payments authorization flow.
The dashboard binds to localhost and the URL carries a per-session authorization token. Keep
that URL private: possession of the token allows access to the local API.
Read-only data refreshes on its own; any
action that sends transactions shows up as a pending indicator in the header,
with progress and transaction links in the **Activity** drawer and a toast when
it confirms. One signing action runs at a time. Activity is saved for 30 days
under `ants-activity` in the data directory. Run only one signing dashboard for a given wallet and data directory.
After a restart, interrupted actions are marked for manual review. Check the
recorded transaction links and wallet state before retrying; the dashboard
does not automatically resubmit them.

The header shows the chain and protocol phase:

| Phase | Meaning |
|---|---|
| Legacy | Only the legacy emissions contracts are live; the dashboard shows legacy claims only |
| Deployed | The recognized-usage contracts are deployed and can be staked into, but reward accounting starts at the cutover epoch shown in the banner |
| Active | Usage points, staker rewards, and usage rewards accrue every epoch |

## Stake tab

Four tiles summarise your wallet: ANTS balance (with whether transfers are
enabled for this wallet), total staked (including pending positions), your power, and claimable rewards.
Your positions appear first. A failed wallet read is shown as an error;
actions wait until wallet data is available. Staking controls explain when
insufficient gas or transfer restrictions prevent an action.

### Choosing a pool

The **Pools** table defaults to stakeable sellers. Clear **Only show pools ready
for staking** to include sellers that still need a binding, with the data needed to
decide where and for how long:

| Column | What it tells you |
|---|---|
| Pool | Seller name from the explorer, or the agent id; rows marked not stakeable have no seller binding yet |
| APY · 1 month / APY · 1 year | Projected initial annualized returns for a 1,000 ANTS reference stake at each lock duration, using the last completed epoch |
| Active stake (ANTS) | Current active principal in ANTS |
| Last epoch (USDC) | Settled volume in the last completed epoch |
| Stakers | Number of stakers reported by the indexer; not number of positions |

Pool statistics, volume history, and closed positions come from the Antscan
indexer. Live wallet state and historical yield inputs are read from the chain. If the explorer is unreachable the table lists only the
pools you stake in and says so. Page sections load independently. Staker counts
fill in after the pool table appears; a missing count stays **—**. While browsing
without a connected wallet, the Stake page skips account position and reward
requests. Initial wallet synchronization leaves in-flight reads intact when the
account has not changed. Pool summaries
are cached for up to one minute and invalidated after dashboard transactions.
Matching Antscan epoch snapshots supply network statistics and historical power;
settled indexed rewards can be reused, while unsettled rewards and missing or
mismatched historical inputs are read from contracts in batches.

Staker rewards for a pool scale with the pool's usage points, and your share of
them with your power in the pool. A pool with high volume and little power pays
more per unit of power; a longer lock gives more power per ANTS. Click a row to
open the pool drawer with volume per epoch against the network, the seller's
explorer profile, and pool yield details.

The table uses the same completed epoch's pool rewards and pool power for both
lock durations. For a reference stake of 1,000 ANTS:

- Initial position power = amount × lock epochs.
- Projected epoch reward = pool rewards × position power / (historical pool power + position power).
- Epoch return = projected epoch reward / amount.
- APR = epoch return × (365 days / epoch duration).
- APY = (1 + epoch return) ^ (365 days / epoch duration) − 1.

These are initial-rate projections in ANTS terms, holding the historical pool
reward budget fixed. Normal position power decreases as the lock runs down;
changes in other stakes and activity can also affect returns. Compounding is
hypothetical, not automatic or guaranteed, and activation delay is excluded.
Missing historical data, zero historical power, or an unsupported lock shows
**—**. A valid epoch with no rewards shows **0%**. Hover for source epoch dates,
actual lock duration, and whether the reward amount is settled or estimated.

The month/year shortcuts use the nearest supported whole epoch: with weekly
epochs, 1 month is 4 epochs (28 days) and 1 year is 52 epochs (364 days). In the
staking modal, projected APY and the estimated first earning epoch's ANTS reward
update with the amount, pool, and lock slider. At 1,000 ANTS, the shortcuts match
the table's corresponding projections.

The pool drawer also shows the historical pool-average yield, calculated from
that epoch's rewards divided by active principal. This differs from a new
position's lock-specific projection. Click either APY column or the last-epoch
volume header to sort; click it again to reverse direction. Missing values stay
last.

Seller details show lifetime settlement volume, completed-epoch volume history,
request count, unique buyers and models served when the indexer provides them.
Unavailable/stale data is labeled. Model revenue breakdown is unavailable in this
release: request counts and usage points are not treated as USDC revenue.

### Staking

**Stake ANTS** opens a modal; a seller row's **Stake** button preselects that
pool. Choose the terms, then select **Review stake** to check the summary
before **Confirm stake** submits the action. **Back** preserves your entries;
**Cancel**, the close button, or Escape dismisses the modal.

The form takes a pool, an amount (**Max** fills the balance),
and a lock length on a slider that defaults to the minimum lock. The unlock
date includes the contract's activation delay as well as the selected lock.
Early withdrawal can burn part of the principal; review the displayed terms.
Staking new ANTS requires transfers to be enabled for
your wallet; rewards can be restaked regardless because they mint straight into
the pool.

### Positions

**Your positions** lists open lANTS positions with pool, amount, unlock epoch,
state, and pending reward. A position changed this epoch is marked pending and
cannot be withdrawn until next epoch. Split, merge, and move close the source
position and mint replacements; a closed position keeps the staker rewards it
earned up to its effective close epoch. The dashboard combines indexed history
with locally recorded, chain-verified position changes to keep those rewards
discoverable. Without an indexer, older closed positions unknown to this local
session may be missing.
The row menu offers:

- **Move allocation** to another pool; principal and lock are preserved, effective next epoch.
- **Split** an amount off into a second position with the same terms.
- **Merge** selected positions in the same pool with the same lock end.
- **Extend** the lock by extra epochs.
- **Max lock** on or off: constant maximum power instead of a countdown.

**Withdraw** shows the estimated principal burn for positions still under
lock and requires explicit consent before an early exit. Matured positions
withdraw without a penalty. A read-only dashboard can open the cost preview,
but cannot submit a withdrawal.

## Rewards tab

**Buyer rewards** shows rewards earned by the originating VPR/CLI account even
before a browser wallet connects. **Claim buyer rewards** collects its eligible
current and legacy rewards and pays the authorized deposits operator. Connect
that wallet to claim or restake; it can differ from the buyer account. If no
operator is configured, **Authorize wallet** opens the existing payments setup.
Returning to the dashboard refreshes authorization without clearing the page.
Legacy buyer rewards can be claimed but cannot be restaked.

**Wallet rewards** separately shows the connected wallet's staking, seller,
legacy seller, and locked-pool rewards. Its **Claim wallet rewards** and bulk
**Restake** actions exclude buyer rewards. Restaking creates locked positions;
the confirmation lets you choose the destination pool and lock length. Rewards
restake into their source pools first, then move to the chosen pool in the same
job. Individual category actions remain available. Terminal reward commands
retain their existing defaults, including all-category compounding.

Locked legacy rewards remain visible even when nothing is claimable. The
dashboard explains when the unlock policy is missing. If indexed reward
history fails to load, it shows an error instead of reporting a complete total
from only open positions. Without an indexer, a warning identifies that limit.

## Seller tab

For seller wallets: agent id, ERC-8004 identity, seller-registry binding,
eligibility to serve, pool active stake against the minimum, and the starter
grant for legacy sellers. Identity ownership and seller-registry binding are
shown separately. **Register binding** reuses a known agent id, or creates an
ERC-8004 identity for a wallet that does not own one, then binds it in the seller
registry (required before anyone can stake into your pool). You can also supply
an existing agent id. If creation succeeds but binding fails, Activity records
the new id to use when retrying. Legacy stake is shown in USDC; starter grant
availability is a count, separate from the ANTS amount of each grant.

**Wash-trading status** shows the registry facts and this seller's proven wash
share. Proof artifacts produced by the `antseed-loop-proof` host are submitted
from the CLI; submission is permanent and permissionless.

## Network and addresses

**Network** shows the emission schedule, gate buckets and their budgets this
epoch, dynamic staker and usage shares, and network volume per epoch.
**Addresses** lists every contract in use. These views remain available at the
`#/network` and `#/addresses` routes; the bottom navigation strip is hidden.

## CLI equivalents

```bash
antseed ants status                                   # phase, epoch countdown, balances, claimable rewards
antseed ants pools                                    # the Pools table
antseed ants pool 84990                               # one pool in detail
antseed ants stake 250 --agent 84990 --epochs 12
antseed ants positions
antseed ants move 7 --to 84991
antseed ants split 7 100
antseed ants merge 8 9
antseed ants extend 7 --epochs 4
antseed ants max-lock 7 [--off]
antseed ants withdraw 7 --preview                     # estimate first
antseed ants withdraw 7 --accept-slashing             # early exit with consent
antseed ants rewards                                  # all buckets
antseed ants rewards claim [--staker|--seller|--buyer|--legacy|--locked]
antseed ants rewards compound --epochs 8 --to 59096   # the Restake button
antseed ants rewards restake --epochs 8               # staker pool rewards only
antseed ants rewards stake-usage --side seller --epochs 8
antseed ants seller [register|claim-starter]
antseed ants verify [seller]
antseed ants verify submit seller-proof.json          # resumable
antseed ants verify proof <proofId>
antseed ants usage | emissions | addresses
```

Every read command accepts `--json`. See the
[command reference](/docs/commands#ants-staking) for options.

## Configuration

Contract addresses are discovered from the deployment record for the
configured chain; `payments.crypto.explorerApiUrl` and the per-contract
`*Address` overrides are described in
[Configuration](/docs/config#ants-staking).


## Staking in VPR

In VPR, choose **Manage staking ↗** on the Rewards page. It opens the same localhost
dashboard in your system browser, using VPR's selected network and original buyer
account. There is no staking sidebar entry or separate Electron staking window.
**Claim rewards ↗** opens the Rewards tab of that same dashboard. Both shortcuts
reuse the server session and preserve their destination through authentication.
Opening a page never submits a transaction. Old payments claim links show an
**Open rewards dashboard** handoff instead of a separate claim form; standalone
payments sessions explain how to open `antseed ants` when no host launcher exists.

VPR keeps the local server alive while the browser is open. Reopening reuses its
session. Wallet/network switching cancels unsigned steps; transactions already
submitted, or awaiting a response from an open wallet approval, remain tracked.
Wait for running actions before changing VPR's identity/configuration or quitting.

## Move allocation and withdraw

Each eligible position has **Move allocation**; bulk move remains available. Moving
uses the contract's move operation, preserves principal and the remaining lock
window, and takes effect at the displayed epoch. The preview shows the configured
future-power reduction and source rewards that remain claimable separately.
A partial move requires two wallet approvals: split, then move. Cancelling the
second step leaves the split positions. Maximum lock must be disabled first; pending
changes must become effective before another action can run.

Withdrawal has its own preview: principal returned, early-exit penalty sent to the
dead address, rewards still claimable separately, and whether received ANTS remain
transfer-restricted. It simulates the withdrawal before requesting approval.
Withdrawal does not claim rewards or make ANTS freely transferable. Recently closed
or moved source positions are recovered from confirmed local transactions while
the indexer catches up; without an indexer, older unknown closed positions may be missing.

## Local Anvil verification

From the worktree root, build and start a disposable restricted-transfer fork:

```bash
pnpm --filter @antseed/ants build
node scripts/ants-sandbox.mjs --restricted --browser --port 3136
```

The script prints its temporary directory and seeds an originating buyer with a
separate authorized wallet, existing positions, and claimable rewards. It changes
only local Anvil state. Global transfers remain disabled, and temporary setup
allowlisting is removed before the dashboard is exposed.

In another terminal, run the browser signing/API lifecycle checks:

```bash
node scripts/ants-browser-e2e.mjs /path/to/ants-sandbox-directory/scenario.json
```

These checks restore the original local chain state after each scenario. Do not
interact with that sandbox while the checks run. They cover separate buyer/signer
identity, rejection, claims, reward staking, compounding, position changes, penalties
and closed-position rewards. The new-stake scenario enables transfers only inside a
reverted snapshot. This protocol test does not substitute for wallet-extension UI QA.

For browser UI QA without a real wallet extension:

```bash
node scripts/ants-browser-qa.mjs /path/to/ants-sandbox-directory/scenario.json 3137
```

Open the sandbox dashboard URL with port **3137**, preserving its session token.
Connect **Anvil test wallet**. The **Anvil test controls** panel can switch between
the buyer and authorized accounts, simulate a wrong network, and reject the next
transaction. These controls exist only in the test proxy. It injects an ephemeral EIP-6963
provider; its transactions can only target the local Anvil chain. Do not publish
this proxy. Stop and rerun the sandbox for a fresh wallet and chain state.

On the **Stake** page, click **Stake ANTS** and choose **Stake from**:

- **Unclaimed buyer rewards**: select a pool and lock; the authorized wallet owns the new position.
- **Unclaimed seller rewards**: stake into the seller's own pool.
- **Staking rewards · position #…**: restake the selected position's rewards in its source pool. Indexing can require an approval before restaking.
- **Wallet balance**: disabled while the wallet cannot transfer ANTS.

Reward amounts use all eligible rewards from the selected source; legacy and
locked-pool rewards do not have a direct staking route. After confirmation,
check the new pending position and reduced rewards; the wallet ANTS balance
should remain unchanged. Sandbox yields and dates reflect seeded rewards and
simulated time, not production returns.

To run just the restricted-transfer source checks (including wrong wallet,
wrong network, rejection, and wallet-stake blocking):

```bash
node scripts/ants-browser-e2e.mjs /path/to/ants-sandbox-directory/scenario.json stake-sources
```

To verify VPR's browser launcher after building the desktop main process:

```bash
pnpm --filter @antseed/desktop build:main
pnpm --filter @antseed/desktop exec electron scripts/test-staking-window.mjs --data-dir /path/to/ants-sandbox-directory
```

The smoke test intercepts the system-browser launch, verifies that repeated launches
reuse one authenticated localhost session, and verifies no Electron staking window
or local transaction signer is created. Add `--open` to open the browser and keep
that test session alive, or `--bundle /path/to/AntSeed.app/Contents/Resources/app.asar`
to use packaged assets. Signed installer and real wallet-extension checks remain
separate release checks.
