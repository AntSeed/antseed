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
localhost only and the URL carries a one-time session token, so no other page
or process can act with your wallet. Read-only data refreshes on its own; any
action that sends transactions shows up as a pending indicator in the header,
with progress and transaction links in the **Activity** drawer and a toast when
it confirms. One signing action runs at a time.

The header shows the chain and protocol phase:

| Phase | Meaning |
|---|---|
| Legacy | Only the legacy emissions contracts are live; the dashboard shows legacy claims only |
| Deployed | The recognized-usage contracts are deployed and can be staked into, but reward accounting starts at the cutover epoch shown in the banner |
| Active | Usage points, staker rewards, and usage rewards accrue every epoch |

## Stake tab

Four tiles summarise your wallet: ANTS balance (with whether transfers are
enabled for this wallet), active stake, your power, and claimable rewards.

### Choosing a pool

The **Pools** table lists every seller agent that can be staked into, with the
data needed to decide where and for how long:

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

The **Stake ANTS** form takes a pool, an amount (**Max** fills the balance),
and a lock length on a slider that defaults to the maximum lock. Power
activates next epoch. Staking new ANTS requires transfers to be enabled for
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
withdraw without a penalty.

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

## Seller tab

For seller wallets: agent id, ERC-8004 identity, seller-registry binding,
eligibility to serve, pool active stake against the minimum, and the starter
grant for legacy sellers. **Register binding** binds your agent id in the
seller registry (required before anyone can stake into your pool).

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
