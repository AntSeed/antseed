# Routing stack provenance and extraction ledger

Source: [AntSeed/antseed#1014](https://github.com/AntSeed/antseed/pull/1014),
`codex/router-network-integration` at
`55109639c92302b17d9cec8272e23e690d2a9103`.
The original PR and source branch remain unchanged.

PR 1 starts from `main` at `b6ed0ac4198e19e33409b11201f7954df1830e9a`.
The source PR's merge base is `f2ee484a939f4ab9398f548cf6a2e3ee0457f223`.
Changes were extracted as patches, not by replacing current-main files with older
source snapshots. Existing decision-service and verifier behavior is retained.

## Attribution

- `ac5037074` extracts the candidate contract from `88e003017798da58309ffb4133f13818e7839d2e`,
  retaining author `Dawe000 <dawid.pisarczyk@gmail.com>`, the original author date,
  and `Claude Sonnet 5 <noreply@anthropic.com>` co-author credit.
- `9a4d168a4` extracts the protocol/discovery implementation, retaining
  `alexanderludwig <alexanderludwig@users.noreply.github.com>` as author and
  Dawe000/Claude co-author credit for incorporated work. Its `Source-commit`
  trailers identify the original protocol, billing-representation, metadata,
  structured-routing, ranking, and reasoning commits.
- Subsequent split-specific compatibility tests, documentation, and catalog type
  adjustments are separate commits, not attributed to an original contributor
  who did not implement those changes.
- The combined v14 conformance test exposed a source inconsistency: metadata
  accepted per-call chat pricing but rejected the same representation for
  `antseed-routing`. A separate fix aligns discovery with the structured protocol.
  Execution-side usage-count and charge-tolerance checks remain in PR 2.

Preserve these authors/trailers when landing; prefer merge commits over squashing.
The new split commits have new SHAs. Exact original SHAs remain reachable through
#1014's source branch; retain a durable remote archive ref before deleting that
branch or retiring the final source reference. Do not merge the original unsplit PR.

## Deployment boundary

Per the follow-up instruction on September 19, 2026, PR 1 is not intended to run
alone. It contains **no temporary per-call execution guards** and no associated
intermediate-state guard tests. The three slices are separate reviews, not an
assertion that this intermediate protocol state is ready for standalone deployment.
This supersedes the guard requirement in the initial split plan. Payment execution
belongs to PR 2 and buyer activation to PR 3; all signed v14 fields land in PR 1.

## PR 2 extraction

PR 2, `codex/routing-payments-execution`, starts from PR #1034's branch
`codex/routing-protocol-discovery` at
`83f8ea95f88dd55c2311b8e76ee116bdb0af50ae`, not a fresh main checkout. This keeps
the second review limited to shared payments and request execution.

- `52c032be3` extracts the request-attributed router result contract from
  `88e003017798da58309ffb4133f13818e7839d2e`, preserving Dawe000's author identity
  and date and Claude Sonnet 5's co-author trailer.
- `21578d974` extracts the payment implementation and tests, preserving
  alexanderludwig's author identity and source author date, applicable Dawe000 and
  Claude co-author trailers, and fifteen `Source-commit` trailers. Those trailers
  identify the incorporated billing, concurrency, acceptance, and recovery work.
- Split-specific contract-to-payment tests and documentation are separate changes
  attributed to their implementer rather than an original contributor.
- Browser integration assertions wait for the required cumulative authorization
  instead of assuming it is the first frame: post-response and NeedAuth paths can
  emit additional authorizations. The test also checks monotonic amounts.
- Current main's remaining-headroom top-up policy is retained: 35% of the initial
  reserve for the first top-up, then $0.50. The older source policy is not restored.
- Only billing-related seller-handler changes and reserve-estimation tests are
  included. Five structured routing dispatch/schema tests from
  `seller-reserve-estimate.test.ts` remain for PR 3 alongside that implementation.
- `channel-store.reserve-fields.test.ts` is deliberately excluded. Its three
  tests require recovery columns removed by source commit
  `6d01ade8a3a6f28d0cd6fd996d075cd6bf31e576`; the pinned source accidentally retains
  those obsolete assertions. PR 2 does not resurrect that migration. Tests retain
  coverage of the released v5 schema, existing records/signatures, and readability
  of development databases containing extra columns. In-memory recovery and
  persisted cumulative authorizations are not an exactly-once restart guarantee.

PR 2 changes no signed metadata bytes and introduces no v15 or temporary guards.
CLI/config activation, routing-schema dispatch, network selection, policy checks,
ranked fallback, observation collection, reasoning overrides, and continuation
reuse remain in PR 3. The original PR and PR 1 branches remain untouched.

## Complete source-file allocation

This ledger covers all 118 files in the pinned source PR. Mixed files must be
split by the described responsibility, not copied wholesale into later PRs.
PR 1 also adds split-specific docs/tests not present in the source; inspect its diff
for those. The pure parser and its tests are renamed to `routing-response`.

| Original source path | PR allocation |
| --- | --- |
| `CHANGELOG.md` | 1 / 2 / 3 — entries follow their slice |
| `apps/cli/package.json` | 3 |
| `apps/cli/src/cli/commands/buyer/index.ts` | 3 |
| `apps/cli/src/cli/commands/buyer/router.test.ts` | 3 |
| `apps/cli/src/cli/commands/buyer/router.ts` | 3 |
| `apps/cli/src/cli/commands/buyer/start.ts` | 3 |
| `apps/cli/src/cli/commands/config/index.test.ts` | 3 |
| `apps/cli/src/cli/commands/config/index.ts` | 3 |
| `apps/cli/src/config/loader.test.ts` | 3 |
| `apps/cli/src/config/loader.ts` | 3 |
| `apps/cli/src/config/types.ts` | 3 |
| `apps/cli/src/config/validation.ts` | 3 |
| `apps/cli/src/plugins/loader.test.ts` | 3 |
| `apps/cli/src/plugins/loader.ts` | 3 |
| `apps/cli/src/plugins/registry.test.ts` | 3 |
| `apps/cli/src/plugins/registry.ts` | 3 |
| `apps/cli/src/proxy/buyer-proxy.test.ts` | 3 |
| `apps/cli/src/proxy/buyer-proxy.ts` | 3 |
| `apps/cli/src/proxy/conversation-identity.ts` | 3 |
| `apps/cli/src/proxy/conversation-store.test.ts` | 3 |
| `apps/cli/src/proxy/conversation-store.ts` | 3 |
| `apps/cli/src/proxy/network-models.ts` | 1 |
| `apps/cli/src/proxy/request-utils.ts` | 3 |
| `apps/cli/src/proxy/router-execution.test.ts` | 3 |
| `apps/cli/src/proxy/router-execution.ts` | 3 |
| `apps/cli/src/proxy/router-policy.test.ts` | 3 |
| `apps/cli/src/proxy/router-policy.ts` | 3 |
| `apps/cli/src/proxy/routing-service.test.ts` | 3 |
| `apps/cli/src/proxy/routing-service.ts` | 3 |
| `apps/cli/src/proxy/routing-usage.test.ts` | 3 |
| `apps/cli/src/proxy/routing-usage.ts` | 3 |
| `apps/desktop/src/main/chat/service-catalog.ts` | 1 |
| `apps/desktop/src/main/chat/streaming-run.ts` | 3 |
| `docs/protocol/templates/routing-provider/README.md` | 1 |
| `docs/protocol/templates/routing-provider/check-compatibility.mjs` | 1 |
| `docs/protocol/templates/routing-provider/fixtures/invalid-response.json` | 1 |
| `docs/protocol/templates/routing-provider/fixtures/metadata.json` | 1 |
| `docs/protocol/templates/routing-provider/fixtures/request.json` | 1 |
| `docs/protocol/templates/routing-provider/fixtures/response.json` | 1 |
| `docs/protocol/templates/routing-provider/src/index.ts` | 1 |
| `docs/router-network-integration.md` | 1 / 3 — contract documented separately / buyer behavior deferred |
| `docs/router-per-call-billing.md` | 2 |
| `e2e/package.json` | 3 |
| `e2e/scripts/local-chain-routing-flow.mjs` | 3 |
| `packages/api-adapter/package.json` | 3 |
| `packages/api-adapter/src/detect.ts` | 1 |
| `packages/api-adapter/src/index.ts` | 3 |
| `packages/api-adapter/src/reasoning.test.ts` | 3 |
| `packages/api-adapter/src/reasoning.ts` | 3 |
| `packages/api-adapter/src/request-transform.ts` | 3 |
| `packages/api-adapter/src/routing.test.ts` | 1 / 2 — detection / cached-usage extraction |
| `packages/api-adapter/src/types.ts` | 1 |
| `packages/api-adapter/src/utils.ts` | 2 |
| `packages/buyer-core/src/buyer-payment-manager.ts` | 2 |
| `packages/buyer-core/src/buyer-payment-negotiator.ts` | 2 |
| `packages/buyer-core/src/buyer-request-handler.ts` | 2 |
| `packages/buyer-core/src/unit-billing.test.ts` | 2 |
| `packages/buyer-core/src/unit-billing.ts` | 2 |
| `packages/node/src/discovery/announcer.ts` | 1 |
| `packages/node/src/discovery/index.ts` | 1 |
| `packages/node/src/discovery/metadata-codec.ts` | 1 |
| `packages/node/src/discovery/metadata-validator.ts` | 1 |
| `packages/node/src/discovery/service-catalog.ts` | 1 |
| `packages/node/src/health/model-health-checker.ts` | 1 |
| `packages/node/src/index.ts` | 1 / 3 — export only available modules |
| `packages/node/src/interfaces/buyer-router.ts` | 1 / 2 / 3 — types / result attribution / selection behavior |
| `packages/node/src/interfaces/plugin.ts` | 3 |
| `packages/node/src/interfaces/seller-provider.ts` | 1 |
| `packages/node/src/node.ts` | 1 |
| `packages/node/src/payments/channel-store.reserve-fields.test.ts` | Excluded — obsolete recovery-column assertions; see PR 2 extraction |
| `packages/node/src/routing/conversation-identity.ts` | 3 |
| `packages/node/src/routing/model-route-ranking.ts` | 3 |
| `packages/node/src/routing/route-recommendation.ts` | 1 |
| `packages/node/src/routing/router-settings.ts` | 3 |
| `packages/node/src/routing/routing-context.ts` | 3 |
| `packages/node/src/routing/selection.ts` | 3 |
| `packages/node/src/routing/usage-observations.ts` | 3 |
| `packages/node/src/seller-request-handler.ts` | 2 / 3 — billing / structured request handling |
| `packages/node/src/types/peer.ts` | 1 |
| `packages/node/tests/announcer.test.ts` | 1 |
| `packages/node/tests/billing-runtime.test.ts` | 2 |
| `packages/node/tests/buyer-parallel-requests.test.ts` | 2 |
| `packages/node/tests/buyer-payment-manager.test.ts` | 2 |
| `packages/node/tests/buyer-payment-negotiator.test.ts` | 2 |
| `packages/node/tests/channel-store.test.ts` | 2 |
| `packages/node/tests/metadata-codec.test.ts` | 1 |
| `packages/node/tests/metadata-validator.test.ts` | 1 |
| `packages/node/tests/node-payment-mux-wiring.test.ts` | 2 |
| `packages/node/tests/payment-flow-integration.test.ts` | 2 |
| `packages/node/tests/per-call-billing.test.ts` | 2 |
| `packages/node/tests/proof-chain-integration.test.ts` | 2 |
| `packages/node/tests/released-channel-migration.test.ts` | 2 |
| `packages/node/tests/released-discovery-baseline.test.ts` | 1 |
| `packages/node/tests/route-recommendation.test.ts` | 1 |
| `packages/node/tests/router-settings.test.ts` | 3 |
| `packages/node/tests/routing-classification-validation.test.ts` | 2 |
| `packages/node/tests/routing-context.test.ts` | 3 |
| `packages/node/tests/routing-metadata.test.ts` | 1 |
| `packages/node/tests/routing-payment-recovery.test.ts` | 2 |
| `packages/node/tests/routing-selection.test.ts` | 3 |
| `packages/node/tests/seller-reserve-estimate.test.ts` | 2 / 3 — billing estimates here; structured routing dispatch/schema checks in 3 |
| `packages/node/tests/service-catalog.test.ts` | 1 |
| `packages/node/tests/usage-observations.test.ts` | 3 |
| `packages/protocol/src/billing.ts` | 1 / 2 — price representation / execution-side usage validation |
| `packages/protocol/src/index.ts` | 1 |
| `packages/protocol/src/peer-metadata.test.ts` | 1 |
| `packages/protocol/src/peer-metadata.ts` | 1 |
| `packages/protocol/src/routing.test.ts` | 1 |
| `packages/protocol/src/routing.ts` | 1 |
| `packages/protocol/src/service-api.ts` | 1 |
| `packages/provider-core/src/base-provider.ts` | 1 |
| `packages/provider-core/src/config-utils.test.ts` | 1 |
| `packages/provider-core/src/config-utils.ts` | 1 |
| `packages/router-core/src/index.ts` | 1 / 3 — parser export / adapter export |
| `packages/router-core/src/network-router.test.ts` | 1 / 3 — parser tests extracted / adapter tests deferred |
| `packages/router-core/src/network-router.ts` | 1 / 3 — parser extracted to routing-response.ts / invocation deferred |
| `packages/web-sdk/src/channel-store.test.ts` | 2 |
| `pnpm-lock.yaml` | 3 |
