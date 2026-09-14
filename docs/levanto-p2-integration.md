# Router integration: P2 implementation and handoff

Date: September 14, 2026. Branch: `codex/levanto-p1-local`.
Base: the P1 implementation ending at `aaa362d85`, on Levanto's
`model-routing-clean-v2` (`227046fdacc470c8d030534ab8e956a3b0272a73`).

This implements P2 locally. It does not introduce a competing router adapter,
change Levanto's private server, or push anything upstream. P1's host eligibility,
failure, and metered-routing protections remain in place.

## 1. Plugin-owned configuration, not a universal preference scale

**Why:** different routing algorithms expose different policies and thresholds.
AntSeed should render and validate those controls, not translate every algorithm
into one shared cost/quality number.

`AntseedRouterPlugin` now accepts `routingSettingsSchema`. The schema supports
string, number, and boolean fields, labels/descriptions, string-valued defaults,
enumerated options, and numeric min/max. Values remain strings, like existing
plugin configuration. Defaults describe the UI; the plugin must also implement
its own runtime defaults when a value is absent. This is not a secrets store.
Startup credentials/endpoints continue to use the existing `configSchema`.

Example metadata for an independently implemented classifier:

```ts
import type { AntseedRouterPlugin } from '@antseed/node';

export const routingMetadata = {
  autoRouteServiceId: 'classifier-auto',
  routingCadence: 'session',
  routingSettingsSchema: [
    {
      key: 'policy',
      label: 'Classification policy',
      type: 'string',
      default: 'balanced',
      options: ['balanced', 'low-latency'],
    },
    {
      key: 'confidenceThreshold',
      label: 'Minimum confidence',
      type: 'number',
      default: '0.7',
      min: 0,
      max: 1,
    },
  ],
} satisfies Pick<AntseedRouterPlugin,
  'autoRouteServiceId' | 'routingCadence' | 'routingSettingsSchema'>;
```

Configuration is namespaced under `buyer.routingPreferences.routerSettings`:

```json
{
  "buyer": {
    "routingPreferences": {
      "routerSettings": {
        "plugin:@example/router-classifier": { "policy": "low-latency" },
        "instance:research": { "policy": "balanced", "confidenceThreshold": "0.8" }
      }
    }
  }
}
```

Use `plugin:<exact CLI router argument>` or `instance:<configured instance name>`.
The desktop uses the selected package name. Package aliases are not automatically
merged into one namespace; match the invocation you use. The host validates the
active namespace before calling the plugin, forwards it as `context.settings`,
and removes the namespace map from the legacy preferences argument. Other
routers' settings are not forwarded through either path. This is API isolation,
not a security sandbox for installed JavaScript.

The desktop renders only the selected plugin's declared settings. There is no
universal Cost ↔ Quality control. Levanto declares its own `costQuality` control
with values `1,3,5,7,9`, plus its own two privacy controls. Its runtime precedence
is `context.settings.costQuality`, then legacy `routingPreferences.cqt`, then `5`.
Legacy CQT is retained for compatibility, not offered as a new cross-router API.

Implementation: `packages/node/src/routing/router-settings.ts`,
`packages/node/src/interfaces/plugin.ts`, `apps/cli/src/cli/commands/buyer/start.ts`,
and `apps/desktop/src/renderer/ui/components/chat/RouterSettings.tsx`.

## 2. Local cadence and structural request context

**Why:** invoking a plugin hook is not the same as paying for an upstream routing
decision. Tool-result continuations should not require another classifier call
when the selected router can safely reuse its last actual route.

`routingCadence` is plugin metadata:

| Cadence | Ordinary continuation | New user turn | Rewrite, refresh, unavailable route |
| --- | --- | --- | --- |
| `request` (default) | Classify | Classify | Classify |
| `turn` | Prefer reuse | Classify | Classify |
| `session` | Prefer reuse | Prefer reuse | Classify |

Every new session routes. Changes to the requested model or active plugin
settings also trigger routing. The host still calls `selectRoute` once for each
eligible request; `context.routing.shouldRoute` is a local gate the plugin can
honor before calling an expensive service. It is not a universal algorithm or
a guarantee that a plugin skipped its upstream call. Levanto declares `turn`.

The sixth argument exposes:

```ts
context.routing = {
  trigger: 'context-rewrite',
  shouldRoute: true,
  contextRewritten: true,
  cacheState: 'unknown',
  turnId: 'turn-17',
  previousRoute: { peerId: 'previous-peer-id', serviceId: 'advertised-service' },
};
```

Optional client headers are `x-antseed-turn-id`, `x-antseed-context-revision`,
and `x-antseed-route-refresh: true`. They supplement an existing conversation
identity; they do not create one. The host strips these headers before seller
dispatch. The test fixture uses `x-vpr-session-id` for its conversation identity.

Without explicit hints, the tracker hashes complete message prefixes and
system/instructions/tools, detects append versus rewrite, and counts genuine
user messages. It excludes tool-result-only Anthropic user messages. Appending
the same user text after an assistant response still counts as a new turn.
Unknown/unobservable history, including a Responses `previous_response_id`,
routes conservatively instead of pretending to know the hidden history.

**Compaction is not evidence of a cold cache.** The first rewritten request is
examined before forwarding. The plugin may choose the same route again; retained
prefixes may still be cached. There is no prediction of when a future turn will
happen, and no claim of matching any third-party adapter's internal behavior.

The host tracks the actual successfully dispatched peer/model, including host
failover, rather than just the router's first recommendation. It revalidates
eligibility on reuse and before dispatch. Required reclassification clears stored
reuse state until successful dispatch: a failed/cancelled rewrite cannot make
the next request silently reuse an obsolete route. Late older completions cannot
overwrite newer session state. State is bounded to 500 sessions with a 30-minute
idle TTL and stores hashes/route identifiers, not prompt text.

Example adapter implementation; inject the router's own classifier and mapping:

```ts
import type { Router, RouteSelectionContext, SerializedHttpRequest } from '@antseed/node';

type Candidate = NonNullable<RouteSelectionContext['candidates']>[number];
type Classify = (request: SerializedHttpRequest, candidates: Candidate[],
  policy: string, signal: AbortSignal) => Promise<string>;

export function createClassifierRouter(classify: Classify): Router {
  return {
    selectPeer: () => null,
    onResult: () => {},
    async selectRoute(request, _peers, _conversation, _preferences, _default, context) {
      if (JSON.parse(new TextDecoder().decode(request.body)).model !== 'classifier-auto') return null;
      if (!context) throw new Error('Host routing context required');
      context.signal.throwIfAborted();
      const candidates = context.candidates ?? [];
      const previous = context.routing?.previousRoute;
      if (context.routing?.shouldRoute === false && previous && candidates.some(
        (candidate) => candidate.peerId === previous.peerId && candidate.serviceId === previous.serviceId,
      )) return [previous];
      const model = await classify(request, candidates, context.settings?.policy ?? 'balanced', context.signal);
      context.signal.throwIfAborted();
      return candidates.filter((candidate) => candidate.serviceId === model)
        .map(({ peerId, serviceId }) => ({ peerId, serviceId }));
    },
  };
}
```

A model-only classifier maps its answer to exact advertised service IDs inside
its adapter. Unknown mappings return no eligible recommendation; they never
invent a seller or bypass policy. Recommendations need only `peerId/serviceId`,
not forecasts, synthetic prices, or rewritten requests. A router can use P1's
authorized `context.invokeService` for a metered network classifier, or implement
its own external API adapter. The latter owns its API credentials and disclosure.

Implementation: `packages/node/src/routing/routing-context.ts`,
`apps/cli/src/proxy/buyer-proxy.ts`, and `plugins/router-levanto/src/router.ts`.

## 3. Optional forecasts and honest savings

**Why:** choosing a model does not imply predicting its token usage or final
bill. Missing information must not become a zero-dollar observation.

Shared `RoutingDecisionRow` makes all four forecast fields and legacy `cqt`
optional/nullable. `actualUsdcPaid` accepts `null`. `costSource` distinguishes
`estimate` from `settled`; omission normalizes to `estimate` in SQLite. Optional
`routerMetadata` accepts scalar classification/confidence fields without making
them required across algorithms. It must not contain prompts or credentials.

An example forecast-free row:

```ts
import type { RoutingDecisionRow } from '@antseed/node';

const decision: RoutingDecisionRow = {
  atMs: Date.now(),
  actualModel: 'advertised-service',
  actualPeer: 'actual-peer-id',
  actualPromptTokens: 100,
  actualCachedTokens: 20,
  actualCompletionTokens: 10,
  actualUsdcPaid: null,
  costSource: 'estimate',
  routingLatencyMs: 42,
  conversationKey: 'session-id',
  baselinePrices: {},
  consideredCandidates: [],
  routerMetadata: { category: 'coding', confidence: 0.8 },
};
```

Do not label a usage-times-price calculation as settled. Signed payment records,
not dashboard estimates, determine actual settlement. Known zero remains zero;
unknown remains null. Cached-input rate `0` means free; `null` means unknown, not
a free cache. Both desktop and standalone savings calculations exclude unknown
costs and malformed usage/prices rather than manufacturing savings. The standalone
dashboard labels costs as observed/estimated and bounds totals to retained history.

Migration `002_optional_router_telemetry.ts` upgrades existing routing rows and
indexes; migration 001 is unchanged. Reused inference requests get their own
telemetry rows but no copied forecasts from the original request. Levanto's
private successful classifier response still requires its own `estimate` shape;
that private requirement no longer dictates the shared record contract.

## 4. Operational limits, privacy, and decision records

- P1's host deadline, explicit failure semantics, disconnect cancellation, and
  eligible fallback remain authoritative. A plugin ignoring cancellation cannot
  cause late inference dispatch; the host cannot undo already-issued signatures
  or force-stop arbitrary in-process JavaScript.
- The host routing-service helper limits input, output tokens, rate, and additional
  authorization; repeated calls for one request reuse one operation rather than
  purchasing twice. HTTP 429/503 responses do not trigger retries. Returned SDK
  routing bodies above 256 KiB are rejected before exposing them to the plugin.
  This is not a new transport-wide memory limit before SDK buffering.
- Levanto's direct HTTP response reader also enforces 256 KiB while streaming,
  with its deadline active through body completion, including stalled streams.
  Non-JSON rejection bodies preserve status semantics. Only a 402 can enter its
  separately consented day-pass purchase flow; 429/503 cannot buy a pass.
- Levanto still shares the trimmed latest user message with its routing peer to
  classify it. The plugin information dialog discloses this. Local prompt-preview
  retention and outbound daily usage digests now default off. Enable
  `retainPromptPreview` or `shareUsageDigest` in its plugin settings to opt in.
  Merely configuring a seller no longer enables digest sharing. Old saved previews
  are not retroactively erased. Disabling preview retention is not a deletion tool.
- `routing-operations.jsonl` records sanitized selection triggers, latency,
  outcome/error codes, reuse suggestions, actual successful model/peer dispatch,
  and separate metered routing operations. It does not log prompts, arbitrary
  plugin responses, or private exception messages. `reuseSuggested` is not a
  claim that the plugin definitely skipped classification.
- Audit appends are serialized, capped to 1 MiB plus one rotated backup, with
  0600 permissions and at most 1,000 queued writes. Oversized records/overload
  reject; a disk failure does not fail successful inference or poison later
  writes. Shutdown flushes queued writes. These are best-effort diagnostics, not
  the authoritative payment ledger.
- SQLite routing history retains the newest 5,000 rows, pruning at open/insert.
  This deletes old telemetry, not payment records. It is a row-retention limit,
  not a promise of a fixed SQLite file size or secure erasure of deleted pages.

P1 limitations remain: metered routing uses a dedicated routing seller separate
from inference. The authorization cap bounds additional signed SpendingAuth,
not reserve collateral. This P2 work does not redesign either constraint.

## 5. Vendor-neutral test matrix

| Contract | Tests / evidence |
| --- | --- |
| Plugin/instance settings isolation, malformed storage, unknown fields, bounds | SDK `tests/router-settings.test.ts`; CLI `config/loader.test.ts`, `proxy/buyer-proxy.test.ts` |
| Dynamic controls, no synthetic universal dial, persistence | Desktop `modules/routing/router-settings-ui.test.ts`, `preferences.test.ts` |
| Request/turn/session cadence, identical repeated user text, three tool-result formats | SDK `tests/routing-context.test.ts` |
| Rewrite, system/tools changes, explicit revision/refresh, missing history, expiry/isolation | SDK context tests; host integration in `proxy/buyer-proxy.test.ts` |
| Failed rewrite recovery, out-of-order completion, no stored prompts | SDK context regressions |
| Actual failover reuse and buyer policy changes | Host session integration; Levanto `router.test.ts` |
| Late success after timeout/disconnect never dispatches | Host integration; `proxy/router-execution.test.ts` |
| Forecast-free and partial records, unknown vs zero, migration/reopen/index preservation | SDK `tests/routing-decisions-store.test.ts` |
| No stale reuse forecasts, unknown measured costs | Levanto `router.test.ts`, `ledger.test.ts` |
| Free/unknown cache prices; missing costs do not create savings | Levanto router tests; SDK executable embedded-dashboard tests; desktop savings tests |
| Rotation, oversized old logs, overload, disk-error recovery, permissions | CLI `proxy/routing-log.test.ts` |
| Input/authorization/rate constraints, deduplication, separate IDs, cancellation, 429/503, oversized output | CLI `proxy/routing-service.test.ts` |
| Chunked Unicode, oversized/stalled/invalid bodies, abort, no erroneous pass purchase | Levanto `routing-response.test.ts`, `router.test.ts` |
| Prompt previews/digest opt-in, existing digest and ledger behavior | Levanto router, digest, ledger suites |
| Real metered classifier plus forecast-free minimal recommendations | `e2e/scripts/local-chain-routing-flow.mjs` |

The isolated Anvil fixture deploys real contracts and uses actual SDK/P2P payment
paths. First request classifies; the next user turn reuses; compaction reclassifies;
explicit refresh reclassifies. Assertions prove **3 classifier calls, 4 inference
calls, and 420 micro-USDC settled** for routing (3 × 100 input / 20 output tokens
at $1/$2 per million). Reuse leaves the initial 140-micro-USDC routing authorization
unchanged. It also checks unique routing IDs, separate parent inference IDs, and
prompt-free audit records. No production chain or real customer funds are used.

## 6. Reproduction and validation

Use Node 20, not the machine's default Node 26, for the installed native modules:

```sh
export PATH=/Users/alex/.volta/tools/image/node/20.17.0/bin:$PATH
pnpm run build
pnpm run typecheck
pnpm --filter @antseed/desktop typecheck:renderer
pnpm --filter @antseed/node test
pnpm --filter @antseed/buyer-core test
pnpm --filter @antseed/router-levanto test
pnpm --filter @antseed/e2e run flow:local-chain-routing
env -u ANTSEED_SYSTEM_PROXY_DATA_DIR -u FORCE_COLOR -u NO_COLOR pnpm --filter @antseed/desktop test
```

CLI suite, from `apps/cli` (Node 20's module flag is needed by existing wrapper
fixtures, not by the router implementation):

```sh
env -u FORCE_COLOR -u NO_COLOR \
  NODE_OPTIONS='--experimental-default-type=module --no-warnings' \
  node --test dist/config/*.test.js dist/cli/commands/**/*.test.js \
  dist/proxy/*.test.js dist/plugins/*.test.js dist/system-proxy/*.test.js dist/tunnel/*.test.js
```

Whole-workspace build, recursive typechecks, renderer typecheck, SDK, buyer-core,
Levanto, and the isolated-chain fixture pass. Desktop script/main tests pass.

| Suite | Result |
| --- | --- |
| Node SDK | 1,099 passed across 98 files |
| Buyer core | 11 passed |
| Levanto plugin | 106 passed across 5 files |
| CLI | 573 passed, 1 existing failure |
| Desktop scripts / main | 6 / 371 passed |
| Desktop renderer | 413 passed, 1 existing failure |
| Web SDK, isolated rerun | 25 passed, 1 existing failure |
| Isolated-chain routing fixture | Passed: 3 routing / 4 inference calls; 420 micro-USDC settled |

The full repository is **not entirely green**: the already documented CLI
conversation-affinity assertion, desktop distant-cooldown assertion, and web-SDK
ambiguous-top-up/deposit-verification test still fail. The recursive test run
stops at web-SDK; it also encountered a peer-connection setup failure there under
parallel execution, which passed on an isolated rerun. These unrelated failures
are not silently changed or skipped to claim a green full suite.

All changes are separate local commits. See `git log --oneline aaa362d85..HEAD`.
No push, upstream merge, private-server deployment, or competitor integration is
part of this handoff.

## Commit guide

| Commit | Logical change |
| --- | --- |
| `c9b0ccaa1` | Plugin-owned settings, namespaced persistence, dynamic desktop controls |
| `361019da7` | Optional shared forecasts, nullable observed costs, forward-only migration |
| `865ba6a97` | Structural context and plugin-selected routing cadence |
| `e3b046f93` | Failed/cancelled reclassification invalidates obsolete reuse state |
| `50378d6dc` | Bounded operational logs/history and explicit telemetry-sharing opt-in |
| `7a44a60ae` | Honest savings calculations and preservation of free cached-input rates |
| `2d000b980` | Response limits and deadlines through HTTP body consumption |
| `d1c666d2a` | Late-completion, queue-overload, and cached-price contract regressions |
| `5b1a54eba` | Retained-history labeling, not an unbounded all-time claim |
| `8a859bc6e` | Real local-chain cadence and cumulative routing-settlement fixture |
| `ae4d1e3be` | Namespace isolation also applies to the legacy preferences argument |

The final documentation commit contains this handoff and links it from P1.
