# Model Verification

AntSeed model verification sends ordinary paid buyer requests to every live peer
advertising a requested model, authenticates each seller response, computes a
KBF fingerprint verdict, writes local evidence, and optionally submits the
result on-chain.

Approved verifier operators remain the v1 trust boundary. The contract stores
attestations but does not recompute KBF verdicts.

## Commands

```text
antseed verifier reference build <model>
antseed verifier run <model> [--no-attest]
antseed verifier claim
```

`verifier reference build` explicitly creates and validates one fixed 100-probe
reference JSON file. `verifier run` never calls the reference endpoint; a
missing or invalid reference fails with the build command required.

`verifier run` discovers every peer advertising `<model>` and uses the exact
advertised spelling for its requests. Every eligible peer receives the same 100
certified KBF probes in ten ordinary paid chat-completion requests.

The default mode writes evidence and immediately submits each successful result
to `AntseedVerifierRegistry`. It requires buyer payment readiness, gas, verifier
approval, and a configured verifier registry before probing. The rewards contract
is only required by `verifier claim`.

`--no-attest` runs the same paid requests, `ResponseAuth` checks, scoring, and
evidence generation but performs no verifier-registry transaction. It requires a
funded buyer deposit but does not require verifier approval, verifier contracts,
or gas for attestation.

Both modes continue after a peer failure. The run summary records completed,
failed, and ineligible peers. The process exits non-zero when no peer completed
or any eligible peer failed.

`verifier claim` remains a separate command and claims pending ANTS rewards for
finalized credited epochs.

## Configuration

```yaml
payments:
  preferredMethod: crypto
  maxPerRequestUsdc: "300000"
  crypto:
    chainId: base-mainnet
    rpcUrl: https://mainnet.base.org
    depositsContractAddress: "0x..."
    channelsContractAddress: "0x..."
    usdcContractAddress: "0x..."
    verifierRegistryAddress: "0x..."
    verifierRewardsAddress: "0x..."

verifier:
  referencesDir: ~/.antseed/verifier/references
  evidenceDir: ~/.antseed/verifier/evidence
  probeRequestTimeoutMs: 120000
  maxTotalSpendUSDC: "10"
  referenceMaxRequestsPerBuild: 2000
  referenceBatchRetryCount: 3
  referenceRetryBaseDelayMs: 500
  referenceMaxNoProgressRounds: 3
  referenceMaxConcurrentRequests: 2
  referenceMaxConcurrentRequestsPerModel: 1
  referenceEndpoint:
    baseUrl: https://reference.example/v1
    apiKeyEnv: ANTSEED_REFERENCE_API_KEY
    sourceId: trusted-reference-v1
    trust: trusted
    models:
      gpt-5.6-sol:
        upstreamModel: gpt-5.6-sol
        contrastModels:
          - kimi-k3
          - gpt-5.6-luna
          - sonnet-4.6
```

`maxTotalSpendUSDC` is required and is a human-readable USDC amount. It caps the
sum of finalized seller charges for one model-wide run. Before starting a peer,
the verifier also checks that the remaining cap can cover all ten requests at
the configured `payments.maxPerRequestUsdc` limit.

Probe count is fixed at 100, probe-request concurrency is fixed at two, and
peers are processed sequentially. These values and adaptive sizing are not
configurable.

## Fixed References

The verifier stores one reusable reference at:

```text
<referencesDir>/<safe-model-slug>.json
```

The reference must validate as KBF v1, include the requested model as a service
alias, and contain exactly 100 probes. The same questions are intentionally
reused across peers and later runs.

`verifier reference build` repeatedly generates candidate rounds until exactly
100 stable probes distinguish the reference model from at least one configured
contrast model. A probe need not distinguish every contrast. The reference
records the exact selected probe IDs that distinguished each individual contrast.
Candidates are deduplicated across rounds by their content-derived IDs.

Physical endpoint responses are checkpointed under
`<referencesDir>/.checkpoints/<safe-model-slug>.json`. Restarting a compatible
build reuses completed generation, enrollment, contrast, preflight, and self-test
responses instead of paying for them again. The checkpoint is invalidated when
the endpoint identity, model mapping, target count, or frozen query settings
change, and is removed after the final reference is written successfully.

Transient `429`, `5xx`, timeout, and connection failures retry with exponential
backoff. The build has a hard physical-request budget, global and per-model
concurrency limits, and adaptive concurrency reduction after throttling. Three
consecutive rounds with no newly accepted probes fail the build rather than
spending indefinitely. `verifier run` never generates or replaces references.
There is no probe catalog, rotation policy, exposure tracking, daemon, relay
workflow, or adaptive audit probe sizing.

## Response Authentication

A seller supporting `verification.response-auth.v1` sends a signed
`ResponseAuth` after a normal response. The payload binds:

- buyer and seller peer IDs;
- advertised service;
- request ID and exact request hash;
- response status and exact response hash;
- payment channel when present; and
- response start and completion timestamps.

The verifier requires a valid seller signature, matching identities, service,
request, response, and successful response-scoped payment evidence. A missing or
invalid `ResponseAuth` makes that probe batch fail and prevents an attestation.

`ResponseAuth` proves that the seller produced the recorded response. KBF
scoring, not `ResponseAuth`, determines whether the response matches the model
reference.

## Evidence and Local State

Verification workflow state is not stored in SQLite. SQLite remains an internal
node inbox for received `ResponseAuth` messages only.

Each completed peer writes one canonical evidence JSON file containing:

- verifier and target identities;
- service and reference metadata;
- all 100 probes and expected answers;
- exact request and response bytes and hashes;
- seller-signed `ResponseAuth` payloads;
- response-scoped payment evidence;
- parsed answers and match vector; and
- final KBF verdict and statistics.

Each invocation also writes one canonical summary under
`<evidenceDir>/runs/<run-id>.json`. The summary records mode, model, reference,
configured and actual spend, successful peer results, failure reasons, evidence
paths, and attestation transaction hashes.

There is no benchmark database, resumable peer-audit workflow state, report
command, performance metric snapshot, traffic-share lookup, or evidence URI
publication. Only reference-build endpoint responses are checkpointed.

## On-Chain Attestation

The default mode submits one result per successfully verified peer. The current
registry compatibility call includes:

- audit ID;
- seller agent ID and service hash;
- `SAME`, `DIFF`, or `UNDETERMINED` verdict;
- current epoch;
- authenticated probe count;
- evidence hash; and
- zero-valued model-share and metric compatibility fields.

The verifier does not calculate traffic share or performance metrics. Benchmark
mode never calls the registry.

The registry continues to award credits and the rewards controller continues to
support explicit `verifier claim` operations. Automatic scheduling, retry
backoff, automatic claiming, routing integration, and seller-penalty calculation
are outside this command.
