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
antseed verifier submit --run-id <run-id> --publish-ipfs [--yes]
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
      claude-opus-4-6:
        enabled: true
        serviceAliases:
          - claude-opus-4.6
        upstreamModel: anthropic/claude-opus-4.6
      claude-sonnet-5:
        enabled: true
        upstreamModel: anthropic/claude-sonnet-5
        referenceRoute:
          type: antseed
          service: sonnet-reference-service
          peerId: 0123456789abcdef0123456789abcdef01234567
          pricing:
            inputUsdPerMillion: 0.30
            outputUsdPerMillion: 0.80
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

`serviceAliases` maps alternate network service spellings to the same logical
audited model and probe bank. Each seller is audited at most once, using an
eligible spelling that seller actually advertises. The primary mapping key is
always included automatically and aliases must not duplicate it.

The audited model's `upstreamModel` remains the trusted source of ground-truth
answers. Cheap models are contrasts only. Automatic selection computes:

```text
blended cost = input price × inputWeight + output price × (1 - inputWeight)
```

An audited model may set `referenceRoute.type: antseed` to send only its target
candidate-generation, stability, and self-test requests through the local buyer
proxy. The buyer proxy URL is derived from `buyer.proxyPort`; the configured
`service` is sent as the request model and every request is pinned to `peerId`.
Contrast requests continue to use `referenceEndpoint`. Route pricing is used for
target request cost accounting, while OpenRouter catalog pricing still drives
automatic contrast selection. The buyer proxy must already be running. An
unavailable peer or service fails the build without falling back, and the
checkpoint remains available for a later resume.

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

Reference consistency follows the KBF enrollment procedure. Candidate probes
are queried in domain-homogeneous batches of at most ten under temperatures
`0`, `0.7`, and `0.7`, with an independently shuffled order for each pass.
Exact domains require all three rounded answers to agree. Relative domains
require the first pass to match the consensus under the domain tolerance and
the maximum deviation from the three-answer mean to be at most 2%. The
final reference self-test, contrast checks, and seller audits also use
domain-homogeneous batches. Probe answers are always remapped to their original
probe IDs before self-test scoring or audit verification.

Every accepted generated probe preserves its three enrollment temperatures,
the three parsed enrollment answers, and the exact stability rule used to form
the stored reference consensus. This metadata travels with the probe into the
bank, per-seller evidence packs, and model-run consensus evidence.

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
query-profile, provenance, statistical assumptions, or the reference-enrollment
algorithm are incompatible. An operator must archive or remove an incompatible
legacy bank before appending probes built by a newer enrollment algorithm.

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
recorded as skipped. Before reserving probes, the verifier independently applies
`buyer.minPeerReputation` and `buyer.maxPricing.defaults` to each advertised
seller using the pricing and reputation in the buyer snapshot. Sellers outside
that configured policy are recorded as reasoned preflight skips and receive no
audit traffic. A structured first-batch `model_not_found` response stops the
audit, voids its probe reservation, and records a reasoned `SKIPPED` entry plus
evidence. Peers that never advertised the model are not included in that model's
report.

After each successful proxy response, the verifier reads
`x-antseed-request-id` and polls `getResponseAuth(requestId)` every 100 ms for up
to `responseAuthWaitTimeoutMs`. The stored record must be verified and match the
request ID, seller peer ID, and advertised service.

Future verifier requests ask the local buyer proxy to retain the exact AntSeed
codec bytes hashed by `ResponseAuth`. The local capture control header is
removed before P2P routing. For every successful exchange, evidence contains:

- the seller-signed `ResponseAuth` payload and signature;
- the exact encoded request and response bytes, in base64;
- the exact `antseed-response-auth-v1` signature-message bytes, in base64; and
- the recomputed Keccak-256 request and response hashes.

The reader rejects missing or hash-mismatching preimages. Therefore a rebuilt
buyer proxy must be restarted before starting a new audit. Existing historical
evidence remains readable, but cannot retroactively gain bytes that were not
retained when those requests ran. If any successful batch lacks valid
authenticated evidence, observations are preserved but the audit verdict is
forced to `UNDETERMINED`.

`evidenceLevel` is retained as a proof-scope boundary, not a quality score. It
prevents seller-signed proxy observations from being described as payment or
on-chain evidence. Each readable manifest repeats that scope explicitly.

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
├── runs/
│   ├── <run-id>.json
│   └── <run-id>.summary.json
├── bundles/<run-id>/<model-slug>.json
├── submissions/<chain-id>/<verification-contract>/<run-id>.json
└── epochs/<epoch>/
    ├── events.jsonl
    └── <model-slug>/
        ├── report.html
        ├── references/
        │   └── <reference-id>/
        │       └── probe-integrity.json
        └── audits/
            └── <run-id>/
                ├── summary.json
                ├── probe-consensus.json
                ├── manifest.json
                ├── .checkpoints/<seller-evidence-id>.json
                └── sellers/
                    └── <seller-peer-id>/
                        ├── README.md
                        ├── manifest.json
                        ├── evidence.json
                        └── exchanges/<batch-index>.json
```

`status.json` is a readable snapshot of the active or most recent run. Model-
specific audit directories keep historical seller evidence immutable. After
every completed run, `epochs/<epoch>/<model>/report.html` is atomically replaced
with the latest run for that model and epoch. Each report table includes `Reason`,
`Next Action`, and clickable `Evidence` columns. The report is standalone HTML
with embedded styling and no external assets, so it can be opened directly from
the local evidence directory or a copied evidence ZIP. All report evidence links
are relative to the report, so they remain usable after extraction on another
machine. The report includes model and whole-run reason-code breakdowns. Machine
summaries, status,
events, progress, and submission exclusions retain the same structured reason:
`code`, `summary`, `retryable`, `source`, affected/total batch counts, and safe
optional upstream status, provider code, and request ID. Secrets and
authorization values are sanitized. `events.jsonl` is append-only progress
history. `evidence.json` remains the canonical complete per-seller artifact for
existing readers. Model reference integrity is stored once per reference ID and
contains probe definitions, three-pass enrollment evidence, and reference
self-test outcomes. Each seller `exchanges/` file contains one request batch and
its exact signed preimages. The model-run `probe-consensus.json` groups only
authenticated seller answers with exact preimages by probe. Every authenticated
answer remains visible, but reference-point voting includes only sellers whose
answer is backed by verified ResponseAuth and exact signed preimages. The
seller's final model-level `SAME`, `DIFF`, or `UNDETERMINED` verdict does not
change that per-probe vote. Each authenticated seller contributes at most one
vote per probe. A reference point is
`CONFIRMED` when at least half of eligible answers match the reference, including
an exact tie, `REJECTED` when fewer than half match, and `NO_RESPONSE` when no
eligible seller answered. The artifact records the decision rule, support and
rejection counts, rates, and global reference-point totals. Each seller
contribution links back to its peer ID, final verdict, internal seller evidence
ID, evidence hash, batch index, request ID, signed request/response hashes, and
ResponseAuth signature. Every probe also records the full question text, domain,
reference answer, physical validity range, tolerance rule, and the inclusive
answer interval derived from that tolerance. Each probe enumerates every audited
seller by peer ID as `CONFIRMED`, `REJECTED`, `NO_RESPONSE`, or `EXCLUDED`, with
counts for every category. `NO_RESPONSE` means no verified answer exists for that
probe; `EXCLUDED` is reserved for a verified response that cannot produce a
scoreable per-probe outcome. The global decision records the eligible answer
count and minimum confirmation count, and uses all authenticated `CONFIRMED` and
`REJECTED` answers, including those from an `UNDETERMINED` seller. A missing or
malformed numeric answer in a completed authenticated
response is `REJECTED` under the fixed-denominator rule, not `NO_RESPONSE`. The
HTML report renders one expandable story per question: the OpenRouter-enrolled
reference answer, all seller categories and addresses, the global majority
decision, and a portable link to each signed exchange JSON containing the raw
buyer-proxy request, raw response, signature, and exact signed preimages.

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
optional evidence URI, and one ordered list of seller agent IDs, service hashes,
verdicts, and model-share BPS. The shared `VerificationBundleSubmitted` event
emits the URI as a non-indexed string while keeping the evidence hash, verifier,
and epoch indexed. Empty URIs remain valid for local-only submissions; non-empty
URIs must use `ipfs://` and are limited to 200 UTF-8 bytes.
The bundle contains the canonical probe-consensus hash, reference ID, decision
rule, and vote summary, so the on-chain evidence hash commits to the exact
per-probe majority decisions. This URI-bearing ABI requires redeploying the
verification contract.
Probe counts and a separate requested-credit value are not part of the contract
ABI or events. Invalid or tampered seller artifacts are excluded before
broadcast and listed with their reason in the bundle evidence.

### Public IPFS Evidence

`verifier submit --publish-ipfs` publishes one complete public Pinata folder per
model before broadcasting that model's transaction. The command requires a
`PINATA_JWT` environment variable with public upload permission. The JWT is
never accepted as a command argument, written to configuration, persisted in a
ledger, or included in an error message.

Each folder preserves paths relative to `evidenceDir` and contains the canonical
bundle, selected run manifest and summary, probe consensus, reference-integrity
evidence, finalized seller manifests and evidence, signed exchange files, and
an immutable HTML report rendered for the selected run. `publication.json`
indexes every included file by relative path, byte size, and SHA-256 hash. PID
locks, status snapshots, event logs, `.checkpoints`, submission ledgers, and
other operational state are excluded.

Pinata returns one CIDv1 for the model folder. The CLI submits `ipfs://<cid>` as
the bundle's `evidenceUri`, records the CID, URI, size, file count, timestamps,
and publication status in the local submission ledger, and prints the URI in
the final summary. Consumers query `VerificationBundleSubmitted` by its indexed
`evidenceHash`, fetch the emitted URI, locate the bundle path from
`publication.json`, canonicalize the bundle, and verify its SHA-256 against the
event hash. The URI is event-only and is not stored in contract state.

Publication is fail-closed per model. The CLI retries network errors, HTTP 429,
and HTTP 5xx responses up to three attempts, but authentication and other HTTP
4xx failures are immediate. A failed pin prevents that model's cost reservation
and transaction while other models continue. Successful ledger publications
are reused by evidence hash on retry. After broadcast, the CLI requires the
confirmed event URI to equal the pinned URI before marking the model submitted.
A bundle previously submitted with an empty URI cannot be retroactively
anchored because historical events are immutable.

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
errors, reservation IDs, and optional Pinata publication state per model.
`--dry-run --publish-ipfs` builds and previews the public package's file count
and size without reading `PINATA_JWT`, uploading, reserving costs, or sending
transactions.

Distributed workers, automatic epoch scheduling, transaction-gas reimbursement,
and daemon operation remain out of scope. Existing verification contracts that
do not emit `evidenceUri`,
reference banks without cost metadata, and old audit artifacts are intentionally
incompatible and must be redeployed or regenerated.
