# Current six-PR stack

The current review order is #1039 (1/6, generic quantity billing),
#1040 (2/6, signed reasoning-effort capabilities),
#1034 (3/6, routing protocol/discovery), #1035 (4/6, routing-critical paid execution),
#1036 (5/6, buyer integration), then the independent generic payment follow-up (6/6).
The tables below audit the original three-slice extraction: their PR 1/2/3 labels
refer to the historical protocol/execution/buyer slices, now PR 3/4/5. Quantity
billing and its adapters, codecs, config migration, catalog prices, and regression
tests have since been extracted into #1039. Reasoning-effort types, validation,
provider configuration, signed encoding, and catalog propagation now belong to
PR 2/6; routing recommendations and execution remain in PRs 3/6 and 5/6.
Retained-channel reconnect, its local-chain fixture, SQLite schema regressions,
and seller billing type cleanup move out of #1035 into the final follow-up.
No original feature is dropped. The validation figures below are historical,
not fresh results for this restack; see the PR descriptions for current checks.

# Complete routing-stack coverage audit

Audited September 20, 2026 against PR #1014 at `55109639c92302b17d9cec8272e23e690d2a9103`.
Original merge base: `f2ee484a939f4ab9398f548cf6a2e3ee0457f223`.
Stack main base: `b6ed0ac4198e19e33409b11201f7954df1830e9a`.

## Result

All **118 original changed paths** are accounted for. The three PRs include the
original production functionality, tests, configuration, dependency changes, and
documentation, subject to the two explicit equivalents/exclusions below. This is
a source-delta audit, not a claim that new split commit SHAs or all bytes match.

- **79 files** are byte-identical to the source head.
- **11 files** exactly match a clean three-way application of the source delta to the stack's main base.
- **26 files** contain reviewed compatibility, extraction, documentation, or regression-test adaptations detailed below.
- **2 files** have no direct delta: an unreachable desktop check is already covered by catalog exclusion; one obsolete SQLite test file is intentionally excluded.

## Behavioral coverage

| Responsibility | Implementation and verification |
| --- | --- |
| Protocol/discovery — PR 1 (#1034) | Structured request/response and schema validation; ranked eligibility; signed v13 metadata; per-call representation; catalog propagation and filtering; reference provider and protocol tests. |
| Payments/execution — PR 2 (#1035) | Shared billing helpers; request IDs and attribution; response acceptance; cancellation; serialized same-seller authorization; recovery and released-schema tests. |
| Buyer integration — PR 3 | CLI/config selection and inspection; plugin settings; network adapter; seller schema dispatch; policy validation; ranked fallback; observation history; reasoning overrides; continuation reuse; proxy and local-chain tests. |

The audit compares each original file's final contents with the completed stack,
then compares nonidentical files to the original delta merged onto the newer main
base. Every remaining difference has a recorded explanation. New split-only tests
and docs are additional coverage, not replacements for unexamined source files.

### Explicit exceptions

1. The source's `channel-store.reserve-fields.test.ts` has three obsolete tests
   for columns whose migration and persistence were removed by source commit
   `6d01ade8a3a6f28d0cd6fd996d075cd6bf31e576`. It is excluded, not silently
   claimed as passing. Released SQLite v5 records/signatures and legacy extra-column
   readability remain tested; browser reserve-replay persistence remains supported.
2. The source desktop streaming check for a routing catalog entry is redundant
   after PR 1 filters such entries and narrows the catalog type. Copying it produces
   an impossible-comparison type error. Routing still does not appear in text-chat
   choices. No temporary standalone guard is added.

Current-main trust scoring, decision models, verifier metadata, TEE shutdown, and
reserve top-up thresholds are retained rather than reverted to older source code.
The original branch remains unchanged. Dawe000 and alexanderludwig source authorship,
Claude co-author credit, and source-commit references are preserved; Shahaf Antwarg's
earlier conversation work remains in the inherited main history.

## Completed-stack validation

- Full workspace build and typecheck pass.
- SDK: 1,357 tests; CLI: 735; protocol: 52; API adapter: 130; buyer core: 25;
  provider core: 82; router core: 59; web SDK non-native suites: 22.
- Local-chain per-call routing with concurrent same-seller traffic and ranked
  fallback settles 42,860 micro-USDC; token-priced same-seller ranked fallback
  settles 2,520 micro-USDC; the invalid per-call response scenario settles only
  the five accepted routing calls (25,000 micro-USDC).
- The browser-native relay integration aborts in node-datachannel with
  `Cannot send message on destroyed socket`. The same crash reproduces on the
  unchanged PR 2 worktree at `90c826bd0`; it is not counted as passing or hidden
  by the source-coverage audit. No unrelated native networking change is included.

## File-by-file reconciliation

| Original source path | Result |
| --- | --- |
| `CHANGELOG.md` | User-facing entries are grouped by the three implemented slices; newer main entries remain. |
| `apps/cli/package.json` | Source delta applied unchanged; newer main preserved. |
| `apps/cli/src/cli/commands/buyer/index.ts` | Identical to source. |
| `apps/cli/src/cli/commands/buyer/router.test.ts` | Identical to source. |
| `apps/cli/src/cli/commands/buyer/router.ts` | Identical to source. |
| `apps/cli/src/cli/commands/buyer/start.ts` | Source delta applied unchanged; newer main preserved. |
| `apps/cli/src/cli/commands/config/index.test.ts` | Identical to source. |
| `apps/cli/src/cli/commands/config/index.ts` | Identical to source. |
| `apps/cli/src/config/loader.test.ts` | Identical to source. |
| `apps/cli/src/config/loader.ts` | Identical to source. |
| `apps/cli/src/config/types.ts` | Identical to source. |
| `apps/cli/src/config/validation.ts` | Identical to source. |
| `apps/cli/src/plugins/loader.test.ts` | Identical to source. |
| `apps/cli/src/plugins/loader.ts` | Identical to source. |
| `apps/cli/src/plugins/registry.test.ts` | Identical to source. |
| `apps/cli/src/plugins/registry.ts` | Source delta applied unchanged; newer main preserved. |
| `apps/cli/src/proxy/buyer-proxy.test.ts` | Retains main trust/decision-service tests and all extracted routing tests; awaits pending state writes before fallback-test cleanup. |
| `apps/cli/src/proxy/buyer-proxy.ts` | Combines routing with main trust helpers, decision-service errors, and TEE shutdown; hoists the discovery snapshot across selection branches. |
| `apps/cli/src/proxy/conversation-identity.ts` | Identical to source. |
| `apps/cli/src/proxy/conversation-store.test.ts` | Identical to source. |
| `apps/cli/src/proxy/conversation-store.ts` | Identical to source. |
| `apps/cli/src/proxy/network-models.ts` | Combines routing discovery/filtering with main decision-service listings. |
| `apps/cli/src/proxy/request-utils.ts` | Identical to source. |
| `apps/cli/src/proxy/router-execution.test.ts` | Identical to source. |
| `apps/cli/src/proxy/router-execution.ts` | Identical to source. |
| `apps/cli/src/proxy/router-policy.test.ts` | Identical to source. |
| `apps/cli/src/proxy/router-policy.ts` | Uses the current shared normalized trust helper instead of the obsolete CLI-local helper. |
| `apps/cli/src/proxy/routing-service.test.ts` | Identical to source. |
| `apps/cli/src/proxy/routing-service.ts` | Uses the same current shared trust helper; preserves source validation/invocation behavior. |
| `apps/cli/src/proxy/routing-usage.test.ts` | Identical to source. |
| `apps/cli/src/proxy/routing-usage.ts` | Identical to source. |
| `apps/desktop/src/main/chat/service-catalog.ts` | Combines routing exclusion with current decision-service and verifier behavior. |
| `apps/desktop/src/main/chat/streaming-run.ts` | Equivalent prevention is already in PR 1: the catalog filters routing offers and its type excludes antseed-routing. The extra source comparison is unreachable and fails typecheck; it is not copied. |
| `docs/protocol/templates/routing-provider/README.md` | Adds split-specific contract and compatibility-checker documentation. |
| Routing provider conformance fixtures | Originally checked by a standalone script; the script is removed and the fixtures now run in the router-core test suite. |
| `docs/protocol/templates/routing-provider/fixtures/invalid-response.json` | Identical to source. |
| `docs/protocol/templates/routing-provider/fixtures/metadata.json` | Identical to source. |
| `docs/protocol/templates/routing-provider/fixtures/request.json` | Identical to source. |
| `docs/protocol/templates/routing-provider/fixtures/response.json` | Identical to source. |
| `docs/protocol/templates/routing-provider/src/index.ts` | Identical to source. |
| `docs/router-network-integration.md` | Preserves behavior documentation; clarifies that the retired classifier belongs to earlier development drafts, not a released main feature. |
| `docs/router-per-call-billing.md` | Documents shared execution separately from router policy, then restores complete integration semantics and the original local-chain scenario matrix. |
| `e2e/package.json` | Identical to source. |
| `e2e/scripts/local-chain-routing-flow.mjs` | Retains all source scenarios; corrects the expected fallback candidate to include the protocol-supported reasoning efforts produced by the source policy. |
| `packages/api-adapter/package.json` | Source delta applied unchanged; newer main preserved. |
| `packages/api-adapter/src/detect.ts` | Source delta applied unchanged; newer main preserved. |
| `packages/api-adapter/src/index.ts` | Identical to source. |
| `packages/api-adapter/src/reasoning.test.ts` | Identical to source. |
| `packages/api-adapter/src/reasoning.ts` | Identical to source. |
| `packages/api-adapter/src/request-transform.ts` | Identical to source. |
| `packages/api-adapter/src/routing.test.ts` | Same source detection/cached-usage assertions, reordered by extraction. |
| `packages/api-adapter/src/types.ts` | Includes both antseed-routing and main typesafe-systemone. |
| `packages/api-adapter/src/utils.ts` | Identical to source. |
| `packages/buyer-core/src/buyer-payment-manager.ts` | Retains all extracted request accounting and concurrency while preserving current-main remaining-headroom top-up policy; avoids a source-only cosmetic rewrite. |
| `packages/buyer-core/src/buyer-payment-negotiator.ts` | Identical to source. |
| `packages/buyer-core/src/buyer-request-handler.ts` | Identical to source. |
| `packages/buyer-core/src/unit-billing.test.ts` | Identical to source. |
| `packages/buyer-core/src/unit-billing.ts` | Identical to source. |
| `packages/node/src/discovery/announcer.ts` | Identical to source. |
| `packages/node/src/discovery/index.ts` | Source delta applied unchanged; newer main preserved. |
| `packages/node/src/discovery/metadata-codec.ts` | Identical to source. |
| `packages/node/src/discovery/metadata-validator.ts` | Fixes a source inconsistency: exact per-call pricing under antseed-routing is accepted alongside the signed v13 descriptor. |
| `packages/node/src/discovery/service-catalog.ts` | Combines routing/billing descriptors with existing decision types and advertised verifier IDs. |
| `packages/node/src/health/model-health-checker.ts` | Excludes routing from paid probes while retaining current-main probe behavior. |
| `packages/node/src/index.ts` | Exports the complete routing API once; preserves split protocol exports and current-main exports. |
| `packages/node/src/interfaces/buyer-router.ts` | Retains all contract fields and selectRoute behavior without duplicating PR 1/2 types or comments. |
| `packages/node/src/interfaces/plugin.ts` | Identical to source. |
| `packages/node/src/interfaces/seller-provider.ts` | Identical to source. |
| `packages/node/src/node.ts` | Source delta applied unchanged; newer main preserved. |
| `packages/node/src/payments/channel-store.reserve-fields.test.ts` | Excluded: three assertions require SQLite columns removed by source commit 6d01ade8a3a6f28d0cd6fd996d075cd6bf31e576. No matching persistence implementation exists at the pinned source head. |
| `packages/node/src/routing/conversation-identity.ts` | Identical to source. |
| `packages/node/src/routing/model-route-ranking.ts` | Source delta applied unchanged; newer main preserved. |
| `packages/node/src/routing/route-recommendation.ts` | Identical to source. |
| `packages/node/src/routing/router-settings.ts` | Identical to source. |
| `packages/node/src/routing/routing-context.ts` | Identical to source. |
| `packages/node/src/routing/selection.ts` | Identical to source. |
| `packages/node/src/routing/usage-observations.ts` | Identical to source. |
| `packages/node/src/seller-request-handler.ts` | Identical to source. |
| `packages/node/src/types/peer.ts` | Source delta applied unchanged; newer main preserved. |
| `packages/node/tests/announcer.test.ts` | Identical to source. |
| `packages/node/tests/billing-runtime.test.ts` | Identical to source. |
| `packages/node/tests/buyer-parallel-requests.test.ts` | Identical to source. |
| `packages/node/tests/buyer-payment-manager.test.ts` | Source delta applied unchanged; newer main preserved. |
| `packages/node/tests/buyer-payment-negotiator.test.ts` | Identical to source. |
| `packages/node/tests/channel-store.test.ts` | Identical to source. |
| `packages/node/tests/metadata-codec.test.ts` | Identical to source. |
| `packages/node/tests/metadata-validator.test.ts` | Updates the expected validation diagnostic for per-call antseed-routing support. |
| `packages/node/tests/node-payment-mux-wiring.test.ts` | Identical to source. |
| `packages/node/tests/payment-flow-integration.test.ts` | Identical to source. |
| `packages/node/tests/per-call-billing.test.ts` | Identical to source. |
| `packages/node/tests/proof-chain-integration.test.ts` | Identical to source. |
| `packages/node/tests/released-channel-migration.test.ts` | Identical to source. |
| `packages/node/tests/released-discovery-baseline.test.ts` | Identical to source. |
| `packages/node/tests/route-recommendation.test.ts` | Identical to source. |
| `packages/node/tests/router-settings.test.ts` | Identical to source. |
| `packages/node/tests/routing-classification-validation.test.ts` | Identical to source. |
| `packages/node/tests/routing-context.test.ts` | Identical to source. |
| `packages/node/tests/routing-metadata.test.ts` | Adds a combined signed-v13 fixture containing descriptor, reasoning efforts, and per-call price. |
| `packages/node/tests/routing-payment-recovery.test.ts` | Adds two contract-to-payment acceptance cases without dropping source recovery tests. |
| `packages/node/tests/routing-selection.test.ts` | Identical to source. |
| `packages/node/tests/seller-reserve-estimate.test.ts` | Identical to source. |
| `packages/node/tests/service-catalog.test.ts` | Identical to source. |
| `packages/node/tests/usage-observations.test.ts` | Identical to source. |
| `packages/protocol/src/billing.ts` | Identical to source. |
| `packages/protocol/src/index.ts` | Identical to source. |
| `packages/protocol/src/peer-metadata.test.ts` | Identical to source. |
| `packages/protocol/src/peer-metadata.ts` | Identical to source. |
| `packages/protocol/src/routing.test.ts` | Identical to source. |
| `packages/protocol/src/routing.ts` | Identical to source. |
| `packages/protocol/src/service-api.ts` | Includes both antseed-routing and current-main typesafe-systemone. |
| `packages/provider-core/src/base-provider.ts` | Identical to source. |
| `packages/provider-core/src/config-utils.test.ts` | Identical to source. |
| `packages/provider-core/src/config-utils.ts` | Identical to source. |
| `packages/router-core/src/index.ts` | Exports the parser from PR 1 and adapter from PR 3 without duplicate exports. |
| `packages/router-core/src/network-router.test.ts` | Runs source tests against PR 1 parser and PR 3 adapter rather than a duplicated parser. |
| `packages/router-core/src/network-router.ts` | Invokes PR 1 parser instead of defining a second copy; network selection and reuse remain intact. |
| `packages/web-sdk/src/channel-store.test.ts` | Identical to source. |
| `pnpm-lock.yaml` | Source delta applied unchanged; newer main preserved. |
