# AntSeedStats Observatory Parity

The scanner was compared against the supplied AntSeedStats Observatory exports and dossiers. The current report intentionally implements only the most reproducible P0/P1 rules.

## Reproduced surfaces

- First-ever Base native-ETH funder cohorts.
- Directed reciprocal settlement pairs.
- Seller and buyer money links through direct USDC transfers.
- Repeated relay paths from seller payouts toward a buyer-cohort funder.
- Material primary-USDC-funder cohorts.
- Seller names as presentation-only labels.

## Reciprocal-pair parity

For every directed AntSeed settlement edge, the scanner joins the reverse edge and computes:

```text
reciprocity = min(A → B, B → A) / max(A → B, B → A)
```

A pair is confirmed with at least 100 combined settlements and at least 80% reciprocity. On the frozen comparison scan this reproduces 24 pairs and 48 wallets.

## Material cohort rule

Shared first-ETH or primary-USDC funding becomes P1 only when the seller-level exposure reaches:

- at least 3 buyers;
- at least $1,000 settled volume; and
- at least 50% of seller volume.

A seller money-flow link upgrades the finding to P0 only when combined with a material primary-USDC-funder cohort.

## Deliberate exclusions

The report does not issue verdicts from timing synchronization, request similarity, lifecycle similarity, channel cadence, exact-value batches, flow-through balance, or a weighted seller score. Those patterns are easier to evade or require additional ground-truth validation.

## Comparison limits

- Compare scans at the same end block or timestamp.
- Shared infrastructure must be labeled before enforcement.
- Observatory prose and downloadable tables can disagree; the scanner follows recomputable tables and published thresholds.
- Suspected volume is an exposure estimate rather than a transaction-level proof of wash trading.
