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

The dashboard signs with the node wallet in your data directory. It binds to
localhost only and the URL carries a per-session authorization token. Keep
that URL private: possession of the token allows access to the local API.
Read-only data refreshes on its own; any
action that sends transactions shows up as a pending indicator in the header,
with progress and transaction links in the **Activity** drawer and a toast when
it confirms. One signing action runs at a time. Activity is saved for 30 days
under `ants-activity` in the data directory, separately for each chain and
wallet. Run only one signing dashboard for a given wallet and data directory.
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
enabled for this wallet), active stake, your power, and claimable rewards.
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
| Power | The pool's staking power this epoch and its share of all pools |
| Volume | Settled USDC this epoch and last epoch |
| Reward / 1k power | Staker ANTS paid per 1,000 power last epoch, and the projection for this epoch from usage so far (marked *est.* until the epoch settles) |
| Your power | Your power in the pool and your share of it |

Pool statistics, volume history, and closed positions come from the Antscan
indexer; the dashboard reads the chain only for your own wallet and when it
sends transactions. If the explorer is unreachable the table lists only the
pools you stake in and says so.

Staker rewards for a pool scale with the pool's usage points, and your share of
them with your power in the pool. A pool with high volume and little power pays
more per unit of power; a longer lock gives more power per ANTS. Click a row to
open the pool drawer with volume per epoch against the network, the seller's
explorer profile, and your positions in that pool.

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
earned up to that epoch, but it drops out of the on-chain position list, so
claim its rewards before restructuring or claim them later by id with
`antseed ants rewards claim` once an explorer index exposes closed positions.
The row menu offers:

- **Move** to another pool; principal and lock are preserved, effective next epoch.
- **Split** an amount off into a second position with the same terms.
- **Merge** selected positions in the same pool with the same lock end.
- **Extend** the lock by extra epochs.
- **Max lock** on or off: constant maximum power instead of a countdown.

**Withdraw** shows the estimated principal burn for positions still under
lock and requires explicit consent before an early exit. Matured positions
withdraw without a penalty. A read-only dashboard can open the cost preview,
but cannot submit a withdrawal.

## Rewards tab

Restaking is the primary action: **Restake** compounds every restakable bucket
(staker pool rewards with the restake weight bonus, seller usage rewards, and
buyer usage rewards when the wallet is its own deposits operator) into new
locked positions. The confirmation lets you pick the pool that should hold the
new positions and the lock length. Rewards restake into their source pool
first and are then moved to the chosen pool in the same job.

**Claim** sends rewards to the wallet instead. Buckets are listed
individually: staker pool rewards, seller usage, buyer usage, legacy V2
emissions, and the locked legacy pool. Buyer usage rewards are paid to the
deposits operator, so they are claimable here only when the node wallet is its
own operator.
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

## Footer

**Network** shows the emission schedule, gate buckets and their budgets this
epoch, dynamic staker and usage shares, and network volume per epoch.
**Addresses** lists every contract in use. A theme toggle switches between the
light and dark look.

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
