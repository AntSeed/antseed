# Dashboard RPC efficiency

The dashboard batches position records, position status, and pool configuration
through Multicall3. Its shared provider also coalesces identical in-flight
`eth_call`, `eth_getCode`, and `eth_getBalance` requests. Results and errors are
removed from the in-flight map when they complete; this is not a persistent cache.
The complete RPC parameters, including caller, block and overrides, distinguish
requests. Transaction submissions are never coalesced.
Wallet/context invalidation clears shared in-flight reads. Dashboard actions
also clear them before execution, after confirmed steps, and on completion or
failure, so a post-action refresh does not join a pre-action transport request.

## Reproducible call-count comparison

`packages/node/src/payments/evm/seller-pools-batching.test.ts` compares the previous
individual-getter flow with the batched flow against the same deterministic ABI
fixture. It verifies identical position records, status values and configuration.
The counts include deployment probes, use the default 80-read chunk size, and
assume open positions whose withdrawal changes are no longer pending.

| Positions | Individual getter flow | Batched flow | Fewer requests |
| --- | ---: | ---: | ---: |
| 0 (configuration only) | 7 | 2 | 71.4% |
| 20 | 87 | 6 | 93.1% |
| 100 | 407 | 10 | 97.5% |

For 20 positions, the original flow performs 20 record reads, 60 status reads,
and seven configuration reads. The new flow makes three aggregate calls and
three deployment probes. For 100 positions, records use two aggregate calls,
statuses use four, and configuration uses one, plus three probes.

These are mocked RPC request counts, not whole-dashboard or production latency
benchmarks. They exclude position enumeration, reward computation, overview,
pool-yield enrichment, startup endpoint probes, and endpoint failover. Batching
reduces network overhead but still executes the underlying getters. The benefit
to node computation is therefore not the same as the request-count reduction.

The provider regression tests show three overlapping identical transport-level
reads sharing one request while retaining each caller's response ID. Existing
ethers caching can already collapse short-lived duplicates; the additional
benefit depends on the timing and overlap of actual view requests.

## Failure behavior

- A failed Multicall deployment probe propagates its error; it does not trigger
  individual-call fallback. Only a successful empty-code response selects that
  fallback, whose concurrency is bounded.
- Aggregate failures split only for recognized gas or request/response size
  limits. Timeouts, throttling and other infrastructure failures propagate and
  stop further scheduling within that invocation. Calls already running may finish.
- An 80-read aggregate that persistently times out previously could split into
  159 attempts. It now makes one aggregate attempt before propagating the error,
  excluding deployment probes and any endpoint-level failover.
- Reverted or undecodable subcalls still yield missing values. Required position,
  status and configuration values throw instead of silently becoming zeros.
  A pending position's penalty is not required; its existing projected-penalty
  behavior is preserved.
- Claims, withdrawals, ownership checks, and reward formulas are unchanged.

## Validation

### Network snapshot

`GET /api/network` reads a coherent block-pinned snapshot. The main Network page
and modern Overview share its in-flight request and 20-second result cache;
wallet reads remain separate. Epoch boundaries and context invalidation expire
live results. Immutable gate timing/schedule constants are cached separately by
context and chain configuration. Mutable configuration is read at the snapshot
block, including next-epoch settings and gate budgets. Budgets come from the
reward contracts, not a reimplementation of their dynamic formulas.

The snapshot verifies controller/gate/pool/accounting connections and registry
activation. Missing reads stay unavailable. Overview hides an incomplete network
summary instead of substituting mixed indexed and live numbers. The page retains
the previous snapshot with a stale warning on refresh errors. Visible Network
pages refresh every 60 seconds, at the estimated epoch boundary, on visibility
restoration, and after action invalidation; the countdown itself makes no RPCs.

Measured on the local Anvil fork (block 51,304,816, without endpoint failures):

| Read | Transport requests |
| --- | ---: |
| Previous uncached emissions service, including stack discovery and legacy details | 35 `eth_call` requests |
| New cold network snapshot | 1 block read + 1 code probe + 2 Multicalls = 4 |
| New expired/invalidated snapshot with immutable metadata cached | 1 block read + 1 code probe + 1 Multicall = 3 |
| Shared snapshot cache hit | 0 |

These are network/emissions-read counts, not whole-dashboard totals. Wallet
reads, startup endpoint selection, retry/fallback requests, and expanded history
are outside the new snapshot counts. Multicall still executes each underlying
getter; providers without Multicall fall back to bounded individual calls.
Legacy emissions, verification, and usage history mount only when expanded.

Regression checks:

```sh
pnpm --dir apps/ants exec vitest run src/service/network.test.ts src/service/overview-reads.test.ts web/src/network-page.test.ts
```

### Antscan display migration

Positions and pools views share a 15-second cached Antscan GraphQL
snapshot for the connected wallet and current/previous epochs. A small response
fits in one HTTP request; each collection is paginated in groups of 100, with
only unfinished collections included in subsequent requests. This is additional
to the existing cached REST requests for the seller directory, volume history
and pool summary. Participation details are fetched only when opening a pool.

With a healthy, complete snapshot:

- Modern Overview instead uses the live network snapshot described above;
  its remaining wallet batch has seven subcalls in the integration fixture.
- Display position enumeration and record reads move to Antscan. The max-lock
  display flag also moves, reducing status getters for an open position from
  three to two. Locally tracked changes override indexed records with live reads.
- Historical pool principal, power, usage, settled emissions and APY inputs no
  longer generate RPC calls. Unsettled yield estimates use the indexed budget
  and weighted usage from the same completed epoch. The pool fixture makes only
  four subcalls: two wallet stake/power reads and two lock-configuration reads;
  registration checks are separately mocked in this fixture and remain live.
- Pool-directory statistics and wallet position grouping use the indexed snapshot;
  the Network page labels its separate live block snapshot explicitly.

These remove underlying contract execution, not just HTTP overhead. They do not
imply a whole-dashboard percentage improvement: exact reward previews still read
positions and reward algorithm inputs on chain. Wallet balances, wallet aggregate
totals, allowances/permissions, registration, withdrawal eligibility, penalty
quotes and all transaction paths remain live. The earlier batching benchmark
above measures a different scope and must not be added to these savings.

The snapshot must match the chain and current epoch, have a checkpoint no older
than 120 seconds, and contain valid complete rows. Old event timestamps alone
do not imply stale data. Pagination rejects duplicate records, missing/repeated
cursors, partial responses and checkpoint changes rather than publishing an
incomplete wallet. Under a moving checkpoint, a paginated read can conservatively
fall back; a later refresh retries. Actions invalidate the cached snapshot.

On unavailable/stale indexed snapshots, wallet records/status and pool-directory network totals
fall back to chain reads with source warnings. Historical yields remain unknown
(not zero), without a per-pool historical RPC fallback storm. With no configured
indexer, the existing chain-only mode remains available. Missing current pool
rows explicitly warn that summary statistics may lag.

### Commands

Use the repository's pinned Node.js version and install/build workspace dependencies.

```sh
pnpm --filter '@antseed/node^...' run build
pnpm --dir packages/node run build
pnpm --dir packages/node exec vitest run src/payments/evm/multicall.test.ts src/payments/evm/seller-pools-batching.test.ts
pnpm --dir apps/ants exec vitest run src/service/rpc-provider.test.ts src/service/positions.test.ts
pnpm --dir apps/ants exec vitest run src/service/display-snapshot.test.ts src/service/display-reads.test.ts
pnpm --dir apps/ants run typecheck
```

The regression tests also cover empty lists, ordering, duplicate IDs, pending and
closed positions, withdrawn and max-locked positions, required-read failures,
bounded fallback concurrency, block tags, gas-limit splitting, and fresh reads
after both successful and failed in-flight requests.
