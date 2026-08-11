# Model Verification

AntSeed model verification is integrated into the existing `antseed verifier`
CLI and the already-running buyer proxy. It does not start a second verifier
daemon or expose a new buyer-proxy endpoint.

The verifier builds append-only KBF probe banks from a trusted reference
endpoint, reserves one powered subset per model and epoch, uses that exact
subset for every seller audited for the model in the epoch, sends two probe
batches concurrently through the buyer proxy, and records the buyer node's
verified `ResponseAuth` for every successful batch.

## Commands

```text
antseed verifier reference build <model>
antseed verifier reference build --all
antseed verifier run <model>
antseed verifier run --all
antseed verifier run --all --allow-probe-reuse
antseed verifier run --resume-run <run-id>
antseed verifier run <model> --resume-run <run-id>
antseed verifier status [--json]
antseed verifier submit --run-id <run-id> --dry-run
antseed verifier submit --run-id <run-id> [--yes]
antseed verifier claim
```

`<model>` and `--all` are mutually exclusive and exactly one is required for
`reference build` and `run`. All-model commands continue after per-model
failures and exit nonzero if any model or peer fails. Reference builds and
audit runs use bounded concurrency across models and sellers.

`run --resume-run <run-id>` creates a new immutable repair run for only the
`UNDETERMINED` sellers in the source run. A model argument may narrow the repair
to one source model. The verifier rejects repairs when the epoch, seller,
service, reference ID, query-profile hash, or assigned probe IDs differ. Within
the same epoch, a normal `run` also discovers an interrupted or most-recent
undetermined run and repairs only its unresolved batches. Use a fresh epoch or
finish the repair before intentionally starting another complete audit.

`reference build --all` skips a model when its existing bank can produce a
reference that satisfies the configured sizing, coverage, self-test, and
statistical-power requirements. Building an explicit `<model>` always runs and
can be used to replenish or intentionally expand that model's bank.

`reference build` creates a powered reference and appends its probes and
per-probe self-test outcomes to the model's bank. `run` never calls the trusted
reference endpoint. It uses the verification contract's epoch when an address
is configured; otherwise it uses UTC calendar days (`YYYY-MM-DD`). It resolves
the buyer snapshot and ResponseAuth database once, then processes models and
eligible peers through bounded worker pools.

## Configuration

```yaml
verifier:
  responseAuthWaitTimeoutMs: 35000
  probeRequestTimeoutMs: 120000
  auditMaxConcurrentModels: 3
  auditMaxConcurrentPeersPerModel: 4
  auditMaxConcurrentBatches: 12
  auditMaxConcurrentBatchesPerPeer: 2
  auditConcurrencyPromotionLatencyMs: 30000
  auditPeerTimeoutMs: 600000

  contrastSelection:
    catalogSource: openrouter
    inputWeight: 0.90
    maxPriceRatio: 0.30
    maxModels: 3
    minimumIntelligenceIndex: 30

  referenceMinimumProbeCount: 100
  referenceMaximumProbeCount: 500
  referenceProbeStep: 10
  referenceMinimumStatisticalPower: 0.90

  referenceEndpoint:
    baseUrl: https://openrouter.ai/api/v1
    apiKeyEnv: OPENROUTER_API_KEY
    sourceId: openrouter-v1
    trust: trusted

    models:
      claude-opus-5:
        enabled: true
        upstreamModel: anthropic/claude-opus-5
      claude-sonnet-5:
        enabled: true
        upstreamModel: anthropic/claude-sonnet-5
      gpt-5.6-sol:
        enabled: true
        upstreamModel: openai/gpt-5.6-sol
```

`banksDir` and `evidenceDir` are optional. When omitted, they default to
`<dataDir>/verifier/banks` and `<dataDir>/verifier/evidence`, so the normal
`~/.antseed` data directory needs no reusable-path configuration.

With `catalogSource: openrouter`, `reference build` fetches `/api/v1/models`
once at command startup. Audited-model and candidate prices come from each
model's `pricing.prompt` and `pricing.completion`. Candidate capability comes
from `benchmarks.artificial_analysis.intelligence_index`; models without that
score are not automatic contrast candidates. Manual model pricing,
`contrastModels`, and `contrastModelBank` should be omitted when automatic
selection is desired.

The audited model's `upstreamModel` remains the trusted source of ground-truth
answers. Cheap models are contrasts only. Automatic selection computes:

```text
blended cost = input price × inputWeight + output price × (1 - inputWeight)
```

Candidates must cost at most the audited model's blended cost multiplied by
`maxPriceRatio`. Disabled candidates and the target upstream model are excluded.
Candidates below `minimumIntelligenceIndex` are excluded. Eligible candidates
sort by Artificial Analysis Intelligence Index descending, blended cost
ascending, then OpenRouter model ID. The verifier selects up to `maxModels` and
fails when none qualify. A non-empty explicit `contrastModels` list overrides
automatic selection and may contain at most three entries.

The default policy is 90% input weighting, a 30% maximum price ratio, and three
contrast models. `reference build` stores the selected contrasts in the probe
bank. Audit runs use that stored selection and do not refresh the OpenRouter
catalog or create billable reference traffic implicitly.

Reference builds persist integer USD micro-costs from OpenRouter response usage
and the catalog price snapshot. Costs are grouped by model and by purpose:
candidate generation, target-model stability checks, contrast-model checks, and
the final target-model self-test. Cached responses resumed from the same
unfinished checkpoint are charged once when that completed reference is first
appended to the bank. A reference ID already present in the bank does not create
a second claimable cost entry.

## Probe Banks

Probe banks and per-seller ledgers are stored at:

```text
<banksDir>/<model-slug>/
├── bank.json
├── epochs/<epoch>.json
└── sellers/<peer-id-hash>.json
```

Successful reference builds append probes and self-test outcomes. Repeated probe
IDs are deduplicated only when their canonical probe content and self-test
evidence match. The append is rejected when an ID conflicts or when model,
query-profile, provenance, or statistical assumptions are incompatible.

Before the first seller dispatch for a model and epoch, the verifier
cryptographically shuffles eligible bank probes. It evaluates configured
10-probe sizing steps and persists the first subset meeting coverage, self-test
error, and statistical-power requirements in `epochs/<epoch>.json`. Every
seller reservation in that model and epoch records the same reference ID and
ordered probe IDs, including later runs and repair runs. Seller audit IDs and
ledgers remain independent.

By default, a newly created epoch reference excludes probes used by persisted
references from earlier epochs. `--allow-probe-reuse` allows a new epoch
reference to select those earlier probes again. It never changes the already
persisted reference for the current epoch. Deterministic first-batch
ineligibility responses void only that seller's assignment; the shared epoch
reference remains available to the other sellers. Historical reservations made
before epoch references were introduced retain their original probe subsets.

## ResponseAuth

`verifier run` opens `<dataDir>/verification.db` once using the exported
`VerificationStorage`. Only peers advertising
`verification.response-auth.v1` are scheduled; advertised peers without it are
recorded as skipped. A first-batch buyer-policy rejection or structured
`model_not_found` response also stops the audit, voids its probe reservation,
and records a reasoned `SKIPPED` entry plus evidence. Peers that never advertised
the model are not included in that model's report.

After each successful proxy response, the verifier reads
`x-antseed-request-id` and polls `getResponseAuth(requestId)` every 100 ms for up
to `responseAuthWaitTimeoutMs`. The stored record must be verified and match the
request ID, seller peer ID, and advertised service.

Evidence schema v1 includes the stored ResponseAuth record and its local
verification status for every exchange. If any successful batch lacks valid
authenticated evidence, observations are preserved but the audit verdict is
forced to `UNDETERMINED`. This evidence includes local proxy request/response
observations and signed hashes; it is not claimed to be an independently
reproducible wire transcript or payment-evidence pack.

Each successful exchange also records the buyer proxy's token counts, selected
seller prices, token-count source, and estimated USD cost. Audit, model, epoch,
and status summaries aggregate these values. Missing or partial telemetry is
not treated as zero-cost work: summaries retain a `missingCostExchangeCount` so
operators can distinguish a complete estimate from a partial one.

## Runtime and Artifacts

Models and their eligible peers are processed through bounded worker pools.
Defaults allow three models, four peers per model, twelve total buyer-proxy
batches, and up to two batches per seller audit concurrently. Each seller audit
starts with one batch. A successful authenticated first batch completing within
`auditConcurrencyPromotionLatencyMs` promotes that seller to its configured
per-audit maximum; any HTTP 429 permanently reduces the remainder of that audit
to one batch at a time. A shared seller lock prevents one seller from being
audited for multiple models simultaneously. Transient proxy failures use
bounded retries. Each seller audit has a hard ten-minute wall-clock deadline
that starts when its first batch acquires global execution capacity, aborts
every remaining batch, and finalizes the seller as `UNDETERMINED`. Each request
retains its 120-second timeout. Retryable `408`, `429`, `5xx`, payment-lock
timeouts, and semantic temporary-unavailable responses receive at most five
attempts with bounded exponential backoff, jitter, and `Retry-After` support.
Temporary unavailability, throttling, and request timeouts remain
`UNDETERMINED`; only deterministic policy or stale-advertisement responses are
classified as skipped.

Every completed batch is atomically checkpointed with its answers,
`ResponseAuth`, cost, and structured failure reason. Repairs reuse only
successful authenticated batches and resend failed, missing, or invalid-auth
batches. The repair artifact links to its parent audit and reports incremental
repair cost separately from cumulative audit cost. A deterministic first-batch
failure stops pending work and voids the reservation; an exhausted transient
first batch stops redundant work but preserves the reservation for resume.

One PID-aware run lock prevents concurrent verifier runs from reserving the same
seller probes. Stale locks are recovered when their owner PID is no longer
alive. Status, summaries, banks, ledgers, and evidence files use temporary-file
plus rename writes.

```text
<evidenceDir>/
├── status.json
├── runs/<run-id>.json
├── bundles/<run-id>/<model-slug>.json
├── submissions/<chain-id>/<verification-contract>/<run-id>.json
└── epochs/<epoch>/
    ├── events.jsonl
    ├── runs/<run-id>/
    │   ├── summary.json
    │   └── report.md
    └── <model-slug>/
        ├── runs/<run-id>.summary.json
        └── audits/
            ├── <audit-id>.json
            └── .checkpoints/<audit-id>.json
```

`status.json` is a readable snapshot of the active or most recent run. Run-
specific summary and report paths keep historical evidence immutable. After
every completed run, `epochs/<epoch>/summary.json` and `report.md` are atomically
refreshed as the consolidated latest epoch view. Repair outcomes replace the
same seller's earlier outcome while unaffected sellers remain present. Each
`report.md` model table includes `Reason`, `Next Action`, and `Evidence` columns,
plus model and whole-run reason-code breakdowns. Machine summaries, status,
events, progress, and submission exclusions retain the same structured reason:
`code`, `summary`, `retryable`, `source`, affected/total batch counts, and safe
optional upstream status, provider code, and request ID. Secrets and
authorization values are sanitized. `events.jsonl` is append-only progress
history. Each canonical audit file includes the selected reference, proxy
observations, ResponseAuth evidence, incremental and cumulative cost, and
verdict.

`SAME` and `DIFF` require 100% authenticated coverage. `UNDETERMINED` means the
statistical verdict could not be completed and remains resumable; examples are
deadlines, throttling, temporary upstream failures, payment-lock timeouts, and
invalid or missing ResponseAuth. `SKIPPED` means a deterministic condition made
the seller ineligible, such as stale model advertising, invalid upstream
credentials, buyer policy rejection, or incompatibility with the canonical
temperature-zero request profile. `FAILED` is reserved for verifier-side hard
failures such as an incompatible or missing probe reservation. These outcomes
never rely on coverage alone: their report text comes from persisted batch
evidence.

## On-Chain Model Bundles

`verifier run` remains off-chain. A completed run created against a configured
verification contract writes `runs/<run-id>.json`, which records the exact
on-chain epoch window and stable model order. `verifier submit --run-id ...`
loads that manifest and refuses submission when the current epoch differs or
the run timestamps fall outside the recorded epoch window.

Submission groups valid seller audits by model and sends one
`submitVerificationBundle` transaction per model. Each transaction commits the
expected epoch, total model-audit cost, one canonical bundle evidence hash, one
ordered list of seller agent IDs, service hashes, verdicts, and model-share BPS.
Probe counts and a separate requested-credit value are not part of the contract
ABI or events. Invalid or tampered seller artifacts are excluded before
broadcast and listed with their reason in the bundle evidence.

Verdicts map to `SAME = 1`, `DIFF = 2`, and `UNDETERMINED = 3`. All model shares
currently submit as zero. In particular, a zero-share `DIFF` clears the existing
agent-wide penalty; this is temporary until audited-service volume share is
available. `SAME` also clears the penalty, while `UNDETERMINED` leaves it
unchanged. Model bundles are submitted in the manifest's stable order, so the
latest determinate result is deterministic when one agent appears under several
models.

The bundle cost is the sum of buyer-accepted per-request inference costs and all
unclaimed reference-generation costs for that model. The verifier supplies the
request UUID before proxy dispatch, and the buyer persists the accepted request
cost in `verification.db`; successful payment-disabled requests fall back to
response telemetry, while failed requests without an accepted receipt add zero.
USDC base units and USD micro-units are both six-decimal dollar values.

One verifier credit represents exactly one dollar of accounted audit cost. The
contract stores the credit weight in USD micro-units so fractional-dollar costs
remain exact:

```text
1 credit = 1 USD = 1_000_000 credit USD micros
awardedCreditUsdMicros = min(totalAuditCostUsdMicros, remainingEpochAllowanceUsdMicros)
```

For example, an audit costing `$1.20` contributes `1.20` credits, represented as
`1_200_000` credit USD micros. Credits are accounting weights, not guaranteed
dollar payouts. ANTS rewards remain pro-rata through the existing verifier
reward pool. The per-verifier epoch allowance is 100 credits, represented as
`100_000_000` credit USD micros. Zero-cost bundles receive zero credit and are
valid; bundles above the remaining allowance still apply their seller results.

Verifier reward accounting starts no earlier than the epoch after deployment,
matching the emissions gate's next-epoch minter activation. Bundles submitted
before that epoch still publish and apply their seller results, but award zero
credit. A bundle also awards zero credit whenever the gate exposes no verifier
budget for the current epoch, so delayed or temporarily unavailable minter
wiring cannot create dead credits. On the first claim or zero-credit remainder
settlement for a finalized epoch, the contract freezes that epoch's reward
budget and credit denominator. A temporarily unavailable minter budget cannot
consume a verifier's existing credits.

Reference costs move through `unclaimed → reserved → claimed`. Submission
reserves them atomically against the content-addressed bundle ID before
broadcast, keeps the reservation after a failed transaction for an idempotent
retry, and marks them claimed only after the bundle is confirmed on-chain. The
submission ledger records transaction hashes, block numbers, costs, credits,
errors, and reservation IDs per model. `--dry-run` performs validation and shows
the model preview without reserving costs or sending transactions.

Distributed workers, automatic epoch scheduling, transaction-gas reimbursement,
and daemon operation remain out of scope. Existing verification contracts,
reference banks without cost metadata, and old audit artifacts are intentionally
incompatible and must be redeployed or regenerated.
