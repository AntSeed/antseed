# Transparent Audits v2 — Design Brief (coordination doc, delete before merge)

Supersedes the PR #720 audit pipeline's trust model. Same foundation (KBF math,
cohort consensus, ResponseAuth, delegation transport, rewards); new audit flow:

> **commit → carry → anchor → attest → reveal.**
> Every audit is sealed on-chain before it runs, every seller answer is
> signature-anchored on-chain before anything is revealed, and the probes are
> published afterward — so ANYONE can re-run the entire audit from public data
> and reach the same verdict. No ZK. Trust = whitelist + total recomputability.

One-sentence pitch: "Don't trust the verdict? Re-run it yourself."

## Why (context for all agents)

The #720 design kept probes secret forever; verdicts were trust-me claims by
whitelisted verifiers. v2 trades secrecy-after-use for legibility: probes are
LLM-generated fresh per audit (cheap, unbounded supply, no fixed generator
fingerprint to classify), so revealing them after the audit costs little and
buys full public auditability. Carriers (delegate buyers) remain the stealth
mechanism IN-FLIGHT; reveal happens only after evidence is anchored.

## The flow (normative)

1. **Generate** — an upstream frontier LLM authors ~2x candidate probes for the
   target service ("write N numeric-answer factual questions model X answers
   stably; no time-varying facts; JSON schema below"). Candidates are certified
   by the EXISTING reference machinery: run against the trusted upstream
   reference model across temperatures, keep stable ones, measure self-error on
   a holdout. Fallback when no upstream: existing compositional/bank sources.
2. **Seal** — `commitProbeSet(sha256(canonicalProbeSetJson))` on-chain
   (UNCHANGED, already exists). Commitment = `computeProbeCommitment` =
   sha256 over canonical JSON of `{service, probes, nonce}`.
3. **Carry** — verifier asks each connected delegate which sellers of the
   target service the delegate ALREADY uses (new message pair below); assigns
   probe jobs preferring organic (delegate-suggested) pairs; falls back to
   assignment for uncovered sellers. Dispatch/relay/ResponseAuth re-verification
   is UNCHANGED (verbatim-relay invariant stays).
4. **Anchor** — verifier posts the full exchange batch on-chain as calldata:
   per exchange `(agentId, requestHash, responseHash, responseAuthSig)`.
   Contract recomputes the Merkle root from calldata (so root ↔ data binding is
   on-chain-verified), stores root keyed to the probe commitment.
5. **Attest** — `submitAttestation(..., batchRoot)` per seller: verdict must
   reference an anchored batch bound to the referenced probe commitment.
6. **Reveal** — verifier posts the exact canonical probe-set JSON bytes
   on-chain; contract checks `sha256(bytes) == commitment` (on-chain-verified
   opening). Full response pack (request/response plaintexts + ResponseAuths)
   is written to `verifier.publishDir` (off-chain; response bodies are too big
   for calldata; their HASHES are already anchored). evidenceHash (unchanged
   param) = canonical hash of that pack.

Order enforced on-chain: commit strictly before anchor; anchor strictly before
(or same tx as) attest; reveal only after at least one attestation references
the commitment's batch (prevents revealing then probing).

## Contract changes — packages/contracts/verification/AntseedVerifierRegistry.sol

Owner: **Agent A**. Keep everything that exists; ADD:

```solidity
struct ExchangeRecord {          // abi.encode'd array in calldata
    uint256 agentId;
    bytes32 requestHash;
    bytes32 responseHash;
    bytes   responseAuthSig;     // 65-byte ECDSA over the ResponseAuth payload
}

event ExchangeBatchAnchored(
    address indexed verifier, bytes32 indexed probeCommitment,
    bytes32 indexed batchRoot, uint32 exchangeCount);
event ProbeSetRevealed(
    address indexed verifier, bytes32 indexed probeCommitment);

error BatchNotAnchored();
error BatchAlreadyAnchored();
error BatchCommitmentMismatch();
error EmptyBatch();
error RevealMismatch();
error RevealBeforeAttest();
error AlreadyRevealed();

/// Recompute the Merkle root on-chain from calldata records; leaf =
/// keccak256(abi.encode(agentId, requestHash, responseHash, keccak256(sig))).
/// Pairwise keccak, odd node promoted. Store:
///   batchAnchoredAt[verifier][batchRoot] = block.timestamp
///   batchCommitment[verifier][batchRoot] = probeCommitment
/// Require probeCommittedAt[msg.sender][probeCommitment] != 0 and strictly
/// earlier than block.timestamp. Require records.length in [1, 256], one batch
/// per commitment, unique non-zero request hashes, and 1..3 probes per record.
function anchorExchangeBatch(bytes32 probeCommitment, ExchangeRecord[] calldata records)
    external onlyApprovedVerifier returns (bytes32 batchRoot);

/// submitAttestation gains a batchRoot param (BREAKING, pre-release fine):
/// require batchAnchoredAt[msg.sender][batchRoot] != 0 and
/// batchCommitment[msg.sender][batchRoot] == probeCommitment.
/// Track attestationCountByCommitment[verifier][probeCommitment]++.
function submitAttestation(
    uint256 agentId, bytes32 serviceHash, uint8 verdict, bytes32 evidenceHash,
    bytes32 probeCommitment, bytes32 batchRoot, uint32 probeCount, uint32 cohortSize
) external onlyApprovedVerifier;

/// On-chain-verified opening. probeSetJson = exact canonical JSON bytes of
/// {service, probes, nonce}. Require sha256(probeSetJson) == probeCommitment
/// (NOTE: computeProbeCommitment prefixes — Agent A: mirror the EXACT byte
/// derivation of packages/fingerprints/src/types.ts computeProbeCommitment;
/// if it hashes the utf8 canonical string directly, sha256(bytes) works; if
/// there is a domain prefix, replicate it). Require at least one attestation
/// referenced this commitment (RevealBeforeAttest otherwise). Mark revealed;
/// no re-reveal. Data lives in calldata; event carries no bytes.
function revealProbeSet(bytes32 probeCommitment, bytes calldata probeSetJson)
    external onlyApprovedVerifier;

// Views: batchAnchoredAt, batchCommitment, probeRevealedAt(verifier, commitment).
```

Forge tests (extend existing test files, new file for anchor/reveal):
happy path commit→anchor→attest→reveal; every revert path; root determinism
vs a TS-mirrored fixture; gas snapshot for a 1000-record batch (expect a few
million gas — assert it stays under 8M); attest with foreign/unanchored root
fails; reveal with wrong bytes fails; reveal before attest fails; double
anchor of identical batch fails.

## Node changes — packages/node

Owner: **Agent C**. Files: `src/payments/evm/verifier-client.ts`,
`src/verification/exchange-batch.ts` (NEW), `src/verification/delegation-codec.ts`,
`src/types/protocol.ts`, tests alongside.

1. `exchange-batch.ts`: TS mirror of the contract's leaf/root:
   `computeExchangeLeaf(record)`, `computeBatchRoot(records)` (keccak256 via
   ethers, pairwise, odd promoted — MUST match Agent A's Solidity exactly; a
   shared fixture of 1, 2, 3, 5, 1000 records with pinned roots goes in both
   test suites — Agent C generates and Agent A copies the pinned values).
2. `verifier-client.ts`: add `anchorExchangeBatch(signer, {probeCommitment,
   records})`, `revealProbeSet(signer, {probeCommitment, probeSetJson})`,
   update `submitAttestation` ABI string with `bytes32 batchRoot` (keep arg
   object shape, add `batchRoot`). Add views.
3. Delegation protocol additions in `types/protocol.ts`:
   `TargetQuery = 0x95`, `TargetSuggestion = 0x96`.
   Codec payloads (JSON like the existing 0x90–0x94 messages):
   - TargetQuery: `{ queryId: string, service: string }`
   - TargetSuggestion: `{ queryId: string, service: string, sellers: Array<{peerId: string, agentId: number}> }`
   Wire into delegation-mux with send methods + dispatch cases + handler
   hooks, mirroring the existing message pattern.

## CLI changes — apps/cli

Owner: **Agent D**. Files: `src/verifier/*` (rework `audit-runner.ts`,
new `probe-author.ts`, new `pack-writer.ts`, extend `delegated-probing.ts`),
`src/cli/commands/` (new `audit-verify` command), config types, tests.

1. `probe-author.ts` (NEW): LLM probe generation through the EXISTING
   `verifier.upstream` OpenAI-compatible client (same plumbing
   reference-builder.ts uses). Prompt: request `2*count` candidates as strict
   JSON array `[{name, domain, template ("... ___ ..."), consensus, range:
   [lo,hi], tolerance:{mode,value}}]`; validate every candidate (template has
   `___`, finite numbers, lo<consensus<hi, sane tolerance, no banned
   time-sensitive words list); dedupe against the rotation log; then feed
   candidates into the EXISTING certification path (consistency across
   temperatures + holdout self-error, reference-builder machinery) and keep
   `count` certified probes. Config: `verifier.probeSource` gains
   `"llm"` (default when upstream configured); `verifier.probeAuthorModel`
   (optional model override). Fallback order: llm → compositional → bank.
2. Target solicitation in `delegated-probing.ts`: before assigning jobs,
   send TargetQuery to each connected delegate; collect TargetSuggestion
   (timeout 10s); prefer assigning a seller's probes to a delegate that
   suggested it; any seller not suggested by anyone falls back to current
   assignment logic. Delegate side (worker): answer TargetQuery from the
   buyer's local routing/connection history for that service (whatever
   peer-store API exists — suggest sellers the buyer has previously routed
   to; empty list is fine).
3. `audit-runner.ts` v2 pipeline: generate(llm) → commit (existing) →
   solicit+dispatch (existing+2) → collect+verify ResponseAuths (existing) →
   **anchorExchangeBatch** (all sellers' exchanges, one batch per audit
   round) → grade (existing cohort/KBF math, unchanged) →
   submitAttestation(+batchRoot) → **revealProbeSet** → `pack-writer.ts`
   writes `{probeSetJson, exchanges: [{agentId, request, response,
   responseAuth}...], cohort, verdicts}` to `verifier.publishDir`
   (default `<dataDir>/verifier/packs/<commitment>.json`); evidenceHash =
   canonicalHash of the pack (keep the existing evidence-bundle schema from
   @antseed/fingerprints as the pack schema — it already holds exchanges).
4. `antseed audit verify <txHashOrCommitment>` (NEW command): given an RPC
   URL + a verifier address + commitment (or the anchor tx hash), fetch the
   anchor calldata + revealed probe JSON from chain, recompute batch root,
   check commitment opening, verify each ResponseAuth sig against the pack's
   plaintexts if a pack file/URL is provided (`--pack <path|url>`), re-extract
   answers with the fingerprints parser, re-grade, print per-seller verdicts
   and whether they MATCH the on-chain attestations. Exit non-zero on any
   mismatch. This command is the product: the "re-run it yourself" button.
5. Config additions (`verifier` section): `probeAuthorModel?`,
   `publishDir?`, `revealDelayMs?` (default 0 = reveal immediately after
   attestations; document that end-of-epoch batching is a future knob).

## Fingerprints changes — packages/fingerprints

Owner: **Agent B** (small). `src/probe-author-schema.ts` (NEW): zod-free
manual validation helpers `validateCandidateProbe(raw): KbfProbe | error` used
by the CLI author module (pure math package stays dependency-free; no LLM
calls here). Also export a `BANNED_VOLATILE_PATTERNS` list (population,
price, current, latest, today, this year, record, version). Unit tests.
DO NOT touch existing probe-bank/cohort/stats/scoring.

## Docs — Owner: **Agent E**

1. `docs/protocol/spec/07-model-verification.md`: rewrite the audit-flow
   sections for commit→carry→anchor→attest→reveal; replace secrecy-forever
   language: probes are secret ONLY until reveal; in-flight stealth via
   carriers unchanged; add "Recompute an audit" section describing
   `antseed audit verify`; add reveal-timing + carrier-rotation trade-off
   note; add the on-chain data-cost table (1000 exchanges ≈ 150–200 KB
   calldata ≈ cents on Base). Remove any claim that evidence availability
   depends on the verifier staying online.
2. `CHANGELOG.md` Unreleased: rewrite the verifier-network entries to
   describe v2 (they were never released; edit in place rather than append).

## Conventions (all agents)

- TS strict, ES modules, vitest (`packages/*`), `node --test` does NOT apply
  here (that's CLI's runner — apps/cli tests use `node --test`? CHECK the
  existing verifier tests' runner and match it).
- Never modify existing SQLite migrations. No new migrations expected.
- Contracts: OZ patterns already in the file; solc 0.8.24, via_ir.
- Pinned-hash tests (evidence hash in fingerprints tests) may break if the
  pack schema changes — re-pin deliberately with a dated comment.
- Do not commit. Leave everything in the working tree.
- Keep diffs minimal outside your ownership; if you must touch a shared file
  (types, config), note it in your final report.
