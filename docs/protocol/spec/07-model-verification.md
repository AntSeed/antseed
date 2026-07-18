# 07 - Model Verification

**Status:** Mixed. `ResponseAuth`, `VerificationMux`, buyer-side response-auth
storage, and random buyer-side request/response evidence samples are implemented
in `@antseed/node`. The whitelisted verifier network is implemented:
`@antseed/fingerprints` (KBF + cohort verdict math, stealth probe engine), the
`AntseedVerifierRegistry`/`AntseedVerifierRewards` contracts, the
`antseed verifier` CLI daemon, buyer-delegated probe execution (probe
delegation protocol, message types `0x90-0x96`) with on-chain anchor-time
carrier crediting, and buyer-side routing enforcement of standing
substitution flags.
The audit pipeline is **transparent**: every audit follows the normative
**commit → carry → anchor → attest → reveal** order — the probe set is sealed
on-chain before it runs, every seller answer is signature-anchored on-chain
before anything is revealed, and the probes themselves are published on-chain
afterward, so anyone can re-run the entire audit from public data with
`antseed audit verify` and reach the same verdict. Fingerprint swarm
distribution, additional verifier families, verifier staking, and seller
slashing are proposed next-step work.

## Overview

The reputation layer ([05-reputation.md](./05-reputation.md)) and metering layer
([03-metering.md](./03-metering.md)) answer **whether** a request was served and
**how much** was billed. Neither answers **what** was served.

A Seller can advertise a premium model (e.g. `claude-sonnet-4-6`) on the DHT and
silently serve a cheaper substitute — a different model family, a nano-tier
endpoint, or an aggressively quantized copy of the correct model. The Buyer pays
the advertised price and receives degraded output. Settlement volume,
ghost-channel rate, and ERC-8004 feedback all score the cheating Seller exactly
as well as an honest one, because delivery still happened.

This is not hypothetical. "Real Money, Fake Models" audits shadow APIs claiming
to serve official frontier models and finds utility, safety, and identity
divergence between claimed and served behavior
(https://arxiv.org/abs/2603.01919). AntSeed's model-verification layer is the
protocol response to that failure mode: make served bytes attributable first,
then run black-box identity checks over attributable evidence.

**Model verification** is the set of mechanisms that let a Buyer gain confidence
that the model it paid for is the model it received, and — where the evidence is
strong enough — escalate a confirmed substitution to on-chain slashing. The v1
implementation target is a **buyer-run fingerprint suite** backed by signed
response evidence. The Seller is not trusted to provide the fingerprint result.

There is no central verification authority. Every mechanism here is either
Buyer-local or settled through existing peer-to-peer and on-chain primitives.

---

## Implementation Status

This spec intentionally separates the evidence substrate that already exists
from the fingerprint/audit layers that still need to be built.

### Implemented

Implemented in the `@antseed/node` package:

- `ResponseAuthPayload` protocol type:
  - `version`;
  - `requestId`;
  - optional `channelId`;
  - `buyerPeerId`;
  - `sellerPeerId`;
  - `advertisedService`;
  - `provider`;
  - `statusCode`;
  - `requestHash`;
  - `responseHash`;
  - `responseStartedAt`;
  - `responseCompletedAt`;
  - `signature`.
- Connection capability:
  - `verification.response-auth.v1`.
- Verification frame:
  - `MessageType.VerificationResponseAuth = 0x80`.
- `VerificationMux`:
  - sends response-auth frames;
  - waits by `requestId`;
  - buffers out-of-order auths;
  - allows one listener for unsolicited response-auth handling;
  - reserves `0x80-0x8F` for verification/attestation messages. The probe
    delegation protocol occupies the adjacent `0x90-0x9F` range (currently
    `0x90-0x96`, documented below).
- Seller behavior:
  - creates `ResponseAuth` after a completed inference response;
  - signs with the Seller identity;
  - sends it only when the Buyer advertised `verification.response-auth.v1`,
    preserving compatibility with older Buyers.
- Buyer behavior:
  - waits for `ResponseAuth` after receiving the response;
  - verifies request hash, response hash, request id, status code, buyer id,
    seller id, advertised service, optional channel id, and Seller signature;
  - stores the auth and verification result in `verification.db`.
- Verification storage:
  - SQLite table `response_auths`;
  - indexed by seller, advertised service, and received timestamp.
- Buyer-side full evidence sampling:
  - random sample rate default `0.005`;
  - max encoded request + response bytes default `16 MiB`;
  - default directory `<dataDir>/verification_samples`;
  - stores `manifest.json`, `request.bin`, and `response.bin`;
  - stores only verified `ResponseAuth` samples.

The implemented evidence chain is:

```text
encoded request bytes
  -> requestHash
  -> ResponseAuth.signature
  -> response_auths row
  -> optional verification_samples/<sellerPeerId>/<sampleId>/
```

Also implemented — the whitelisted verifier network:

- `@antseed/fingerprints` package: KBF verifier math (position-aware numeric
  parsing, tolerance matching, CP99 + one-sided binomial verdicts),
  cross-seller cohort consensus verdicts, a pluggable `ProbeSource` (a large
  compositional entity/attribute generator by default, with the deterministic
  seeded bank demoted to a test/bootstrap fixture), RFC 8785 (JCS) canonical
  JSON hashing for probe-set commitments and evidence bundles.
- `AntseedVerifierRegistry` contract: owner-approved verifier whitelist,
  pre-audit probe-set commitments (commit-reveal), per-audit attestations
  keyed by `(agentId, serviceHash)` with verdict + `evidenceHash`, staleness
  tracking (`lastAuditedAt`/`lastCreditedAt`), and per-epoch audit credits
  bounded by a cooldown and a per-verifier cap. The transparent-audit
  extensions enforce the commit → anchor → attest → reveal order on-chain:
  - `anchorExchangeBatch(probeCommitment, ExchangeRecord[] records,
    bytes[] signingPayloads, uint32[] recordProbeCounts)` — the verifier
    posts the full exchange batch as calldata, one `(agentId, requestHash,
    responseHash, responseAuthSig)` record per SIGNED STEALTH REQUEST (each
    request bundles 1–`maxProbesPerRequest` probes, so a batch's probe count
    generally exceeds its record count). `signingPayloads[i]` is the exact
    ResponseAuth signing preimage for record i (13 length-prefixed UTF-8
    fields; see `parseResponseAuthPayload`), and the contract VERIFIES EVERY
    SELLER SIGNATURE ON-CHAIN: `responseAuthSig` must recover — over the
    EIP-191 digest of `"antseed-data-v1:" || signingPayloads[i]` — to the
    ERC-8004 owner of `agentId`, and the payload's embedded request/response
    hashes must equal the anchored ones, so a verifier cannot anchor an
    exchange the audited seller never signed. `recordProbeCounts[i]` (each
    >= 1) declares the probes bundled in record i; the batch's probe count
    is their contract-enforced sum, fixed at anchor time and recomputable by
    third parties from the revealed probe set plus the anchored records.
    The buyer peer named inside each verified payload accrues that record's
    probe count as delegate credits (`commitmentDelegateAccrued`, keyed by
    the audited target's `delegateTargetKey(agentId, serviceHash)`) when it
    is neither the anchoring verifier nor the record's seller. The contract
    recomputes the Merkle root FROM the calldata records (leaf =
    `keccak256(abi.encode(agentId, requestHash, responseHash,
    keccak256(sig)))`, pairwise keccak, odd node promoted), so the root ↔
    data binding is on-chain-verified, and stores one packed
    `BatchAnchor { anchoredAt, recordCount, probeCount, commitment }` keyed
    by `(verifier, batchRoot)` (readable via `batchAnchors(verifier,
    batchRoot)`); the referenced probe commitment must have landed strictly
    earlier. Each commitment has exactly one batch, bounded to `[1, 256]`
    records; each record declares `1..3` probes. Every anchored request hash
    is recorded in a GLOBAL registry (`anchoredExchangeBy`) — a seller-signed
    exchange is anchorable exactly once, network-wide, so the same witnessed
    exchange cannot be re-anchored under other commitments or by other
    verifiers to multiply delegate accrual or attestation evidence
    (duplicates inside one batch die on the same check).
    anchor transaction is the practical ceiling (see the cost table below).
  - `submitAttestation(..., batchRoot)` — every attestation must reference an
    anchored batch whose stored commitment matches the attestation's probe
    commitment, so a verdict can never point at evidence that was not sealed
    on-chain first. The attestation's `probeCount` is capped by the batch's
    anchor-time probe-count sum, so credited audit work — and the delegate
    budget it backs — is bounded by a claim sealed before the verdict.
  - `revealProbeSet(probeCommitment, probeSetJson)` — after at least one
    attestation references the commitment, the verifier posts the exact
    canonical probe-set JSON bytes on-chain; the contract checks
    `sha256(probeSetJson) == probeCommitment` (an on-chain-verified
    commitment opening) and marks the commitment revealed. Revealing before
    any attestation is rejected, which prevents a reveal-then-probe ordering.
- `AntseedVerifierRewards` contract: emissions-gate bucket controller for
  `VERIFICATION_MINTER_ID`. Each finalized epoch's bucket is split by the
  registry's `delegateShareBps` (default 2000 = 20%) into a verifier pool
  and a delegate pool. The delegate share is carved out only for epochs that
  actually recorded delegate credits (a fully direct-probed epoch pays
  verifiers 100%), and the budget and split are frozen when an epoch is
  first touched, so a later `delegateShareBps` change never resizes it.
  Verifiers claim the verifier pool pro rata to credited audits; buyer
  deposit operators claim the delegate pool pro rata to claimed delegate
  credits via `claimDelegateReward`. Zero-credit epochs settle to
  burn/reserve.
- `antseed verifier start`: a daemon that runs as a full buyer node on the
  network. With no configured services it auto-discovers: one wildcard peer
  discovery per round enumerates every service advertised in signed peer
  metadata, and all of them become audit targets. Per service it selects
  stalest-first cohorts and runs the transparent audit pipeline: author a
  fresh probe set (LLM-generated when `verifier.upstream` is configured,
  certified by the existing reference machinery), commit it on-chain, probe
  every cohort member with identical paid chat-completion batches over the
  ordinary buyer path (indistinguishable from organic traffic, carried by
  delegates where possible), require verified `ResponseAuth` on probe
  traffic, anchor the full exchange batch on-chain, compute cohort (and
  optional KBF-reference) verdicts, submit attestations bound to the anchored
  `batchRoot`, reveal the probe set on-chain (through a durable pending-reveal
  queue honoring an optional `verifier.revealDelayMs` holdback — see "Probe
  Reveal"), and publish the full response pack under
  `verifier.publishDir` (default `<dataDir>/verifier/packs/<commitment>.json`).
  `antseed verifier status` / `claim` cover credits and reward claims.
- LLM probe authoring: with `verifier.upstream` configured the daemon defaults
  to `probeSource: "llm"` — an upstream frontier model authors ~2× candidate
  numeric-answer probes for the target service, each candidate is validated
  structurally (template shape, finite numbers, sane range/tolerance, a
  banned-volatile-pattern screen against time-varying facts), deduplicated
  against the rotation log, and then certified by the EXISTING reference
  machinery (consistency filtering across temperatures plus hold-out
  self-error). `verifier.probeAuthorModel` optionally overrides the authoring
  model. Fallback order when no upstream is configured: `llm` →
  `compositional` → `bank`. Fresh generation is what makes per-audit probe
  burn cheap: revealed probes are never reused, and there is no fixed
  generator fingerprint for a seller to classify.
- Reference enrollment: `antseed verifier reference build` enrolls a model
  through a trusted OpenAI-compatible upstream (canonical provider,
  OpenRouter, or a local deployment of the open weights) — consistency-filter
  candidate probes across multiple temperatures, certify the median as
  `consensus`, and measure the reference's own hold-out error rate as
  `selfTest`. With `verifier.upstream` configured, the daemon enrolls
  references automatically for discovered services that lack one. A certified
  reference is ground truth on its own, so it unlocks auditing services with
  fewer than `cohortMinSize` sellers — down to a single seller. References
  drift as backends update (~7–9 weeks, arXiv:2605.29524); the daemon warns
  when one is older than 7 weeks. Under transparent audits a reference is
  also **single-use per service**: the first reveal that includes its
  certified probes burns it (the reveal publishes each probe's expected
  answer), and the daemon re-enrolls a fresh reference for the service —
  burn-and-refresh, see "Probe Reveal".
- Buyer-delegated probe execution (probe delegation protocol). Direct probing
  originates from the verifier's own buyer identity, which is linked to its
  publicly whitelisted wallet — a cheating seller could classify that
  identity and special-case its traffic. Delegation moves probe origin to
  ordinary opt-in buyer identities. Verifiers hosting delegation announce
  the `verification.probe-delegation.v1` connection capability on the DHT
  (delegation hosts are discoverable via its capability topic). The
  protocol's message types:
  - `DelegateHello = 0x90` — an opt-in buyer connects to a delegation host
    and offers to carry probe jobs, advertising its `maxConcurrentJobs`
    (shipping delegate default 2). If a hello omits the field, the host
    falls back to assuming 1.
  - `DelegateWelcome = 0x91` — the verifier accepts or rejects the delegate.
    A full roster rejects with reason `delegate_capacity` (default cap: 64
    connected delegates). The delegate side is welcome-gated: it rejects all
    jobs until an ACCEPTED welcome arrives, and tears the channel down on a
    rejected or timed-out welcome. Delegates also re-check the verifier against
    the on-chain whitelist on a TTL, dropping revoked verifiers mid-session.
  - `ProbeJobRequest = 0x92` — one fully verifier-crafted stealth probe job
    (job id, target peer, service, exact serialized HTTP request). The
    delegate relays it byte-for-byte over its ordinary paid buyer path after
    enforcing a strict job schema: the request's model must match the
    audited service, streaming is refused, and response sizes are capped.
    The delegate enforces its own advertised `maxConcurrentJobs`.
  - `ProbeJobResult = 0x93` — the seller's response bytes plus its signed
    `ResponseAuth`. Delegates are untrusted transport: the verifier
    re-verifies each seller-signed `ResponseAuth` against the exact request
    it crafted and the response body returned, so a delegate can drop a job
    but never alter or fabricate an observation.
  - `0x94` — RETIRED and RESERVED (never reassign). Formerly `DelegateVoucher`,
    an off-chain EIP-712 voucher the verifier signed and pushed to a carrier.
    Carrier crediting now accrues at anchor time from the buyer named inside
    each seller-signed ResponseAuth payload, verified on-chain by
    `anchorExchangeBatch`; there is no voucher to sign, send, or claim. No
    message is emitted or handled on this type — a peer that still sends one is
    ignored. Carriers discover their accruals from the `DelegateCreditsAccrued`
    event (see below), not from any delegation-channel message.
  - `TargetQuery = 0x95` — before assigning probe jobs, the verifier asks each
    connected delegate which sellers of the audited service that delegate
    ALREADY uses (`{ queryId, service }`).
  - `TargetSuggestion = 0x96` — the delegate answers from its own local
    routing/connection history (`{ queryId, service, sellers: [{peerId,
    agentId}] }`; an empty list is fine). The verifier prefers assigning a
    seller's probes to a delegate that suggested it — the probe then arrives
    over a buyer→seller relationship that genuinely predates the audit —
    and falls back to ordinary assignment for sellers no delegate suggested.
    Suggestions time out after 10 s and are advisory only: they influence
    job placement, never job content.
- Delegate credit discovery: a carrier learns its accruals trustlessly from the
  chain. `anchorExchangeBatch` emits `DelegateCreditsAccrued(verifier,
  probeCommitment, buyer, agentId, serviceHash, credits)` per credited
  (buyer, target) pair, with `buyer` an INDEXED topic — so a carrier
  `queryFilter`s the log filtered by its own address from a persisted block
  cursor (its worker advances the cursor each scan), or polls
  `commitmentDelegateAccrued(verifier, commitment, targetKey, buyer)` for
  keys it learned from those events. No off-chain message carries this; the
  verifier signs and sends nothing.
- Delegate credit claiming: the buyer's deposits OPERATOR — never the buyer
  hot wallet — claims on-chain via
  `AntseedVerifierRegistry.claimDelegateCredits(verifier, probeCommitment,
  buyer, agentId, serviceHash)` — the target (agentId, serviceHash) comes
  from the accrual event. WHO carried WHAT is not claimed by anyone: it
  accrued at anchor time from the buyer named inside each seller-signed
  (and on-chain signature-verified) ResponseAuth payload, keyed by the
  audited target. The claim pays out the buyer's unclaimed accrual on that
  target, clamped to the TARGET's remaining delegate budget — the
  `probeCount` of the verifier's CREDITED attestation of that exact target
  under the commitment, so nothing is claimable before real,
  cooldown-limited, commit-reveal audit work on the target exists, and the
  carriers of one target can never drain the budget another target's
  attestation minted — and to the verifier's remaining per-epoch
  delegate-credit allowance; a clamped remainder stays claimable later. The
  contract resolves the buyer's operator from `AntseedDeposits` at claim
  time. Claimed credits earn from the delegate pool in
  `AntseedVerifierRewards` (see above). This anchor-time accrual REPLACED
  the earlier off-chain EIP-712 `DelegateVoucher` claim flow.

Cohort consensus is the key mechanism enabling verification without a trusted
upstream reference: when N sellers claim the same model, the majority behavior
is the reference and statistical outliers are the substitutes. A verifier
cannot fabricate results after the fact — the probe-set commitment must land
on-chain strictly before the exchange batch is anchored, the anchored batch
carries the seller-signed `ResponseAuth` signature for every probe exchange,
every attestation must reference an anchored `batchRoot` bound to its probe
commitment, and the probe set itself is opened on-chain after attestation.
The full chain of custody — commitment, exchange hashes, signatures, verdicts,
probes — lives in calldata, so anyone can recompute the verdict from public
data alone (see "Recomputing an Audit").

Probe requests are generated by a **stealth engine**: rather than a recognizable
numbered cloze battery ("TASK … output ONLY in (N) <number>"), each request
reads like an organic user message — a seeded natural-language framing wrapping
1–`maxProbesPerRequest` factual questions, with free-text numeric extraction on
the response. This directly addresses the spec's own distinguishability threat:
a seller cannot cheaply classify probe traffic and route only it to the real
model. The stealth-versus-cost trade-off (more, smaller requests are more
organic but incur more per-request fees) is a verifier-side dial. This raises
the bar but does not eliminate it — a determined seller running a classifier
over all traffic can still try, at the cost of real-model spend on false
positives; the endgame remains verification over genuinely organic buyer
traffic.

Where the probes come from is a pluggable **`ProbeSource`**. The default when
an upstream is configured is `"llm"` — fresh, per-audit LLM-authored probes
certified by the reference machinery (see the authoring bullet above). Without
an upstream the daemon falls back to a compositional source that crosses large
entity lists with numeric attribute schemas (element atomic numbers, orbital
periods, country calling codes, …), yielding a probe space of hundreds of
thousands of combinations rather than a memorizable checked-in bank; the
static bank survives as a test/bootstrap fixture (`probeSource: "bank"`).
Compositional probes carry only advisory consensus values and are scored
exclusively by cohort consensus — never against a reference self-test. When a
trusted KBF reference matches the audited service, its certified probes drive
reference verdicts computed alongside cohort verdicts. Because every audit now
ends with an on-chain reveal, every used probe is burned by construction: the
daemon keeps a per-(verifier, service) **rotation log** — the ids of recently
revealed probes (default: last 2000) are excluded from future rounds against
that service, so a seller cannot profit from memorizing past audits. Rotation
applies to all probe sources — certified reference probes included: a reveal
publishes each probe WITH its expected consensus answer, so a substituting
seller could scrape a past reveal and replay the published answers, and a
reference `SAME` overrides a cohort `DIFF`. The daemon therefore
**burn-and-refreshes** references: when the reveal that published a
reference's probes lands, it persists a per-service burn marker for that
reference, records the revealed probe ids in the rotation log, never grades
against the burned reference again, and re-enrolls a fresh reference for the
service; until one is available it falls back to cohort-only grading (no
reference verdict at all). A probe that has appeared in a revealed audit
MUST NOT be reused against the same service, and the LLM author regenerates
and re-certifies a fresh set each round, which is what keeps the burn cheap.

All probe selection, commitment nonces, and stealth phrasing choices derive
from one per-audit CSPRNG seed through standard primitives: RFC 5869
HKDF-SHA256 for domain-separated seed derivation, a NIST SP 800-90A HMAC_DRBG
(SHA-256) for the deterministic stream, rejection sampling for unbiased draws,
and a Fisher–Yates shuffle. Determinism is what makes evidence re-verifiable —
an arbiter re-derives the exact stealth request bodies from the revealed probe
set and nonce and checks the set against the pre-audit commitment.

**Response pack and `evidenceHash`.** The `evidenceHash` in each on-chain
attestation is the bytes32 RFC 8785 (JCS) canonical-JSON hash of the complete
response pack the daemon publishes under `verifier.publishDir` (default
`<dataDir>/verifier/packs/<commitment>.json`; the pack schema is the existing
evidence-bundle schema from `@antseed/fingerprints`). Reproducing the hash
means hashing EXACTLY this structure — every field below is part of the hashed
content, including the per-seller `fullyAuthenticated` flag and the full
`exchanges` array:

```jsonc
{
  "version": 1,
  "service": "gpt-5.4",            // normalized service key
  "verifierAddress": "0x...",       // verifier wallet address
  "probeSet": {                     // the full revealed probe set
    "probeSetId": "...",            // content id over { service, probes }
    "service": "gpt-5.4",
    "probes": [],                   // COMPLETE ordered probe definitions
    "nonce": "...",                 // HKDF-derived commitment nonce
    "createdAt": "..."
  },
  "sellers": [
    {
      "sellerPeerId": "0x...",
      "agentId": 123,
      "answers": [3880, null],      // parsed answers, probe-aligned
      "requestIds": ["req-..."],
      "responseAuthHashes": [
        { "requestHash": "0x...", "responseHash": "0x..." }
      ],
      "verdict": "SAME | DIFF | UNDETERMINED | UNKNOWN",
      "stats": {},                  // per-seller cohort stats
      "fullyAuthenticated": true,   // every probe had a verified ResponseAuth
      "exchanges": [                // full re-verification material per probe
        {
          "requestId": "req-...",
          "request": { "method": "POST", "path": "...", "headers": {}, "bodyBase64": "..." },
          "response": { "statusCode": 200, "headers": {}, "bodyBase64": "..." },
          "responseAuth": {}        // complete signed ResponseAuthPayload, or null
        }
      ]
    }
  ],
  "cohort": {},                     // full cohort result (consensus + verdicts)
  "createdAt": "2026-07-13T00:00:00.000Z"
}
```

`exchanges` is what makes the pack self-contained: it embeds the exact
request/response bytes each signed `ResponseAuth` commits to, so any third
party can re-verify every seller signature offline from the pack alone — no
daemon state required. A re-verifier that hashes only the schema-minimal
seller observation (omitting `fullyAuthenticated` and `exchanges`) computes a
DIFFERENT hash and will fail to match the attested `evidenceHash`.

The pack is the only audit artifact whose availability depends on anyone
hosting anything, and even it is not load-bearing for accountability: response
BODIES are too big for calldata, but their hashes, the seller signatures over
them, and the full probe set all live in calldata forever. A verifier that
withholds or loses its pack cannot un-anchor what it attested to — the
exchange hashes and signatures it committed to remain publicly checkable, and
a pack that later surfaces either matches them or is provably not the audit's
evidence.

**Reputation and enforcement.** The registry accumulates per-(agent, service)
and per-agent verification stats (`sameCount`/`diffCount`/`undeterminedCount`,
distinct-verifier count, last verdict, and `activeDiffVerifierCount` — the
number of distinct verifiers whose LATEST verdict is DIFF, a standing
accusation that a verifier retracts by re-attesting SAME on the same service).
These are facts-only on-chain; buyers compute a local authenticity score per
(peer, model) during discovery (`PeerInfo.modelVerification`) and enforce it
in routing: `DefaultRouter` excludes sellers with a standing substitution
flag for the requested service (falling back to the agent-wide aggregate),
and the CLI/Desktop buyer proxy — which is pinned-peer-only — refuses to
dispatch to a flagged peer, including an explicitly pinned one, until every
accusing verifier retracts. `AntseedVerifierPointsPolicy` is a swappable
`IAntseedPointsPolicy` that zeroes (or partially discounts) an agent's
recognized-usage seller points while at least `minDistinctDiffVerifiers`
(default 2) distinct verifiers hold a standing DIFF against it. Corroboration
is required because DIFF verdicts have a designed false-positive rate (α per
audit) and a single verifier can be mistaken, malicious, or fed by a colluding
cohort; the standing (rather than historical) flag makes the penalty genuinely
reversible — accusers retracting clears it. At the agent level a verifier's
standing DIFF persists while ANY of the agent's services carries it, so
honestly serving a second model never launders a substituted one. This is a
soft, reversible economic penalty — not stake slashing, which still requires
the arbiter-confirmed dispute path below.

### Not Implemented Yet

Still proposed:

- non-KBF verifier families;
- public fingerprint swarm;
- buyer-local fingerprint reference store (the verifier daemon reads local
  reference files; a managed import/store surface is still open);
- verifier staking and slashing for misbehaving verifiers;
- off-chain exhibit verifier for third-party re-checking of M2 real-traffic
  dispute exhibits (verifier-network audits are already third-party
  recomputable via `antseed audit verify`);
- on-chain seller stake slashing for confirmed substitution (the current
  enforcement is a reversible usage-points penalty, not stake slashing);
- two-round re-query against mixed routing (re-probe only first-round
  mismatches, two-stage binomial null — arXiv:2605.29524 reports 95% TPR at
  5–10% substitution fraction for distant substitutes);
- anytime-valid sequential testing (SPRT / e-process on the running mismatch
  count) so blatant substitutes are flagged after ~15–25 probes without alpha
  inflation while marginal cases keep accumulating evidence;
- a passive tier-0 filter scoring sellers' organic completions with an
  idiosyncrasy classifier (https://arxiv.org/abs/2502.12150) to catch gross
  wrong-family substitution for free before spending paid probes.

The next implementation should build on the existing `ResponseAuth` and
verification sample substrate instead of replacing it.

---

## Threat Model

The adversary is a profit-motivated Seller that:

- Sees every request in plaintext before responding.
- Can run more than one backend and route each request to whichever backend it
  chooses, based on the request content.
- Will serve the advertised model only when it believes it is being watched, and
  the cheap substitute otherwise.

This last capability is the crux. **Any verification signal that is
distinguishable from ordinary Buyer traffic is a defeat device waiting to
happen**: the Seller detects the probe, serves the real model for that request,
and cheats everything else. Distinguishability is the property to design out, not
a detail to tune later.

A secondary adversary is a malicious **Buyer** that fabricates or cherry-picks
evidence to slash an honest Seller. Any mechanism that can trigger an on-chain
penalty MUST be robust against this.

External motivation and research grounding:

- "Real Money, Fake Models" documents deceptive model claims in shadow APIs and
  motivates treating model identity as an auditable market claim, not a label to
  trust blindly: https://arxiv.org/abs/2603.01919.
- Knowledge Boundary Fingerprinting (https://arxiv.org/abs/2605.29524) is the
  published protocol this design follows: numeric factual probes near the
  reference model's knowledge boundary, reference-consistency filtering across
  temperatures at enrollment, Clopper–Pearson-bounded self-error, and a
  binomial tail test per audit. Reported 0/30 false positives and 60/60 true
  positives under deployment wrappers (system prompts, RAG, agent CLIs,
  temperature 0–0.7) where LLMmap (37.5% FPR) and distribution tests broke;
  audits cost $0.002–$0.25 per endpoint. Probe staleness is ~7–9 weeks.
- Model Equality Testing (https://arxiv.org/abs/2410.20247) found 11/31
  commercial Llama endpoints deviating from reference weights; its MMD test
  needs a trusted reference distribution and temperature-1 sampling, which
  this protocol avoids by scoring numeric answers directly.
- The spoofing attack literature (GhostPrint,
  https://arxiv.org/abs/2606.16100) shows a cheater can LoRA-finetune a weak
  model on any public probe bank (95% spoof success vs fixed-query
  fingerprinters). The defenses here are exactly the implemented ones: a
  large private compositional probe space, per-audit fresh selection, and
  rotation of revealed probes. Diverse, high-entropy audit distributions were
  the hardest to spoof (23.3% success).
- Black-box tests reliably catch economically meaningful substitution
  (cross-family, size-down, heavy quantization) but NOT near-lossless serving
  changes — 8-bit quantization of the true model is essentially invisible to
  every published black-box method (https://arxiv.org/abs/2504.04715,
  https://arxiv.org/abs/2506.06975). Closing that residual gap requires TEE
  attestation, which is out of scope for this mechanism.

---

## Mechanisms

The mechanisms below are layered. Each is independently useful; combined, they
form an `unattested → signed → attested` trust ladder consistent with the
existing reputation tiers.

### M1 — Behavioral Probes (weakest; bounded usefulness)

The approach proposed in issue #504. The Buyer (or a router middleware) injects
small structured prompts with deterministic, automatically scorable answers —
exact integer counts, fixed-schema JSON, multi-step arithmetic, fixed-length
output — and scores the response with a pure matcher function. An aggregate score
below a threshold over a session yields a fail verdict.

**Strengths:** zero Seller-side changes; cheap (≤30 output tokens per probe);
honest Sellers pass automatically; catches the lazy/casual substitution case.

**Limitations (MUST be understood before relying on this):**

- **Distinguishability.** Probes drawn from a fixed bank, sent as side-channel
  requests that bypass normal routing, are detectable by the adversary in the
  threat model above. A static probe bank published in this repository ossifies
  the moment it is public.
- **Tier, not identity.** Capability probes (arithmetic, format compliance)
  separate a nano tier from a frontier tier. They do **not** distinguish two
  models of similar capability (e.g. a 70B open model impersonating Sonnet), and
  they do **not** detect quantization of the correct model.
- **Self-reported identity is not a signal.** "Who made you?" probes are trivially
  defeated by a one-line system prompt, and open models routinely misreport their
  creator due to training contamination. This probe class SHOULD NOT be used.

M1 is acceptable as a cheap first-pass deterrent and as a way to prioritize where
to spend the more expensive mechanisms. It MUST NOT, on its own, drive on-chain
penalties.

### M2 — Reference Shadow Sampling (recommended core mechanism)

Instead of synthetic probes, sample **real** Buyer traffic. Because the probe is
an actual user request, the Seller cannot treat it differently without treating
all traffic the same way — distinguishability is eliminated by construction.

On a small random fraction `p` of real requests (default `p = 0.02`):

1. The Buyer sends the request to the selected Seller as normal.
2. The Buyer also sends the identical request to a **reference** for the same
   advertised model: the canonical upstream API (when the Buyer holds a key) or a
   TEE-attested peer (see M5) serving that model.
3. The Buyer stores both responses locally, keyed by the request.

A single (request, response) pair proves nothing: at any temperature, serving
stacks are not bitwise deterministic (batching, MoE routing, kernel differences).
Verification is therefore **distributional and accumulated**, never per-request:

- The Buyer accumulates `N` sampled triples for a given Seller (default `N ≥ 30`).
- It runs a two-sample statistical test comparing the Seller's output
  distribution against the reference's (e.g. a Model-Equality-style test over
  per-request similarity, or a distance over output-length / token-distribution
  features). This detects both family substitution and quantization in aggregate.
- Pass → samples are discarded; nothing is published. Fail → the Seller is
  flagged.

**Cost:** `2×` tokens on the sampled fraction only — i.e. ~`p` overhead on total
spend. Probe spend flows through the normal payment channel and SHOULD be tagged
in metering so it is distinguishable from organic usage for accounting.

### M3 — Signed Responses (non-repudiation; enables disputes)

M1 and M2 let a Buyer adjust its **own** routing. They do not, by themselves,
support a verdict any third party can trust, because an unsigned response is
hearsay: the Seller can claim the Buyer fabricated it.

To make verdicts portable, the Seller signs a `ResponseAuthPayload` after every
completed response when the Buyer supports `verification.response-auth.v1`.

```jsonc
{
  "version": 1,
  "requestId": "req-...",
  "channelId": "0x...",
  "buyerPeerId": "0x...",
  "sellerPeerId": "0x...",
  "advertisedService": "gpt-5.4",
  "provider": "openai",
  "statusCode": 200,
  "requestHash": "0x...",
  "responseHash": "0x...",
  "responseStartedAt": 1790000000000,
  "responseCompletedAt": 1790000001200,
  "signature": "0x..."
}
```

The merged implementation signs the following length-prefixed fields under the
domain tag `antseed-response-auth-v1`:

```text
domainTag
version
requestId
channelId || ""
buyerPeerId
sellerPeerId
advertisedService
provider
statusCode
requestHash
responseHash
responseStartedAt
responseCompletedAt
```

- `requestHash = keccak256(encodeHttpRequest(request))`.
- `responseHash = keccak256(encodeHttpResponse(responseWithoutStreamingHeader))`.
- The streaming marker header is stripped before response hashing so streamed
  and reconstructed responses hash consistently.
- Signature verification recovers against the normalized Seller PeerId.
- The Buyer verifies request hash, response hash, request id, status code, buyer
  id, seller id, advertised service, optional channel id, and signature.
- `ResponseAuth` is transported via `VerificationMux` as
  `MessageType.VerificationResponseAuth = 0x80`.
- The Buyer stores all received auths and verification results in the
  `response_auths` SQLite table.
- The Buyer may randomly store full request/response evidence in
  `<dataDir>/verification_samples`.

The signature binds *who emitted which bytes for which request*. It carries no
quality claim on its own — quality comes from M2's statistics or the fingerprint
verifiers in this spec.

The hash is a binding commitment, not a privacy mechanism: the Buyer retains full
plaintext. Hashing only avoids signing megabytes and lets a third party recompute
and verify cheaply.

Any Seller participating in a verifiable/signed trust tier MUST sign every
response requested by a Buyer that advertises `ResponseAuth` support. The
signature is unconditional: the Seller does not learn which responses the Buyer
will later sample, audit, or dispute.

Backward compatibility is implemented by connection-capability negotiation:

- new Seller + new Buyer: Seller sends `ResponseAuth`;
- new Seller + old Buyer: Seller does not send unsupported verification frames;
- old Seller + new Buyer: Buyer logs missing `ResponseAuth` and treats it as
  unavailable evidence, not a transport failure.

### M4 — Passive Fingerprinting (free; always on; triage only)

From ordinary traffic the Buyer derives per-Seller statistics that need no extra
requests: inter-token latency distribution, time-to-first-token, output-length
distribution, and stop/refusal patterns. Each Seller is compared against the
cohort of Sellers advertising the same model; outliers are flagged.

This is weak on its own (timing is noisy and environment-dependent) and MUST NOT
drive penalties. Its value is **triage**: it is zero-cost and tells the Buyer
where to spend M2 sampling budget instead of sampling uniformly.

### M5 — TEE Attestation (strongest; premium tier)

An attested Seller proves, via a hardware remote-attestation quote, which
endpoint and weights it serves. Attested Sellers:

- Require no statistical inference — the attestation is the proof.
- Double as the trusted **reference** for M2, which bootstraps verification for
  Buyers that do not hold canonical upstream API keys.

Attestation is the top of the trust ladder and is expected to command a price
premium. It is out of scope for v1 beyond reserving the tier.

---

## Fingerprint Verifier Suite

Fingerprint verifiers are black-box tests run by the Buyer against the Seller's
normal inference endpoint. They do not require the Seller to reveal weights,
runtime configuration, upstream credentials, or hardware claims.

Every verifier MUST follow the same contract:

1. It receives a `FingerprintReference` selected by the Buyer for an advertised
   service.
2. It emits normal `SerializedHttpRequest` objects that travel through the
   existing Buyer → Seller transport path.
3. It consumes the resulting `SerializedHttpResponse` bytes and the verified
   `ResponseAuth` for each request.
4. It writes an `AuditResult` with a deterministic verdict and enough metadata
   to reproduce the result later.

The initial suite SHOULD include the following verifier families. Each family is
independent; a failure by one family is routing evidence, not automatic slashing
evidence. Strong enforcement requires cross-family agreement or arbiter
confirmation.

### F1 — Knowledge Boundary Fingerprinting (KBF)

KBF probes facts near the claimed model's knowledge boundary: the reference model
answers them consistently, while contrast models answer differently or fail. The
canonical prompt form is numeric cloze completion:

```text
TASK: Answer these factual recall questions using only values stored in your weights.
RULES: Output ONLY in (N) <number> format, one per line.

(1) The melting point of tantalum carbide is ___°C.
(2) The diploid chromosome number (2n) of <organism> is ___.
```

This numbered form is the KBF paper's scoring formulation and is acceptable
against a TRUSTED reference upstream at enrollment time. On the wire against
an audited Seller it is a recognizable test battery and MUST NOT be used —
the implemented stealth engine rewraps the same facts as organic chat
messages with free-text numeric extraction (see "Request Construction").

KBF is useful because numeric answers are mechanically parsed and scored. It is
also limited: when multiple frontier models answer a probe set perfectly, that
probe set has no discriminating power. KBF therefore depends on fresh, private,
model-specific references, not only public probes checked into source control.

An AntSeed KBF verifier MUST implement:

- domain-specific prompt templates;
- domain-specific numeric ranges and tolerances;
- position-aware numeric parsing using `(N)` prefixes;
- match-vector computation: `1` match, `0` mismatch, `null` unparseable;
- reference self-error loading;
- CP99 upper-bound computation for the reference error rate;
- one-sided binomial verdict computation;
- `SAME`, `DIFF`, `UNDETERMINED`, and `UNKNOWN` verdicts.

`SAME` means "not statistically inconsistent with the reference under this
probe set." It MUST NOT be represented as proof that the exact model was served.
`DIFF` is the only verdict that can become adverse evidence.

### F2 — Behavioral Classifier Fingerprints

The Buyer sends prompts selected because known models respond differently and
consistently. The response is converted into features such as refusal style,
format adherence, verbosity, JSON compliance, instruction-following behavior,
and answer shape. A classifier or nearest-reference scorer returns a model
identity score.

This family is broader than KBF and can detect stylistic or policy differences,
but it is easier to perturb with wrapper prompts. It SHOULD be treated as a
routing and triage signal unless combined with stronger evidence.

### F3 — Adversarial Trigger Fingerprints

The Buyer sends private trigger prompts that produce distinctive behavior in the
reference model but not in common substitutes. These prompts can include unusual
formatting, suffixes, ordering constraints, or instruction conflicts.

Triggers MUST be private and rotatable. Public triggers become defeat devices:
the Seller can route trigger-looking traffic to the real model and cheap traffic
elsewhere.

### F4 — Perturbation Fingerprints

The Buyer sends a base prompt and a set of semantic-preserving perturbations:
synonym swaps, clause reordering, punctuation changes, or equivalent JSON key
orderings. The verifier scores how output changes across the perturbation set.

This tests the model's response surface, not only its final answer. It is more
expensive than KBF because one logical probe expands into multiple requests.

### F5 — Tokenizer and Rare-Token Fingerprints

The Buyer uses prompts containing rare token fragments, unusual Unicode, or
tokenizer-sensitive strings. Models with different tokenizers or pretraining
distributions often degrade differently.

This family is useful for detecting model families and serving stacks. It is
fragile across sanitizers, relays, and wrapper systems, so it SHOULD NOT be the
sole source of an adverse verdict.

### F6 — Instruction-Hierarchy Fingerprints

The Buyer sends prompts that exercise system/user conflict handling, refusal
boundaries, schema repair, and hidden-instruction resistance. This often
fingerprints the **Seller stack** (base model plus wrapper), not only the base
model.

For AntSeed this is still valuable: Buyers care about the service they receive,
including wrappers. For model-identity slashing, the verifier MUST distinguish
"different wrapper" from "different claimed model" in the verdict reason.

### F7 — Output-Distribution Fingerprints

When an API supports seeds, logprobs, top-token data, or repeated stochastic
sampling, the verifier compares output distributions instead of single answers.
This is strong when available and unavailable on many endpoints.

The verifier MUST record which distribution features were exposed by the Seller
or upstream-compatible API. Missing logprobs is not an adverse signal by itself.

### F8 — Service Runtime Fingerprints

The Buyer observes protocol and runtime behavior: error shapes, streaming chunk
cadence, headers, timeout behavior, context-window failure modes, and
OpenAI/Anthropic compatibility quirks. This identifies serving software or relay
type more than model identity.

Runtime fingerprints are triage signals. They can justify increasing KBF or
shadow-sampling budget, but they MUST NOT drive slashing directly.

### F9 — Passive Proxy-Reader Provenance

The Buyer analyzes ordinary signed responses after the fact with a provenance
classifier or "reader" model trained to infer which model family or serving stack
likely produced the text. READER-style methods fit here: they extract
representations from generated text and decode authorship/provenance without
requiring active challenge prompts.

This family is important because it can run over normal user traffic already
covered by `ResponseAuth`. It does not make audit traffic distinguishable to the
Seller, and it can prioritize which Sellers should receive active KBF,
behavioral, or perturbation audits.

Limitations:

- It is usually weaker than a targeted active audit for exact model identity.
- It may fingerprint the full Seller stack, including wrappers and system
  prompts, not only the base model.
- It needs calibrated references and should report confidence, coverage, and
  abstentions rather than forcing a verdict.

Reference: "READER: Robust Evidence-based Authorship Decoding via Extracted
Representations" (`arXiv:2606.10794`,
https://arxiv.org/abs/2606.10794).

---

## Package Boundaries

The implementation SHOULD be split into pure verifier logic and AntSeed runtime
orchestration.

### `@antseed/fingerprints`

Day-one pure TypeScript package. No P2P, payment, SQLite, or provider
dependencies. This package is the canonical home for verifier interfaces,
reference schemas, public fingerprint-pack schemas, and the first implemented
verifier family.

Responsibilities:

- shared `FingerprintVerifier` interface;
- shared reference, probe, audit-result, and fingerprint-pack schemas;
- canonical JSON (RFC 8785 JCS) hashing for reference IDs, pack IDs, and audit IDs;
- deterministic randomness (RFC 5869 HKDF-SHA256 + NIST SP 800-90A HMAC_DRBG)
  for probe selection, commitment nonces, and stealth phrasing;
- verifier registry and dispatch by `kind`;
- KBF schemas and validators;
- domain definitions and tolerances;
- prompt construction;
- numeric parser;
- match-vector scoring;
- CP99 / binomial statistics;
- verdict computation;
- fixtures and tests using small public reference files;
- import/export helpers for public fingerprint packs.

Non-responsibilities:

- peer selection;
- sending network requests;
- verifying `ResponseAuth`;
- storing buyer evidence;
- fingerprint swarm discovery, fetching, seeding, and mirroring;
- slashing.

KBF is implemented as the first verifier module inside this package:

```text
packages/fingerprints/
  src/
    index.ts
    types.ts
    canonical-json.ts
    verifiers/
      kbf/
        index.ts
        parser.ts
        prompts.ts
        scoring.ts
        stats.ts
        stealth.ts
        verdict.ts
```

Future verifier families (behavioral classifiers, perturbation tests, rare-token
tests, runtime fingerprints, passive proxy-reader provenance) MUST plug into the
same package-level interfaces instead of creating one-off package APIs.

### `@antseed/fingerprint-swarm`

Optional package or node module for torrent-style public fingerprint pack
distribution. It is separate from pure verifier math because it needs discovery,
signatures, pack fetching, seeding, mirroring, and local trust policy. See
[08-fingerprint-swarm.md](./08-fingerprint-swarm.md).

Responsibilities:

- publish signed public fingerprint packs;
- discover packs by model/service/verifier kind;
- fetch and seed packs by content hash;
- validate pack signatures and provenance;
- maintain local trust scores for pack publishers;
- expose a swarm API to `@antseed/node`.

This can start as an `@antseed/node` module if creating a package is premature,
but the protocol and storage model MUST be designed as decentralized and
content-addressed from day one.

### `@antseed/node`

Runtime integration package.

Responsibilities:

- load references from buyer-local storage;
- discover and import public fingerprint packs;
- select which Seller/service pairs to audit;
- send audit requests through the ordinary Buyer request path;
- wait for and verify `ResponseAuth`;
- store full request/response samples using the existing verification sample
  format;
- call `@antseed/fingerprints` with parsed responses;
- store audit result manifests;
- expose routing/reputation hooks based on audit results.

`@antseed/node` MUST NOT embed verifier-specific math in request handlers. Request
handlers should only provide an authenticated request/response transport and
sample persistence surface.

---

## Reference Lifecycle

References are the durable inputs a Buyer uses to evaluate a Seller. They are
separate from audit results.

### Public References

Public references and fingerprints are useful for tests, demos, interop,
bootstrap, and network-wide reputation. They are weaker than private probes for
adversarial production use because a Seller can learn them, but they are still
strategically important: AntSeed SHOULD become the decentralized public
fingerprint swarm for model fingerprints, verifier references, staleness
signals, and reproducible audit packs.

Repository fixtures MAY live in:

```text
packages/fingerprints/references/public/<model-slug>.json
```

If the checked-in set becomes large, move static fixtures to an optional data
package:

```text
packages/fingerprint-references/
```

Public references imported or adapted from third-party repositories MUST retain
license and provenance metadata in the file and package license notices.

Checked-in references are not the long-term distribution layer. The long-term
distribution layer is a public, decentralized, content-addressed fingerprint
swarm of signed packs. See [08-fingerprint-swarm.md](./08-fingerprint-swarm.md)
for pack announcements, swarm topics, seeding, mirrors, chunk hashes, and trust
policy.

### Private Buyer References

Private references are the normal production path. They are generated or
imported by the Buyer and stored locally:

```text
<dataDir>/fingerprints/
  references/
    <referenceId>.json
  audits/
    <sellerPeerId>/
      <auditId>.json
```

`referenceId` MUST be content-addressed:

```text
referenceId = "sha256:" || sha256(canonical-json(reference-without-local-fields))
```

The canonicalization function MUST follow the JSON Canonicalization Scheme
(JCS, RFC 8785) so it is deterministic across platforms:

- UTF-8 JSON;
- object keys sorted by UTF-16 code units (RFC 8785 §3.2.3);
- no insignificant whitespace;
- numbers serialized per the ECMAScript Number-to-string algorithm
  (RFC 8785 §3.2.2.3);
- finite numbers only — `NaN`, `Infinity`, and `-Infinity` MUST be rejected
  (stricter than JCS, which cannot represent them anyway);
- no local filesystem paths in hashed content.

### Reference Schema

All verifier references share a common envelope:

```jsonc
{
  "version": 1,
  "kind": "kbf",
  "referenceId": "sha256:...",
  "referenceModel": "openai/gpt-5.4",
  "serviceAliases": ["gpt-5.4", "openai/gpt-5.4"],
  "createdAt": "2026-06-14T00:00:00.000Z",
  "source": "public | generated | imported",
  "generator": {
    "name": "@antseed/fingerprints",
    "version": "0.1.0",
    "verifierKind": "kbf",
    "params": {}
  },
  "provenance": {
    "license": "Apache-2.0",
    "url": "https://github.com/Ooo0ption/KBF",
    "commit": "<optional>"
  },
  "selfTest": {
    "hamming": 3,
    "total": 224,
    "coverage": 1.0,
    "errorRate": 0.0134
  },
  "probes": []
}
```

Verifier-specific payloads live inside `probes` and optional extension fields.
Unknown extension fields MUST be preserved by import/export tools and ignored by
verifiers that do not understand them.

### KBF Probe Schema

```jsonc
{
  "id": "chemistry_mp:tantalum-carbide",
  "name": "tantalum carbide",
  "domain": "chemistry_mp",
  "template": "The melting point of {name} is ___°C.",
  "consensus": 3880.0,
  "range": [-300, 4000],
  "tolerance": {
    "mode": "absolute",
    "value": 3.0
  },
  "consensusRaw": {
    "t0": 3880.0,
    "t07_a": 3880.0,
    "t07_b": 3880.0
  },
  "contrast": {
    "model": "qwen/qwen3.5-9b",
    "value": 3980.0,
    "agrees": false
  }
}
```

Generation rules:

- A probe is valid only if the reference model answers consistently under the
  configured consensus passes.
- A probe SHOULD be screened against one or more contrast models.
- Numeric comparison MUST use the probe's domain tolerance.
- A probe set SHOULD include multiple domains so a substitute cannot overfit one
  narrow capability.
- Public probe sets MUST be considered stale over time. Stronger future models
  may answer all old probes correctly.

---

## Buyer Audit Execution

On the wire, an audit is a normal AntSeed request sequence: the Seller MUST NOT
be able to tell whether a request is user traffic or audit traffic while the
audit is in flight. Around that wire traffic, the verifier network's audit
pipeline is transparent and its normative order is:

> **commit → carry → anchor → attest → reveal.**

1. **Generate** — author a fresh probe set for the target service. With an
   upstream configured, an LLM authors candidates and the existing reference
   machinery certifies them (see "Probe Authoring").
2. **Commit** — seal `sha256(canonicalJson({ service, probes, nonce }))`
   on-chain via `commitProbeSet` before any probe is sent.
3. **Carry** — solicit organic targets from connected delegates
   (`TargetQuery`/`TargetSuggestion`), dispatch verifier-crafted probe jobs
   over delegate buyer paths (verifier-direct fallback), and collect responses
   with verified `ResponseAuth` on every exchange.
4. **Anchor** — post the full exchange batch on-chain as calldata (records
   plus the exact seller-signed ResponseAuth payloads); the contract verifies
   every seller signature against the agent's ERC-8004 owner, accrues carrier
   delegate credits from the buyer named in each payload, recomputes the
   Merkle root from the records and binds it to the probe commitment.
5. **Attest** — submit per-seller verdicts referencing the anchored
   `batchRoot`. Grading (cohort consensus + optional KBF reference) is
   unchanged from the math described above.
6. **Reveal** — open the probe commitment on-chain by posting the exact
   canonical probe-set JSON bytes, and publish the response pack to
   `verifier.publishDir`.

Each on-chain step is order-enforced by the contract: commit strictly before
anchor, anchor strictly before (or in the same transaction as) attest, reveal
only after at least one attestation references the commitment. After step 6
the audit is a closed, public record — anyone can re-run it (see "Recomputing
an Audit").

### Audit Selection

The Buyer chooses `(sellerPeerId, advertisedService, referenceId, verifierKind)`
using local policy:

- random background coverage;
- higher sampling for new Sellers;
- higher sampling for Sellers with passive-runtime outliers;
- higher sampling for expensive or slashable claims;
- lower sampling after recent clean audits.

Selection is Buyer-local and MUST NOT be advertised to the Seller.

### Probe Authoring

Because every audit ends with an on-chain reveal, probe supply must be
unbounded and per-audit fresh. The default probe author when
`verifier.upstream` is configured is an upstream frontier LLM
(`probeSource: "llm"`; `verifier.probeAuthorModel` optionally overrides the
authoring model):

1. The author requests roughly `2×` the needed count of candidate probes for
   the target service — numeric-answer factual questions the model answers
   stably, explicitly excluding time-varying facts — as a strict JSON array of
   `{name, domain, template, consensus, range, tolerance}` objects.
2. Every candidate is validated mechanically: the template contains the cloze
   slot, all numbers are finite, `lo < consensus < hi`, the tolerance is sane,
   and the text passes a banned-volatile-pattern screen (population, price,
   current, latest, today, …).
3. Surviving candidates are deduplicated against the rotation log and fed into
   the EXISTING certification path — consistency filtering across temperatures
   against the trusted upstream reference plus a hold-out self-error
   measurement — and the required count of certified probes is kept.

LLM authoring produces no fixed generator fingerprint a seller could learn to
classify, and it makes probe burn (see "Probe Reveal") a per-audit operating
cost rather than the exhaustion of a finite bank. Fallback order without an
upstream: `llm` → `compositional` → `bank`.

### Request Construction

Probe requests are built by the stealth engine in `@antseed/fingerprints`
(`buildStealthChatRequests`). The pre-stealth construction — a fixed system
prompt plus a numbered `TASK … output ONLY in (N) <number>` cloze battery —
is exactly the classifiable side-channel this spec's own threat model
forbids, and MUST NOT be sent to an audited Seller.

Each wire request instead reads like an organic user chat message:

- a seeded natural-language framing (many varied templates and phrasings)
  wraps 1–`verifier.maxProbesPerRequest` factual questions (default 3);
- no fixed marker tokens, fixed system prompt, or numbered answer format;
- the wire `model` field preserves the Seller's advertised spelling;
- answers are recovered by free-text numeric extraction over the completion,
  position-aligned with the embedded facts;
- every phrasing choice derives deterministically from the per-audit seed, so
  an arbiter re-derives the exact request bodies from the revealed probe set
  and nonce.

The probes themselves MUST NOT come from a fixed public bank: the default
probe source is LLM authoring (fresh certified probes per audit, compositional
generation as the upstream-less fallback), probes revealed by past audits
rotate out per (verifier, service), and the stealth-versus-cost trade-off
(more, smaller requests read more organic but incur more per-request fees) is
the verifier's `maxProbesPerRequest` dial.

The Buyer MAY apply protocol adapters for OpenAI Chat, OpenAI Responses,
Anthropic Messages, or future formats. The adapter belongs in the verifier
package only if it is transport-agnostic. Actual sending belongs in the
runtime (`@antseed/node` and the CLI daemon).

### Target Solicitation and Carriage

Delegated carriage (message types `0x90-0x93`, plus target solicitation
`0x95`/`0x96`; `0x94` is retired/reserved — see "Implementation Status")
remains the in-flight stealth mechanism: probes
originate from ordinary opt-in buyer identities, not from the publicly
whitelisted verifier wallet, and delegates relay verifier-crafted requests
byte-for-byte (the verbatim-relay invariant — a delegate can drop a job but
never alter or fabricate an observation, because the verifier re-verifies each
seller-signed `ResponseAuth` against the exact request it crafted).

Job placement is target-solicited. Before assigning probe jobs the verifier
sends a `TargetQuery (0x95)` for the audited service to each connected
delegate; each delegate answers with a `TargetSuggestion (0x96)` listing the
sellers of that service it ALREADY uses, drawn from its own local
routing/connection history (empty list allowed; 10 s collection timeout). The
verifier prefers assigning a seller's probes to a delegate that suggested that
seller — the probe then travels a buyer→seller relationship that predates the
audit and carries that relationship's ordinary traffic pattern. Sellers no
delegate suggested fall back to ordinary delegate assignment, and sellers
unreachable through any delegate fall back to verifier-direct probing.
Suggestions are advisory routing hints only: they never influence probe
content, and a lying delegate can at worst place a job suboptimally.

### ResponseAuth Requirement

The underlying `ResponseAuth` mechanism is negotiated for normal Buyer/Seller
requests when both peers support `verification.response-auth.v1`, and the
implemented audit runner enforces it on probe traffic: audit cohorts only
include Sellers advertising the capability, every probe request must yield a
`ResponseAuth` that verifies against the exact request and response bytes,
and a Seller whose probe run is not fully authenticated is never attested —
an adverse verdict that cannot be backed by signed responses stays off-chain.

Unauthenticated probes do not count as model mismatches. They count as Seller
non-cooperation for routing/reputation policy.

### Exchange-Batch Anchoring

Once all probe responses for an audit round are collected and their
`ResponseAuth`s verified, and BEFORE any verdict is attested, the verifier
anchors the complete exchange batch on-chain via
`AntseedVerifierRegistry.anchorExchangeBatch(probeCommitment, records,
signingPayloads, recordProbeCounts)`. One `ExchangeRecord` per SIGNED STEALTH
REQUEST goes into calldata — each request bundles 1–`maxProbesPerRequest`
probes (the stealth engine folds several facts into one organic-looking chat
request), so a batch's total probe count generally exceeds its record count:

```solidity
struct ExchangeRecord {
    uint256 agentId;         // audited seller
    bytes32 requestHash;     // keccak256 of the exact request bytes sent
    bytes32 responseHash;    // keccak256 of the exact response bytes received
    bytes   responseAuthSig; // seller's 65-byte ECDSA over the ResponseAuth payload
}
```

`signingPayloads[i]` is the exact ResponseAuth signing preimage for record i
(13 length-prefixed UTF-8 fields — domain, version, requestId, channelId,
buyerPeerId, sellerPeerId, advertisedService, provider, statusCode,
requestHash, responseHash, responseStartedAt, responseCompletedAt — the FROZEN
wire format of `buildResponseAuthSigningBytes` in packages/node), and the
contract verifies every record ON-CHAIN at anchor time:

- `responseAuthSig` must recover, over the EIP-191 personal-sign digest of
  `"antseed-data-v1:" || signingPayloads[i]`, to the seller behind
  `records[i].agentId` — resolved as the agent's ERC-8004 IdentityRegistry
  owner, the same canonical peer ↔ agent binding `AntseedStaking` enforces at
  stake time (agentId → address resolution is cached in memory across the
  batch, since a cohort repeats few sellers);
- the payload's embedded `requestHash`/`responseHash` hex fields must equal
  the anchored record's hashes;
- the payload's `buyerPeerId` field names the carrier that transported the
  exchange — the basis for delegate crediting (see "Delegate Crediting").

A verifier therefore cannot anchor an exchange the audited seller never
signed, and cannot misattribute a carried exchange to a different carrier.

`recordProbeCounts[i]` (each 1..3) declares the number of probes bundled in
record i's request. The batch's total probe count is the contract-enforced
SUM of these declarations — fixed at anchor time, before any verdict exists,
and publicly recomputable by third parties once the probe set is revealed:
count the probes each anchored request carries in the response pack. It caps
the `probeCount` any later attestation referencing the batch may claim.

The contract — not the verifier — recomputes the Merkle root from the calldata
records (leaf = `keccak256(abi.encode(agentId, requestHash, responseHash,
keccak256(sig)))`, pairwise keccak256, odd node promoted) and stores a single
packed anchor struct keyed by `(verifier, batchRoot)` — readable via
`batchAnchors(verifier, batchRoot)`:

```solidity
struct BatchAnchor {
    uint64  anchoredAt;  // when the batch was anchored (0 = never)
    uint32  recordCount; // ExchangeRecords anchored (one per signed request)
    uint32  probeCount;  // declared probes bundled across the records
    bytes32 commitment;  // probe-set commitment the batch was anchored under
}
```

The referenced probe commitment MUST have been committed strictly earlier.
Because the root is derived on-chain from the posted data, a verifier cannot
anchor a root whose preimage it withholds: anchoring IS publication of the
seller-signed exchange skeleton.

One anchor call covers up to ~256 records; a larger audit round anchors
one batch under each probe commitment. Records are hard-bounded to `[1, 256]`
per batch, duplicate request hashes are rejected, and on-chain
signature verification prices each record at ~26k execution gas marginal
(~690k total for a realistic 24-record batch), so ~256 records per
transaction is the practical ceiling. Calldata cost is the deliberate trade
for permanence, and on Base it is small:

| Audit size | Records | Calldata | Execution gas | Cost on Base |
|---|---|---|---|---|
| 8 sellers × 24 probes (defaults) | ~64 | ~40 KB | ~1.8M | well under a cent |
| 50 sellers × 20 probes | 1000 (4 batches of 250) | ~600 KB | ~8M per batch | cents |

Anchoring makes evidence availability serverless: the hashes, signatures AND
the exact signed payloads a verdict rests on live in calldata forever,
independent of any verifier, website, or storage service staying online — and
because the contract verified every signature before accepting the batch,
what is anchored is seller-authenticated, not merely verifier-published.

### Attestation Binding

`submitAttestation` carries a `batchRoot` parameter. The contract requires the
root to be anchored by the attesting verifier and requires the anchored
batch's stored probe commitment to equal the attestation's probe commitment.
A verdict therefore always points at a specific, already-public,
seller-signed evidence set — there is no such thing as an attestation whose
evidence "will be provided later" or turns out to belong to a different probe
set. The attestation's `probeCount` is additionally capped by the batch's
anchor-time probe-count sum (NOT its record count — records bundle
multiple probes), so the credited audit work and the delegate budget
it backs are bounded by a claim that was sealed on-chain before the verdict.
Verdict computation itself (cohort consensus, CP99/binomial reference
tests, SAME/DIFF/UNDETERMINED/UNKNOWN semantics) is unchanged.

### Probe Reveal

After attestations land, the verifier opens the probe commitment on-chain:
`revealProbeSet(probeCommitment, probeSetJson)` posts the exact canonical JSON
bytes of `{ service, probes, nonce }`, and the contract verifies
`sha256(probeSetJson) == probeCommitment` before accepting. The contract
rejects a reveal for a commitment no attestation references (a verifier could
otherwise reveal first and probe with known-public probes) and rejects
double reveals.

Reveals are **durable**: after the round's attestations, the daemon enqueues
the reveal to an on-disk pending queue with a due time of
`now + verifier.revealDelayMs` (default 0 = due immediately, so the reveal
still goes out in the same round, right after attestation) and drains all due
entries at every round boundary and at daemon startup. The delay is a due
time on the queue, never an inline sleep in the sequential audit loop. A
failed reveal stays queued with a warning and is simply retried at the next
drain — the contract imposes no reveal deadline, so retrying across daemon
restarts is always safe.

Reveal is what turns the audit from a trust-me claim into a public record: the
probes, their scoring parameters, and the commitment nonce are now on-chain
next to the anchored exchange hashes and signatures. Revealed probes are
burned — the rotation log excludes them from all future rounds against the
service — and the LLM author replaces them at the next round. When the
revealed set was a certified reference's probes, the reveal published each
probe's expected answer, so the reference itself is burned as the reveal
lands: the daemon persists a per-service burn marker, rotation-logs the
revealed reference probe ids, re-enrolls a fresh reference for the service,
and grades cohort-only until one exists. A burned reference can therefore
never again produce the reference `SAME` that would exonerate a seller
replaying published answers.

### Evidence Publication

Random buyer-side evidence sampling is implemented for verified `ResponseAuth`
records on organic traffic. Audit probes do not rely on that sampler: the
verifier daemon persists the COMPLETE exchange for every probe — exact request
bytes, exact response bytes, and the full signed `ResponseAuth` payload —
inside the audit's response pack (see "Response pack and `evidenceHash`"
above), so audit evidence retention is total by construction rather than
sampled. Packs embed the bytes directly, do not reference
`verification_samples` sample ids, and are written to `verifier.publishDir`
(default `<dataDir>/verifier/packs/<commitment>.json`) after the reveal;
`evidenceHash` in the attestation is the canonical hash of the pack. The pack
carries the response plaintexts, which are the only audit data too large for
calldata — everything needed to check that a pack is genuine (probe set,
exchange hashes, seller signatures) is already on-chain.

The organic-traffic sample directory format remains:

```text
<dataDir>/verification_samples/
  <sellerPeerId>/
    <sampleId>/
      manifest.json
      request.bin
      response.bin
```

### Audit Result Schema

```jsonc
{
  "version": 1,
  "auditId": "sha256:...",
  "verifier": {
    "kind": "kbf",
    "package": "@antseed/fingerprints",
    "version": "0.1.0"
  },
  "sellerPeerId": "0x...",
  "advertisedService": "gpt-5.4",
  "referenceId": "sha256:...",
  "referenceModel": "openai/gpt-5.4",
  "startedAt": "2026-06-14T00:00:00.000Z",
  "completedAt": "2026-06-14T00:05:00.000Z",
  "probeCount": 224,
  "authenticatedProbeCount": 224,
  "parsedProbeCount": 220,
  "matchVectorHash": "sha256:...",
  "stats": {
    "selfHamming": 3,
    "selfTotal": 224,
    "targetHamming": 40,
    "targetTotal": 220,
    "selfCoverage": 1.0,
    "targetCoverage": 0.9821,
    "p0Cp99": 0.0634,
    "pValueBinomial": 0.00001
  },
  "verdict": "SAME | DIFF | UNDETERMINED | UNKNOWN",
  "verdictReason": null,
  "samples": [
    {
      "batchId": "chemistry_mp:0001",
      "requestId": "req-...",
      "sampleId": "req-...-abcd",
      "responseAuthRequestHash": "0x...",
      "responseAuthResponseHash": "0x..."
    }
  ]
}
```

`auditId` MUST be a content hash over the canonical audit result excluding local
paths. This lets arbiters and Buyers refer to the same exhibit without trusting a
database row ID.

### Local Routing Policy

Buyer-local policy MAY act immediately:

- `SAME`: no action; optionally reduce audit frequency for this Seller/service.
- `UNDETERMINED`: increase coverage or mark reference as weak.
- `UNKNOWN`: reference is invalid for enforcement; do not penalize Seller.
- `DIFF`: remove Seller from local routing for this service and persist the audit
  result.
- repeated unauthenticated audit probes: downgrade trust tier.

Local routing does not require consensus and does not slash.

---

## Reference Growth and Rotation

References are living data. They decay as models improve, facts become common in
training data, public probes leak, or serving behavior changes.

Reference maintenance rules:

- Public references are for reproducibility and smoke tests.
- Private references are for production enforcement.
- Buyers SHOULD rotate private KBF references periodically.
- Buyers SHOULD maintain at least two independent private references for
  expensive/slashable services.
- References SHOULD record the contrast models and generation method used.
- References SHOULD be re-self-tested after major upstream model updates.
- A reference with high self-error or low self-coverage MUST NOT be used for
  adverse action.
- A reference whose probes are answered perfectly by multiple strong contrast
  models SHOULD be marked stale.

Growing references is both a local Buyer capability and a network capability.
From day one, AntSeed SHOULD support public signed fingerprint packs so the
network can accumulate shared model fingerprints over time. Private Buyer
references remain local and SHOULD NOT be published while unused: a probe is
secret exactly until the audit that uses it completes. The verifier network
then DOES store the used probe set on-chain — the post-attestation reveal —
because on Base the calldata is cheap and the routing-around concern is
answered by rotation plus fresh per-audit LLM authoring: a Seller that
memorizes every revealed probe learns nothing about the next round's set.
What remains out of scope is publishing probes BEFORE use, which would
recreate the fixed-public-bank defeat device.

---

## Verification Flow

The end-to-end flow combines the mechanisms. Note what is continuous, what is
sampled, what is periodic, and what is rare.

**Verifier audit round (whitelisted verifier network; periodic, per service):**

The normative order is **commit → carry → anchor → attest → reveal**, each
on-chain step order-enforced by `AntseedVerifierRegistry`:

1. **Generate.** An upstream frontier LLM authors candidate probes for the
   target service; the existing reference machinery certifies them
   (temperature-consistency filter + hold-out self-error). Fallback:
   compositional generation, then the bank fixture.
2. **Commit.** `commitProbeSet(sha256(canonicalJson({service, probes,
   nonce})))` lands on-chain before any probe is sent. The probe set is secret
   from this point until step 6 — and only until then.
3. **Carry.** The verifier solicits organic targets from its delegates
   (`TargetQuery`/`TargetSuggestion`, `0x95`/`0x96`), dispatches stealth probe
   jobs preferring delegates that already use the audited seller, and
   collects responses with a verified seller-signed `ResponseAuth` per
   exchange. Delegates are untrusted verbatim relays.
4. **Anchor.** `anchorExchangeBatch` posts every
   `(agentId, requestHash, responseHash, responseAuthSig)` record plus its
   exact ResponseAuth signing payload as calldata; the contract verifies each
   seller signature on-chain (recovered signer must be the agent's ERC-8004
   owner and the payload's hashes must match the record), accrues delegate
   credits to the carrier buyer named in each payload, recomputes the Merkle
   root and binds it to the commitment. The seller-signed evidence skeleton
   is now public, immutable and chain-authenticated.
5. **Attest.** Cohort/KBF grading runs unchanged; `submitAttestation`
   verdicts must reference the anchored `batchRoot`.
6. **Reveal.** `revealProbeSet` opens the commitment on-chain
   (`sha256` checked by the contract); the response pack is published to
   `verifier.publishDir`. Anyone can now recompute the whole audit — see
   "Recomputing an Audit".

**Buyer-local flow (every request, 100%):**

1. Buyer → Seller request; Seller → response; Seller also sends `ResponseAuth`
   when both peers negotiated `verification.response-auth.v1` (M3).
2. Buyer verifies `responseAuth` recovers to the Seller's PeerId and stores the
   auth payload in verification storage. If no auth arrives, Buyer logs missing
   evidence rather than failing the HTTP response.
3. Buyer may store full request/response bytes in the verification sample
   directory according to local sampling policy.
4. Buyer updates passive fingerprint statistics (M4).

**Sampled request (`p`, Seller cannot tell which):**

5. Buyer additionally queries the reference and stores both signed responses
   locally (M2).

**Accumulation (per Seller, ongoing, Buyer-local):**

6. Once `N` samples exist, Buyer runs the distributional test (M2). Pass →
   discard. Fail → flag the Seller.

**Local enforcement (immediate, no consensus needed):**

7. A flagged Seller is dropped from this Buyer's `selectPeer()` candidate pool.
   This is the Buyer's own routing choice and requires no external agreement.

**Escalation (rare; only on a flagged, signed Seller; M2 real-traffic evidence
only):**

Verifier-network audits never reach this path — their evidence is anchored and
revealed on-chain, so there is no exhibit to assemble and no arbiter needed to
check it. The dispute-exhibit machinery below exists for M2 real-traffic
sampling, where the evidence is a Buyer's own private prompts and completions
and MUST NOT be published.

8. If the Buyer seeks on-chain consequences, it assembles an **evidence exhibit**:
   the signed sample set plus the corresponding reference responses.
9. The exhibit is submitted to a dispute path. Raw request/response bytes leave
   the Buyer **only at this step** and go to the arbiter, not to any public feed.
   On-chain, only a commitment (a hash of the exhibit) need be stored; the bytes
   may live off-chain and be revealed during adjudication.
10. The arbiter does not trust the Buyer. It (a) verifies every `responseAuth`
   mechanically — proving the samples are genuinely the Seller's — and (b)
   re-runs the test, or better, re-queries the accused Seller and the reference
   itself with fresh requests, since a real substitution reproduces over fresh
   samples while a fabricated accusation does not. On confirmation, the swappable
   slashing contract (`AntseedSlashing`) burns the Seller's stake.

---

## Recomputing an Audit

The point of the transparent pipeline is that a verdict is not a claim to
trust but a computation to repeat. `antseed audit verify
<txHashOrCommitment>` re-runs an audit end-to-end from public data:

1. **Fetch.** Given an RPC URL, the verifier address, and a probe commitment
   (or the anchor transaction hash), fetch the anchor calldata (the full
   `ExchangeRecord[]`) and the revealed canonical probe-set JSON from chain.
2. **Recompute the root.** Rebuild the Merkle root from the fetched records
   with the same leaf/pairing rules as the contract and check it against the
   anchored `batchRoot`.
3. **Check the opening.** Verify `sha256(probeSetJson)` equals the probe
   commitment, and that the commitment landed strictly before the anchor.
4. **Verify signatures.** With `--pack <path|url>` pointing at the published
   response pack, verify every seller `ResponseAuth` signature against the
   pack's request/response plaintexts, and check that each exchange's
   request/response hashes match the anchored records.
5. **Re-grade.** Re-extract numeric answers from the pack's responses with
   the fingerprints parser, re-run the cohort/KBF verdict math over the
   revealed probe definitions, and compare the resulting per-seller verdicts
   with the on-chain attestations.

The command prints per-seller verdicts and whether each MATCHES its on-chain
attestation, and exits non-zero on any mismatch — root, opening, signature,
hash, or verdict. Steps 1-3 need nothing but an RPC endpoint; steps 4-5
additionally need the response pack, whose authenticity is itself checked
against the anchored hashes, so a re-verifier never has to trust the party
that hosted it.

### Trade-offs

The design buys public recomputability with three honest costs:

- **Per-audit probe burn.** Every revealed probe is spent — the rotation log
  never reuses it against that service. LLM authoring is the mitigation:
  probe supply is generated, certified, and replaced each round instead of
  drawn down from a finite bank, so the burn is an operating cost, not an
  exhaustible resource. Without a configured upstream, the compositional
  space (hundreds of thousands of combinations) absorbs the burn instead.
- **Carrier identification post-reveal.** Once the probes are public, an
  audited seller can grep its request logs, identify which buyer carried
  which probe, and de-prioritize or profile that buyer. In-flight stealth is
  unaffected — the seller learns this only after answering under a signed
  `ResponseAuth` — but delegates SHOULD be rotated across audits rather than
  reused against the same seller, `verifier.revealDelayMs` can hold the
  reveal back to blur the mapping between recent traffic and a published
  probe set, and end-of-epoch reveal batching is a planned future knob.
  A seller that retaliates by degrading a suspected carrier's future traffic
  is degrading a paying customer it can no longer distinguish from the next
  audit's fresh carrier.
- **Optimistic acceptance.** The contract does not re-grade responses; it
  enforces ordering, data binding, and openings, and acts on attestations
  from whitelisted verifiers optimistically. The enforcement lever is the
  whitelist plus public recomputability: a wrong or fabricated verdict is
  demonstrable by ANYONE running `antseed audit verify`, and the demonstrated
  failure is grounds for de-whitelisting (and, in the proposed roadmap,
  verifier stake slashing). Trust is not eliminated; it is reduced to
  "someone, anyone, will check" — which the cents-per-audit cost of checking
  makes realistic.

---

## Slashing Roadmap

Fingerprinting is probabilistic. On-chain contracts MUST NOT slash directly from
a Buyer-local verifier result. The on-chain role is to accept a compact,
verifier-signed outcome after an off-chain dispute process has checked the
evidence.

### Slashable Claim

A Seller can make a slashable model-identity claim by advertising or registering
a policy commitment:

```jsonc
{
  "claimType": "model_identity",
  "service": "gpt-5.4",
  "referencePolicy": "sha256:...",
  "acceptedVerifiers": ["kbf", "behavioral-classifier"],
  "minCoverage": 0.8,
  "alpha": 0.05,
  "stakeSubjectToSlash": "100000000"
}
```

The claim says: "I am willing to be penalized if independent verification shows
that this service is statistically inconsistent with the claimed reference under
this policy." It does not require the Seller to know the Buyer's private probes.

### Commit-Reveal for Adverse Audits

If private probes can lead to slashing, the Buyer MUST be unable to choose only
bad probes after seeing responses. Use a standard hash commitment scheme
(binding via SHA-256 collision resistance, hiding via a fresh 256-bit nonce):

1. Before sending audit requests, Buyer computes:

   ```text
   probeSetCommitment = sha256(canonicalJson({ service, probes, nonce }))
   ```

   where `probes` is the ordered array of COMPLETE probe definitions — every
   scoring-relevant field (`id`, `name`, `domain`, `template`, `consensus`,
   `range`, `tolerance`, and any extension fields), canonicalized per RFC 8785
   (JCS). Committing to probe ids alone is insufficient: a committer could
   observe responses and then tighten `tolerance` or alter
   `consensus`/`range`/`template` while an ids-only commitment still verified.
   The nonce MUST be 256 bits and derived from fresh CSPRNG entropy (directly,
   or via an RFC 5869 HKDF expansion of a per-audit random seed). If the same
   seed is reused with a rotation exclusion set, the nonce derivation MUST
   also bind that exclusion set, so a rotated regeneration never reuses an
   already-revealed nonce.

2. Buyer records the commitment locally and MAY submit it to a cheap timestamping
   or dispute-intent path when the audit starts.
3. Buyer sends the ordered probe set through normal request flow.
4. After responses, Buyer reveals the full ordered probe definitions and
   `nonce` inside the evidence exhibit.
5. Arbiter verifies that the revealed probe definitions — content, order, and
   scoring parameters, not just ids — match the pre-response commitment.

For local routing, commit-reveal is optional. For slashing, it is mandatory.

The whitelisted verifier network implements this scheme entirely on-chain:
`commitProbeSet` is the commitment, `anchorExchangeBatch` timestamps the
signed observations, and `revealProbeSet` is the opening — checked by the
contract, not by an arbiter. The off-chain exhibit variant above remains the
path for Buyer-local M2 evidence, where the underlying bytes are private user
traffic that cannot be published.

### Evidence Exhibit

An exhibit is off-chain data addressed to an arbiter or verifier committee:

```jsonc
{
  "version": 1,
  "claim": { "sellerPeerId": "0x...", "service": "gpt-5.4" },
  "auditId": "sha256:...",
  "probeSetCommitment": "sha256:...",
  "reference": { "referenceId": "sha256:...", "bytesHash": "sha256:..." },
  "auditResult": { "bytesHash": "sha256:..." },
  "samples": [
    {
      "requestBytesHash": "0x...",
      "responseBytesHash": "0x...",
      "responseAuth": {},
      "requestBytes": "<off-chain bytes>",
      "responseBytes": "<off-chain bytes>"
    }
  ]
}
```

The arbiter verifies:

- every `ResponseAuth` signature recovers to the Seller PeerId;
- every signed request hash matches the supplied request bytes;
- every signed response hash matches the supplied response bytes;
- every request occurred after the probe-set commitment;
- the audit result recomputes from the reference and samples;
- coverage thresholds are met;
- the verdict is `DIFF` under the registered policy.

### On-Chain Slash Signal

The slashing contract receives only a compact outcome:

```jsonc
{
  "seller": "0x...",
  "service": "gpt-5.4",
  "claimHash": "bytes32",
  "auditBundleHash": "bytes32",
  "verdict": "DIFF",
  "verifierSet": "bytes32",
  "signatures": ["0x..."],
  "deadline": 1790000000
}
```

Raw prompts, completions, and probe files do not go on-chain. The contract checks
the verifier signatures and applies the slash policy for `claimHash`.

Recommended enforcement ladder:

- single local `DIFF`: Buyer routing downgrade;
- repeated independent local `DIFF`: reputation warning and increased sampling;
- arbiter-confirmed `DIFF` against a slashable claim: stake slash;
- missing `ResponseAuth` on audit traffic: non-cooperation penalty, not
  model-fraud slashing by itself.

---

## Privacy

Two different things travel through verification, with opposite privacy
requirements.

**Real Buyer traffic MUST NOT be broadcast.** Real prompts and completions are
sensitive:

- M2 samples are stored Buyer-locally and discarded on a pass.
- Raw real-traffic bytes leave the Buyer only inside a dispute exhibit,
  addressed to an arbiter, and only for a Seller already flagged.
- For real traffic, on-chain artifacts are commitments (hashes), never
  plaintext.

**Verifier probes are secret only until reveal.** A probe is synthetic — it
contains no user data — and its secrecy exists solely to prevent the Seller
from special-casing it in flight. Accordingly:

- Before and during the audit, the probe set is hidden behind its on-chain
  commitment, and in-flight stealth via delegate carriers is unchanged: the
  Seller cannot distinguish a probe from organic traffic while answering it.
- After attestation, the probe set is deliberately published on-chain, and the
  full probe request/response pack is published to `verifier.publishDir`.
  Probe exchanges have no privacy interest once used — publication is what
  makes the verdict recomputable.
- Evidence availability does not depend on any server: the exchange hashes,
  seller signatures, and probe definitions live in calldata forever. Only the
  response plaintexts live off-chain (in the pack), and their integrity is
  checkable against the anchored hashes.

---

## Abuse Resistance (malicious Buyer or Verifier)

Signed responses (M3) make the Seller non-repudiable, which neutralizes the
naive forge-evidence attack: a Buyer cannot invent a signed response. For M2
real-traffic exhibits the residual attack is **selective omission** — a Buyer
presenting only unfavorable samples. This is countered by requiring the
exhibit's sample set to reconcile against the Buyer's metered request history
(already retained for billing per [03-metering.md](./03-metering.md)) and by
the arbiter's own fresh re-query in step 10, which does not depend on the
Buyer's samples at all.

For verifier-network audits the transparent pipeline makes the corresponding
attacks publicly disprovable rather than arbiter-adjudicated:

- **Fabrication.** Every seller signature a verdict rests on is anchored
  on-chain BEFORE anything is revealed, and the batch root is recomputed by
  the contract from the posted records. A verifier cannot invent an exchange
  (it has no seller signature for it), cannot swap probes after seeing
  answers (the commitment predates the anchor and its opening is
  contract-checked), and cannot attest against evidence it never published
  (attestations must reference an anchored root bound to the same
  commitment).
- **Wrong or dishonest verdicts.** Grading is deterministic over public
  inputs, so a verdict that does not follow from the anchored evidence and
  revealed probes is demonstrable by anyone via `antseed audit verify` —
  recomputation either matches the attestation or exhibits the discrepancy.
  Selective omission by a verifier (probing 20 times, anchoring the worst 10)
  is visible as a thin batch and is the kind of pattern corroboration
  (`minDistinctDiffVerifiers`) and whitelist governance exist to punish.
- **Colluding cohorts** feeding a verifier consistent wrong answers remain
  the reason a single DIFF is never enough: the standing-flag penalty
  requires multiple distinct verifiers, and stake slashing still requires the
  dispute path.

---

## Parameters

| Parameter | Symbol | Default | Notes |
|---|---|---|---|
| ResponseAuth wait grace | — | 30s | Implemented Buyer wait after response before logging missing auth |
| Verification sample rate | — | 0.005 | Implemented random full evidence sample rate for verified auths |
| Verification sample byte cap | — | 16 MiB | Implemented max encoded request + response bytes per sample |
| Sample rate | `p` | 0.02 | Fraction of real requests duplicated to reference (M2) |
| Min samples per verdict | `N` | 30 | Below this, no M2 verdict is emitted |
| Distributional fail threshold | — | tuned on real traffic | Drives *local* flagging only |
| Probe cadence (if M1 used) | — | 1 / 20 requests | M1 is deterrence/triage only |
| Probes per stealth request | `verifier.maxProbesPerRequest` | 3 | 1–3 facts folded into one organic-looking chat request; the stealth-vs-cost dial |
| KBF min coverage | — | 0.5 | Below this, verdict is `UNDETERMINED` |
| KBF CP confidence | — | 0.99 | Upper bound for reference self-error |
| KBF alpha | — | 0.05 | One-sided binomial threshold for `DIFF` |
| Delegate share of verification bucket | `delegateShareBps` | 20% | Split of each epoch's verification emissions between verifier and delegate pools; only carved out for epochs with delegate credits |
| Max connected delegates per host | — | 64 | Delegation roster cap; excess hellos rejected with `delegate_capacity` |
| Audit evidence retention | — | all probe exchanges | Response packs embed full request/response bytes and the signed `ResponseAuth` per probe |
| Probe source | `verifier.probeSource` | `"llm"` when `verifier.upstream` is configured | Fallback order `llm` → `compositional` → `bank` |
| Probe author model | `verifier.probeAuthorModel` | upstream default model | Optional override for the LLM that authors candidate probes |
| Target solicitation timeout | — | 10s | Wait for `TargetSuggestion` replies before assigning probe jobs |
| Anchor batch size | — | 1-256 records | `ExchangeRecord`s per `anchorExchangeBatch` call (one per signed stealth request); exactly one batch per probe commitment |
| Anchor probe count | `probeCount` (anchor param) | ≥ record count | Declared total probes bundled across the batch's records; caps every attestation's claimed `probeCount` |
| Reveal delay | `verifier.revealDelayMs` | 0 (reveal immediately after attestations) | Due-time holdback on the durable pending-reveal queue before `revealProbeSet` (drained at round boundaries, retried across restarts); end-of-epoch reveal batching is a planned future knob |
| Pack publish directory | `verifier.publishDir` | `<dataDir>/verifier/packs` | Response packs written as `<commitment>.json`; `evidenceHash` = canonical hash of the pack |

Thresholds that affect **local** routing may be liberal. Thresholds that gate
**on-chain** penalties MUST be conservative and are ultimately the arbiter's
decision in step 10, not a Buyer-side constant.

---

## Implementation Milestones

Completed milestones:

1. ResponseAuth substrate:
   - protocol type and codec;
   - `VerificationMux`;
   - capability-gated Seller sending;
   - Buyer verification;
   - `verification.db` response-auth storage;
   - random verified request/response evidence samples.

2. `@antseed/fingerprints` pure package:
   - KBF schemas, numeric parser, tolerance matcher, CP99 and binomial
     functions, verdict computation;
   - cohort consensus verdicts;
   - stealth probe engine and pluggable `ProbeSource` (compositional default);
   - RFC 8785 canonical JSON hashing and HKDF/HMAC_DRBG deterministic
     randomness;
   - probe-set generation and full-content commitments.

3. Verifier network runtime and contracts:
   - `AntseedVerifierRegistry` (whitelist, commit-reveal, attestations,
     stats, delegate-credit claiming) and `AntseedVerifierRewards`
     (verifier/delegate pool split);
   - `antseed verifier start|status|claim|reference build` daemon and CLI;
   - audit runner: cohort selection, on-chain commitment before probing,
     verified `ResponseAuth` required for attestation;
   - buyer-delegated probe execution (0x90–0x93; 0x94 retired/reserved) with
     anchor-time carrier crediting (seller-signed payloads name the carrier;
     on-chain accrual + `DelegateCreditsAccrued` event-based discovery replaced
     EIP-712 delegate vouchers).

4. Transparent audit pipeline (commit → carry → anchor → attest → reveal):
   - LLM probe authoring through `verifier.upstream`, certified by the
     existing reference machinery (`probeSource: "llm"`,
     `verifier.probeAuthorModel`);
   - delegate target solicitation (`TargetQuery = 0x95`,
     `TargetSuggestion = 0x96`) with organic-pair-preferring job assignment;
   - on-chain exchange-batch anchoring (`anchorExchangeBatch`,
     contract-recomputed Merkle root over `ExchangeRecord` calldata);
   - attestations bound to the anchored `batchRoot`;
   - post-attestation on-chain probe reveal (`revealProbeSet`,
     contract-checked sha256 opening) with `verifier.revealDelayMs`;
   - response packs published under `verifier.publishDir`;
   - `antseed audit verify` third-party recomputation.

5. Local routing integration:
   - per-(peer, model) verification stats and authenticity score on
     `PeerInfo.modelVerification` during discovery;
   - standing substitution flags excluded by `DefaultRouter` and refused by
     the CLI/Desktop pinned-peer dispatch path.

The next implementation SHOULD proceed in small PRs with clean package
boundaries:

1. Fingerprint swarm support:
   - define pack signing bytes;
   - validate publisher signatures;
   - announce pack metadata on fingerprint swarm topics;
   - fetch packs from peers and mirrors by content hash;
   - seed verified packs for other peers;
   - verify `packId`;
   - import trusted references into local storage;
   - expose pack trust/staleness metadata.

2. Buyer-local managed reference store in `@antseed/node`:
   - import public/generated references;
   - validate schema;
   - compute and verify `referenceId`;
   - write under `<dataDir>/fingerprints/references/<referenceId>.json`;
   - list references by `serviceAliases`.

3. Additional fingerprint families:
   - add behavioral-classifier, perturbation, rare-token, instruction-hierarchy,
     output-distribution, runtime, and passive proxy-reader verifier modules
     behind the day-one `FingerprintVerifier` interface;
   - keep each verifier module transport-agnostic;
   - reuse the same reference store, sample store, and audit-result schema.

4. Dispute/slashing prototype:
   - build an off-chain exhibit verifier for M2 real-traffic exhibits
     (verifier-network audits are already third-party recomputable via
     `antseed audit verify`; commit, anchor, and reveal are enforced
     on-chain);
   - define verifier committee signatures;
   - add compact slash signal support to `AntseedSlashing`.

Do not start with slashing. Slashing depends on mature evidence format,
commit-reveal, reproducible verifier code, and independent adjudication.

---

## Relationship to Other Layers

- **Reputation ([05](./05-reputation.md)):** a confirmed substitution is the kind
  of signal the future ERC-8004 `Accuracy` path could carry — but only after
  arbiter confirmation (step 10), never directly from an M1/M2 fail verdict.
- **Metering ([03](./03-metering.md)):** carries `responseAuth` (M3) and the
  retained request history used for abuse resistance. Audit requests are normal
  paid requests unless the Buyer and Seller later agree on a separate audit
  accounting policy.
- **Security ([06](./06-security-overview.md)):** model substitution is a
  trust-boundary violation between Buyer and Seller; this document is the
  cross-reference for that residual risk.
- **Transport ([02](./02-transport.md)):** fingerprint requests use ordinary
  request/response framing. No verifier-specific frame type is required for
  fingerprint audits.
- **Fingerprint Swarm ([08](./08-fingerprint-swarm.md)):** distributes public
  fingerprint packs by content hash. Model verification imports trusted packs
  from the swarm, then runs Buyer-local audits and stores signed evidence.

---

## Summary

| Mechanism | Cost | Detects | Drives penalties? |
|---|---|---|---|
| M1 Behavioral probes | very low | tier mismatch, lazy substitution | No (deterrence/triage) |
| M2 Reference shadow sampling | ~`p` of spend | family substitution, quantization | Local routing; on-chain only via M3 exhibit |
| M3 Signed responses | negligible | nothing alone — enables M2 evidence | Yes, as exhibit input |
| M4 Passive fingerprinting | free | gross outliers | No (triage) |
| M5 TEE attestation | premium | proves served endpoint/weights | Authoritative |
| F1 KBF | low to medium | knowledge-boundary mismatch | Local routing; slashing only after dispute |
| F2-F9 Fingerprint suite | variable | behavioral/runtime/provenance/model-family mismatch | Local routing and triage unless independently confirmed |

The implemented base is **M3 ResponseAuth + buyer-side verification storage +
random verified evidence samples**, plus the whitelisted verifier network:
**`@antseed/fingerprints` (KBF + cohort consensus + stealth engine), the
verifier registry/rewards contracts, the `antseed verifier` daemon running the
transparent commit → carry → anchor → attest → reveal pipeline (LLM-authored
certified probes, delegate-carried stealth probing with target solicitation,
on-chain exchange-batch anchoring, batchRoot-bound attestations, on-chain
probe reveal, published response packs), buyer-delegated probing with
on-chain anchor-time carrier crediting, `antseed audit verify` third-party
recomputation, and
substitution-flag enforcement in buyer routing**. The recommended next
implementation is the public fingerprint swarm (signed, content-addressed
reference/fingerprint packs) and additional verifier families behind the same
interfaces. M2 remains the stronger long-term distributional check for real
traffic. On-chain slashing comes last.
