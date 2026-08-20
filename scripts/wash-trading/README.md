# Historical Wash-Trading Scanner

This scanner analyzes public AntSeed settlement and Base money-flow data using a minimal deterministic P0/P1 model. It reports investigation leads; only qualifying reciprocal settlement pairs are marked confirmed.

## Run

```bash
ANTSEED_BASE_RPC_URL='https://base-mainnet.g.alchemy.com/v2/YOUR_KEY' \
pnpm run wash-trading:scan -- \
  --request-timeout-ms 120000 \
  --max-retries 8 \
  --blockscout-concurrency 4
```

Resume a saved checkpoint:

```bash
ANTSEED_BASE_RPC_URL='https://base-mainnet.g.alchemy.com/v2/YOUR_KEY' \
pnpm run wash-trading:scan -- \
  --resume ~/.antseed/forensics/wash-trading/scans/<scan> \
  --request-timeout-ms 120000 \
  --max-retries 8 \
  --blockscout-concurrency 4
```

The scanner freezes the historical period in `manifest.json`. AntScan pages, RPC results, Blockscout responses, and address summaries are cached, so resume reuses completed work.

Emit the immutable enforcement input before report compaction by supplying the
exact Base block period:

```bash
pnpm run wash-trading:scan -- \
  --proof-output ./proof-bundle-v1.json \
  --start-block 44471575 \
  --end-block-exclusive 49936173
```

The bundle contains one deterministic claim leaf per P0/P1 finding and the
onchain dependency locators needed to prove it. Governance approves the
bundle's `reportRoot`; the zkVM proves selected dependencies belong to that
root and exist in canonical Base blocks. Completeness-dependent report facts
remain rooted in the approved bundle in v1.

## Verdict model

### P0 — decisive evidence

- **Reciprocal payments:** two wallets settle in both directions with at least 100 combined settlements and at least 80% volume reciprocity.
- **Seller–funder money link:** non-protocol USDC transfers directly connect the seller and the material primary-USDC funder.
- **Seller–buyer money link:** non-protocol USDC transfers directly connect the seller and buyers in the material cohort.
- **Money returns through relays:** at least three repeated seller-payout paths forward matching value through intermediaries toward the cohort funder.

The three money-link rules produce P0 only when a material shared primary-USDC-funder cohort is also present.

### P1 — strong control evidence

- **Shared first ETH funder:** buyers received their first observed Base ETH from the same address.
- **Shared primary USDC funder:** the same address was the largest observed USDC funding source for several buyers, counting direct transfers and attributed protocol deposits.

A P1 cohort must cover at least 3 buyers, at least $1,000 of settled volume, and at least 50% of the seller's total volume.

No timing, behavioral-similarity, flow-through, batch-triage, or score-tier rule creates a verdict.

## Volume

P1 attributed volume is the unique settled volume from buyers belonging to material first-ETH-funder or primary-USDC-funder cohorts. Buyer addresses are unioned across both cohort types, so a buyer present in both is counted once. P0 seller suspected volume remains settled volume from buyers that routed at least 99% of their observed AntSeed spend to the seller. Reciprocal-pair suspected volume is gross settled volume in both directions. These figures identify evidence-linked activity but do not determine that every included settlement was wash traded.

## Output

Each scan contains:

- `index.html`: offline P0/P1 report and methodology.
- `scan.json`: machine-readable P0/P1 summary.
- `sellers/<address>.json`: raw per-seller forensic evidence.
- `network/funders.csv`: shared first-ETH-funder cohorts.
- `network/reciprocal-pairs.csv`: confirmed reciprocal pairs.
- `manifest.json` and `checkpoint.json`: immutable inputs and resume state.
- `proof-bundle-v1.json`: optional deterministic enforcement claims and dependencies.

Open `index.html` directly in a modern browser; no local server is required.

## Limitations

- Names and imported labels are presentation-only.
- Shared funding does not by itself prove common beneficial ownership.
- Missing traces are never treated as proof that a link does not exist.
- High-volume exchange, router, paymaster, and treasury infrastructure is skipped after the configured auxiliary-transfer cap.
- USDC is fungible; an ordered money path does not prove that identical token units returned.
