# Model Verification

AntSeed model verification uses approved verifiers that run ordinary paid buyer
requests against advertised seller services and submit one final on-chain
attestation. The verifier whitelist is the v1 trust boundary.

There is no verification relay, relay treasury, audit commitment, assignment,
commit/reveal window, force claim, or separate attestation recovery stage in the
current protocol.

## Roles

### Verifier

A verifier runs one normal `AntseedNode` with `role: "buyer"`. One identity
wallet is used for all verifier actions:

- buyer USDC deposits and payment-channel authorizations;
- paid seller requests;
- verifier approval checks;
- final attestation transactions;
- optional evidence publication; and
- ANTS reward claims.

The verifier pays for its own probes and supplies its own gas.

### Seller

The seller receives ordinary paid provider requests. It does not implement a
verifier-specific transport. For every successful request it returns the normal
response and, when the buyer advertises `verification.response-auth.v1`, sends a
signed `ResponseAuth` over the existing verification mux.

### On-chain registry and rewards controller

`AntseedVerifierRegistry` stores final attestations, verification statistics,
seller penalties, and epoch credits. `AntseedVerifierRewards` controls the
verification emissions bucket and distributes the entire bucket to credited
verifiers.

## CLI

The verifier command surface is:

```text
antseed verifier start [--service <id...>] [--interval-ms <ms>] [--once]
antseed verifier audit --peer <peer-id> --service <service> [--evidence-uri <uri>]
antseed verifier benchmark run --service <service> --max-total-usdc <base-units>
antseed verifier benchmark report --run <run-id> [--format table|json|csv]
antseed verifier benchmark attest --run <run-id> --audit-id <id...>
antseed verifier status [--json]
antseed verifier claim
antseed verifier reference build --service <service> [--probes <count>]
```

`verifier start` runs periodic discovery and direct audits. `--once` performs one
reward-claim/discovery/audit round and exits. Service filters may come from
configuration or repeated `--service` flags.

`verifier audit` resolves one advertised peer/service, runs the paid audit, writes
evidence, and submits the final attestation immediately. It does not queue a
commitment or require a later `attest` command.

`verifier benchmark run` is an observation-only local workflow. It snapshots
every live peer advertising the requested service, records ineligible peers,
prepares one shared KBF reference, sends the identical probes to every eligible
peer, writes canonical evidence, and stops without calling the verifier
registry. `benchmark report` exports every discovered participant without a
display limit. `benchmark attest` is the only benchmark command that can write
selected completed observations on-chain.

`verifier claim` scans finalized epochs and claims every pending verifier reward.
The daemon performs the same claim scan automatically at the beginning of each
round.

`verifier reference build` enrolls additional certified KBF probes using the
configured trusted reference endpoint.

## Configuration

Example:

```yaml
payments:
  preferredMethod: crypto
  crypto:
    chainId: base-mainnet
    rpcUrl: https://mainnet.base.org
    depositsContractAddress: "0x..."
    channelsContractAddress: "0x..."
    stakingContractAddress: "0x..."
    usdcContractAddress: "0x..."
    identityRegistryAddress: "0x..."
    verifierRegistryAddress: "0x..."
    verifierRewardsAddress: "0x..."
    verifierPointsPolicyAddress: "0x..."

verifier:
  services:
    - gpt-5.6-sol
  referencesDir: ~/.antseed/fingerprints/references
  evidenceDir: ~/.antseed/verifier/evidence
  auditIntervalMs: 300000
  maxAuditsPerEpoch: 50
  probeRequestTimeoutMs: 120000
  maxConcurrentProbeRequests: 2
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
  referencePolicy:
    minimumAuditProbeCount: 100
    maximumAuditProbeCount: 500
    auditProbeStep: 10
    minimumStatisticalPower: 0.9
    maxReferenceAgeDays: 49
    maxRequestsPerRound: 2000
    requestTimeoutMs: 120000
    batchRetryCount: 3
    generationDomainConcurrency: 3
    maxConcurrentReferenceRequests: 4
    maxConcurrentRequestsPerModel: 2
  trustedImportedReferenceIds: []
```

Defaults:

| Setting | Default |
| --- | ---: |
| `auditIntervalMs` | `300000` |
| `maxAuditsPerEpoch` | `50` |
| `probeRequestTimeoutMs` | `120000` |
| `maxConcurrentProbeRequests` | `2` |
| `referencePolicy.minimumAuditProbeCount` | `100` |
| `referencePolicy.maximumAuditProbeCount` | `500` |
| `referencePolicy.auditProbeStep` | `10` |
| `referencePolicy.minimumStatisticalPower` | `0.9` |

The legacy verification-relay settings are invalid configuration:

- `buyer.relay`;
- `relayTreasuryAddress`;
- `jobTimeoutMs`;
- `flatRelayFeeUsdc`;
- `relaySignalingPort`;
- `maxRelays`; and
- `auditDurationMs`.

The separate gasless deposit-relay configuration is unrelated and remains
supported.

## Startup Checks

The verifier runtime starts the buyer node with `ResponseAuth` sampling set to
100%. Before entering the scheduler loop it verifies:

1. the wallet is approved by `AntseedVerifierRegistry`;
2. the wallet has native gas;
3. buyer payment contracts and USDC are configured; and
4. the buyer deposit/payment state is ready for paid requests.

Failure is fatal for the verifier command. It does not silently start a partial
verification service.

Benchmark observation readiness performs checks 2-4 but does not require an
approved verifier. Benchmark attestation and the existing verifier daemon/audit
commands require all four checks.

## Scheduler

Each daemon round performs these steps:

1. Claim pending verifier rewards from finalized epochs.
2. Read the current epoch, credit cooldown, on-chain verifier credit cap, and
   minimum probe count.
3. Stop scheduling credited work when either the configured local audit cap or
   the on-chain credit cap is exhausted.
4. Discover advertised seller/service pairs.
5. Apply service filters and skip targets without an on-chain agent ID.
6. Skip the verifier's own seller identity.
7. Skip duplicate targets, running local audits, targets in retry backoff, and
   targets still inside the on-chain credit cooldown.
8. Sort eligible targets by oldest `lastCreditedAt` first.
9. Run direct audits sequentially at the target level. Probe requests inside an
   audit use bounded concurrency.

Only one discovery round may run at a time. Operational failures are recorded
and enter seller/service backoff; they do not submit an attestation or earn a
credit.

## Trusted References

The verifier reuses the existing adaptive KBF reference system:

- trusted reference endpoint configuration;
- adaptive reference building and certification;
- certified probe catalog and imported reference trust policy;
- per-agent/service permanent probe exposure tracking;
- freshness validation;
- reference-compatible subset selection; and
- Clopper-Pearson/binomial statistical-power calculations.

An audit starts with 100 unseen probes and may grow in increments of ten up to
500 until the configured statistical-power threshold is reached. A reference is
not usable when it is stale, untrusted, incompatible with the advertised
service/query profile, or unable to produce the required statistical power.

## Direct Probe Execution

Selected KBF probes are sent directly through `AntseedNode.sendRequest`. The
current KBF wire format groups ten probe statements in one ordinary chat request;
the evidence still records every selected probe and its individual outcome.

For each request batch the verifier:

1. marks probe exposure before network delivery;
2. creates and stores the request hash;
3. sends the paid request through the normal buyer payment path;
4. waits for the seller's `ResponseAuth`;
5. verifies the seller signature, buyer/seller identities, service, channel,
   request hash, and response hash;
6. finalizes the response-scoped payment authorization;
7. parses KBF answers and computes the match vector; and
8. stores response, timing, payment, authentication, and match evidence.

The default request timeout is 120 seconds and the default request concurrency is
two.

An authenticated result requires all of the following:

- a seller response;
- a valid stored `ResponseAuth`;
- response-scoped payment evidence; and
- HTTP status `200`.

The audit must reach both the configured minimum authenticated probe count and the
configured statistical-power threshold. Timeouts, missing or malformed
`ResponseAuth`, malformed responses, and payment failures remain operational
failures when the threshold cannot be reached.

## Verdicts

The final verifier verdict is one of:

```solidity
enum Verdict {
    UNKNOWN,
    SAME,
    DIFF,
    UNDETERMINED
}
```

`UNKNOWN` is never accepted on-chain.

- `SAME` means the authenticated evidence matches the trusted reference within
  the KBF decision policy.
- `DIFF` means the evidence supports a model mismatch. `modelShareBps` records
  the audited service's share of the seller's current-epoch attributed settled
  USDC, rounded up to whole basis points. An unused service may have a zero
  share while still recording the mismatch.
- `UNDETERMINED` means sufficient authenticated, statistically powered evidence
  exists but the result is inconclusive.

Insufficient authenticated evidence is not `UNDETERMINED`; it is an operational
failure and produces no attestation.

## Canonical Evidence

Evidence uses canonical JSON with kind `antseed-direct-kbf-audit` and includes:

- verifier peer ID and wallet address;
- target peer ID, agent ID, service, and service hash;
- reference ID, query-profile hash, reference power evidence, self-test summary,
  selected probes, and expected answers;
- request/response bytes and hashes;
- verified `ResponseAuth` payloads;
- response-scoped payment evidence;
- request timing and throughput observations;
- parsed answers, match vector, statistical evidence, and verdict;
  and
- the on-chain metric snapshot.

The verifier writes and fsyncs the canonical evidence file before submitting the
attestation transaction. The evidence hash is the canonical content hash.

The audit ID is derived from the verifier address, target peer, agent, service
hash, completion time, and evidence hash under the
`antseed-direct-audit-id-v1` domain.

An evidence URI may be published later. URI publication failure does not change
or invalidate an already stored attestation.

## Registry API

```solidity
struct MetricSnapshot {
    uint64 windowStartedAt;
    uint64 windowEndedAt;
    uint16 eligibleAttempts;
    uint16 successfulAttempts;
    uint32 p50TtftMs;
    uint32 p95TtftMs;
    uint32 p50OutputTokensPerSecondMilli;
    uint16 schemaVersion;
    bytes32 observationsRoot;
}

struct Attestation {
    bytes32 auditId;
    address verifier;
    uint256 agentId;
    bytes32 serviceHash;
    Verdict verdict;
    uint16 modelShareBps;
    uint32 probeCount;
    uint64 attestedAt;
    bytes32 evidenceHash;
}

function submitVerificationResult(
    bytes32 auditId,
    uint256 agentId,
    bytes32 serviceHash,
    Verdict verdict,
    uint256 expectedEpoch,
    uint16 modelShareBps,
    uint32 probeCount,
    MetricSnapshot calldata metrics,
    bytes32 evidenceHash
) external;

function publishEvidence(bytes32 auditId, string calldata evidenceUri) external;

function getAttestation(bytes32 auditId) external view returns (Attestation memory);

function latestAttestation(
    uint256 agentId,
    bytes32 serviceHash
) external view returns (Attestation memory);
```

`submitVerificationResult` rejects:

- unapproved callers;
- zero or reused audit IDs;
- unknown agents and self-audits;
- zero service or evidence hashes;
- `UNKNOWN` verdicts;
- an `expectedEpoch` that no longer matches the current epoch;
- nonzero model shares for non-`DIFF` verdicts;
- probe counts below `minProbeCount`; and
- invalid metric windows or success counts.

Every valid attestation is stored even when it does not earn a credit. The
registry emits `AttestationSubmitted` and `MetricSnapshotSubmitted` for off-chain
indexers.

Only the submitting verifier may publish one non-empty evidence URI for an audit.

## Statistics and Seller Penalties

The registry preserves per-service and per-agent historical counts for `SAME`,
`DIFF`, and `UNDETERMINED`, along with distinct-verifier and standing-DIFF
tracking. The owner may clear a removed verifier's standing DIFF without
rewriting historical counters or attestations.

Seller points penalties follow the latest conclusive attestation for the
service:

- `DIFF` sets the service penalty to `modelShareBps`;
- `SAME` clears the service penalty; and
- `UNDETERMINED` leaves the existing penalty unchanged.

The per-agent penalty is the sum of current per-service penalties and is consumed
by `AntseedVerifierPointsPolicy` in the existing seller points path.

Immediately before submitting a `DIFF`, the verifier resolves the target's
verified effective payment seller address and queries Antscan's public Ponder
GraphQL `settlementServices` records. It captures Antscan's synced indexed block,
cursor-pages every row for that seller within the on-chain current epoch and at
or below the captured block, and computes:

```text
modelShareBps = ceil(
  audited service deltaAmountUsdc
  / all seller service deltaAmountUsdc
  * 10,000
)
```

The verifier stores the source, epoch window, indexed block, seller, service
hash, numerator, denominator, and result locally. It does not submit the `DIFF`
if seller resolution fails, Antscan is unavailable or unsynced, pagination is
incomplete or inconsistent, or the on-chain epoch changes during calculation.
`SAME` and `UNDETERMINED` always use zero basis points and do not depend on
Antscan.

## Epoch Credits

Default registry policy:

- target/service cooldown: one day;
- maximum verifier credits per epoch: 100; and
- minimum probe count: 10.

After storing a valid attestation:

```solidity
credited =
    nowTs - lastCreditedAt[agentId][serviceHash] >= auditCooldown
    && epochCredits[epoch][msg.sender] < maxCreditsPerVerifierPerEpoch;
```

When credited, the registry updates `lastCreditedAt`, the verifier's epoch credit
count, and the epoch total. Valid `SAME`, `DIFF`, and `UNDETERMINED` attestations
are all creditable. Cooldown- or cap-blocked attestations still update history,
routing events, counters, and penalties.

There are no delegate credits, vouchers, delegate budgets, target accruals, or
delegate reward shares.

## Verifier Rewards

`AntseedVerifierRewards` exposes:

```solidity
function claimVerifierReward(uint256 epoch) external;

function pendingVerifierReward(
    uint256 epoch,
    address verifier
) external view returns (uint256);

function verifierEpochBudget(uint256 epoch) external view returns (uint256);

function verifierEpochTotalCredits(uint256 epoch) external view returns (uint256);

function settleEpochRemainder(
    uint256 epoch
) external returns (uint256 burnedAmount, uint256 reserveAmount);
```

The entire verification emissions bucket belongs to verifiers:

```text
reward = epoch budget × verifier credits ÷ total verifier credits
```

The epoch budget and total-credit denominator freeze on the first claim or
remainder settlement. Claims are one-time per verifier/epoch. A finalized epoch
with zero verifier credits may route its whole budget through the emissions
gate's burn/reserve remainder path. Pro-rata rounding dust remains unminted.

## Storage

Verification migration `005_replace_audit_relay_tables_with_direct_audits`
creates:

- `direct_audits`; and
- `direct_audit_probes`.

It copies reusable audit-plan and probe-selection data where possible, then drops
the relay-era audit plans, rounds, jobs, charges, entitlements, and settlement
index tables in foreign-key-safe order.

Existing migrations remain immutable. The following retained tables continue to
support direct verification and trusted references:

- `response_auths`;
- `reference_builds`;
- `certified_kbf_probes`;
- `certified_kbf_imports`; and
- `probe_exposures`.

## Routing and Indexing

Buyers index `AttestationSubmitted` events and derive per-service model
verification lifecycle data for discovered sellers. DHT enrichment and routing
scores use the simplified attestation event; they do not depend on relay counts,
treasury payments, assignments, or evidence publication.

`ResponseAuth` transport and local storage remain unchanged and are sampled at
100% by verifier nodes.

## Security Boundary and Deferred Work

The v1 system trusts approved verifier operators to fund and execute honest local
audits. Canonical evidence, paid requests, and seller-signed `ResponseAuth`
records make audits reviewable, but the contract does not recompute KBF results
or hide verifier traffic from sellers.

Relay indistinguishability, decentralized work assignment, and stronger
anti-cheating mechanisms are intentionally deferred until network testing shows
which attacks occur in practice. They must be introduced as a separate protocol
iteration rather than reusing the removed relay-era APIs.
