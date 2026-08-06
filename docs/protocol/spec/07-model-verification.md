# Model Verification

AntSeed model verification is integrated into the existing `antseed verifier`
CLI and the already-running buyer proxy. It does not start a second verifier
daemon or expose a new buyer-proxy endpoint.

The verifier builds append-only KBF probe banks from a trusted reference
endpoint, reserves a fresh powered subset for each seller, sends two probe
batches concurrently through the buyer proxy, and records the buyer node's
verified `ResponseAuth` for every successful batch.

## Commands

```text
antseed verifier reference build <model>
antseed verifier reference build --all
antseed verifier run <model>
antseed verifier run --all
antseed verifier run --all --allow-probe-reuse
antseed verifier status [--json]
antseed verifier claim
```

`<model>` and `--all` are mutually exclusive and exactly one is required for
`reference build` and `run`. All-model commands continue after per-model
failures and exit nonzero if any model or peer fails. Reference builds run
independent models concurrently; audit runs process models sequentially.

`reference build` creates a powered reference and appends its probes and
per-probe self-test outcomes to the model's bank. `run` never calls the trusted
reference endpoint. It uses the verification contract's epoch when an address
is configured; otherwise it uses UTC calendar days (`YYYY-MM-DD`). It resolves
the buyer snapshot and ResponseAuth database once, then processes models and
peers sequentially.

## Configuration

```yaml
verifier:
  responseAuthWaitTimeoutMs: 35000
  probeRequestTimeoutMs: 120000
  auditMaxConcurrentModels: 3
  auditMaxConcurrentPeersPerModel: 4
  auditMaxConcurrentBatches: 12
  auditMaxConcurrentBatchesPerPeer: 2
  auditPeerTimeoutMs: 180000

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

## Probe Banks

Probe banks and per-seller ledgers are stored at:

```text
<banksDir>/<model-slug>/
├── bank.json
└── sellers/<peer-id-hash>.json
```

Successful reference builds append probes and self-test outcomes. Repeated probe
IDs are deduplicated only when their canonical probe content and self-test
evidence match. The append is rejected when an ID conflicts or when model,
query-profile, provenance, or statistical assumptions are incompatible.

Before dispatch, the verifier cryptographically shuffles probes not yet assigned
to that seller during the current run. It evaluates configured 10-probe sizing
steps and reserves the first subset meeting coverage, self-test error, and
statistical-power requirements. The subset receives a new content-addressed KBF
reference ID. Reservation is an atomic ledger write performed before network
dispatch and is never released during that run, including after failed audits.
Different sellers may share probes. By default, a seller does not receive a
probe assigned in any earlier run. `--allow-probe-reuse` permits earlier-run
assignments to be selected again while still preventing duplicate assignment
inside the current run.

## ResponseAuth

`verifier run` opens `<dataDir>/verification.db` once using the exported
`VerificationStorage`. Only peers advertising
`verification.response-auth.v1` are scheduled; other peers are recorded as
skipped.

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
batches, and two batches per seller audit concurrently. A shared seller lock
prevents one seller from being audited for multiple models simultaneously.
Transient proxy failures use bounded retries. Each seller audit has a hard
three-minute wall-clock deadline that aborts every remaining batch and finalizes
the seller as `UNDETERMINED`.

One PID-aware run lock prevents concurrent verifier runs from reserving the same
seller probes. Stale locks are recovered when their owner PID is no longer
alive. Status, summaries, banks, ledgers, and evidence files use temporary-file
plus rename writes.

```text
<evidenceDir>/
├── status.json
└── epochs/<epoch>/
    ├── summary.json
    ├── events.jsonl
    └── <model-slug>/
        ├── summary.json
        └── audits/<audit-id>.json
```

`status.json` is a readable snapshot of the active or most recent run. The epoch
summary records the audit epoch window and each model summary. `events.jsonl`
is append-only progress history. Each audit file is canonical JSON and includes
the selected reference, proxy observations, ResponseAuth evidence, cost
estimate, and verdict.

On-chain attestation submission, payment evidence, distributed workers,
automatic epoch scheduling, and daemon operation remain out of scope.
