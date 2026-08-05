# Model Verification

AntSeed model verification uses the already-running local buyer proxy to send a
powered KBF reference to every live peer advertising a requested model. It pins
each request to one peer, computes `SAME`, `DIFF`, or `UNDETERMINED`, and writes
local proxy-observation evidence.

The current command does not start a separate verifier node, load a verifier
identity, check deposits, request `ResponseAuth`, collect payment evidence, or
submit on-chain attestations. Starting a standalone local verifier for this
workflow is not supported.

## Commands

```text
antseed verifier reference build <model>
antseed verifier run <model>
antseed verifier claim
```

`verifier reference build` creates and validates one adaptively sized reference
JSON file. It starts at 100 probes and grows by 10 until the reference self-test
reaches at least 90% statistical power, capped at 500. `verifier run` never calls
the reference endpoint; a missing or invalid reference fails with the explicit
build command required.

`verifier run` requires the normal buyer process to be running under the same
`--data-dir`. It reads the connected buyer's `buyer.state.json`, selects every
fresh peer advertising `<model>`, preserves each peer's advertised model
spelling, and sends the complete selected reference through the loopback buyer
proxy. Every request carries `x-antseed-pin-peer` for its target.

Peers are processed sequentially. Probe batches contain ten probes and run with
concurrency two. Transient proxy failures retry with bounded exponential backoff.
A peer with an exhausted batch retry is recorded as `FAILED`; other peers still
run. The command exits non-zero when no peer completes or any peer fails.

`verifier claim` remains a separate legacy reward command. `verifier run` does
not create new attestations or credits.

## Configuration

```yaml
buyer:
  proxyPort: 8377

verifier:
  referencesDir: ~/.antseed/verifier/references
  evidenceDir: ~/.antseed/verifier/evidence
  probeRequestTimeoutMs: 120000
  referenceMaxRequestsPerBuild: 2000
  referenceBatchRetryCount: 3
  referenceRetryBaseDelayMs: 500
  referenceMaxNoProgressRounds: 3
  referenceMaxConcurrentRequests: 4
  referenceMaxConcurrentRequestsPerModel: 3
  referenceMinimumProbeCount: 100
  referenceMaximumProbeCount: 500
  referenceProbeStep: 10
  referenceMinimumStatisticalPower: 0.90
  referenceEndpoint:
    baseUrl: http://127.0.0.1:8377/v1
    apiKeyEnv: ANTSEED_REFERENCE_API_KEY
    sourceId: trusted-reference-v1
    trust: trusted
    antseedPeerId: 9e8f9aaee684298b7f2af2ae008e3692f0e9f4f7
    models:
      gpt-5.6-sol:
        upstreamModel: gpt-5.6-sol
        contrastModels:
          - kimi-k3
          - gpt-5.6-luna
          - sonnet-4.6
```

The run command obtains the effective proxy port from the live
`buyer.state.json`; it does not start a buyer or use verifier payment settings.
The configured probe timeout applies to each proxy attempt.

Reference sizing defaults to 100 through 500 in increments of 10 with a minimum
power of 0.90. Counts must be multiples of 10, the step must divide the configured
range, and power must be in `(0, 1]`. Production statistical assumptions remain
fixed at a 0.10 minimum detectable mismatch increase, one-sided alpha 0.05, and
99% Clopper-Pearson confidence.

## Powered References

The verifier stores one reusable reference at:

```text
<referencesDir>/<safe-model-slug>.json
```

The reference must validate as KBF v1, include the requested model as a service
alias, follow the configured sizing sequence, use the fixed statistical
assumptions, and meet the configured power threshold. The same selected probes
are reused across peers and later runs.

Candidate probes must be stable on the reference model and distinguish it from
at least one configured contrast model. A probe need not distinguish every
contrast. Self-testing starts at the configured minimum and evaluates ascending
step-sized prefixes. Only new probes are queried at each step; the first prefix
meeting the power threshold is persisted. If the next prefix is unavailable,
generation continues. If the maximum remains underpowered, the build fails
without replacing an existing reference.

Physical reference-endpoint responses are checkpointed under:

```text
<referencesDir>/.checkpoints/<safe-model-slug>.json
```

Compatible restarts reuse completed generation, enrollment, contrast, preflight,
and self-test responses. The checkpoint is invalidated when endpoint identity,
model mapping, sizing policy, sizing algorithm, fixed mismatch delta, or frozen
query settings change. Transient `429`, `5xx`, timeout, and connection failures
retry with exponential backoff. The build retains hard request budgets,
concurrency limits, adaptive throttle reduction, and bounded no-progress failure.

Candidate generation follows the canonical KBF domain registry. Code owns each
domain's cloze template, broad validity range, tolerance mode, and tolerance;
the reference model proposes only a fact name and provisional numeric value.
Mathematics uses the public KBF domain's exact-match tolerance.

## Coverage and Verdicts

The runtime always evaluates the complete selected reference and calls KBF with
`minCoverage: 1`.

- Every successfully completed probe is scored over the fixed reference
  denominator. Missing, malformed, non-finite, out-of-range, and
  valid-but-nonmatching answers count as discrepancies.
- Any probe batch that cannot obtain a successful proxy response after retries
  remains unattempted and produces `UNDETERMINED`.
- All batches completed: compute `SAME` or `DIFF` normally.

A planned 100-probe audit is never silently reduced to 99 or 49 observations for
`SAME` or `DIFF`.

## Evidence

Each completed peer writes one canonical evidence JSON file with kind
`antseed-buyer-proxy-kbf-audit`. It contains:

- buyer proxy URL, state path, and PID;
- target peer, advertised service, and optional display/agent metadata;
- complete powered reference metadata and probes;
- exact pinned request and response bytes and hashes;
- per-batch attempts, timing, parsed answers, and match vectors; and
- final KBF verdict and statistics.

Every file explicitly declares evidence level
`proxy-observation-no-response-auth-or-payment-evidence`. It must not be treated
as seller-signed response authentication or authenticated payment evidence.

Each invocation also writes a canonical summary under:

```text
<evidenceDir>/runs/<run-id>.json
```

The summary records the buyer proxy, model, reference, selected probe count,
completed peer results, failures, evidence paths, and hashes. Run state is not
stored in SQLite and target probing is not resumable.
